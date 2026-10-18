import { describe, expect, test } from "bun:test";
import { openDb, acquireLease, renewLease, releaseLease, fenced, LeaseLost, runnerRow, LEASE_TTL_MS } from "../src/db.ts";

const mem = () => openDb(":memory:");

describe("runner lease", () => {
  test("a second runner cannot take a live lease", () => {
    const db = mem();
    expect(acquireLease(db, "a", 1, 1000)).toBe(true);
    expect(acquireLease(db, "b", 2, 1000 + LEASE_TTL_MS - 1)).toBe(false);
  });

  test("an expired lease can be taken over", () => {
    const db = mem();
    acquireLease(db, "a", 1, 1000);
    expect(acquireLease(db, "b", 2, 1000 + LEASE_TTL_MS + 1)).toBe(true);
    expect(runnerRow(db).owner_token).toBe("b");
  });

  test("renewing keeps a lease alive past its first TTL", () => {
    const db = mem();
    acquireLease(db, "a", 1, 0);
    renewLease(db, "a", null, LEASE_TTL_MS - 1);
    expect(acquireLease(db, "b", 2, LEASE_TTL_MS + 1)).toBe(false);
  });

  test("a stale runner's write is rejected after takeover (D17)", () => {
    const db = mem();
    acquireLease(db, "a", 1, 0);
    acquireLease(db, "b", 2, LEASE_TTL_MS + 1);
    expect(() => fenced(db, "a", () => db.exec("UPDATE runner SET paused = 1"))).toThrow(LeaseLost);
    expect(runnerRow(db).paused).toBe(0);
    expect(() => renewLease(db, "a", null)).toThrow(LeaseLost);
  });

  test("release frees the lease only for its owner", () => {
    const db = mem();
    acquireLease(db, "a", 1, 0);
    releaseLease(db, "b");
    expect(runnerRow(db).owner_token).toBe("a");
    releaseLease(db, "a");
    expect(acquireLease(db, "b", 2, 1)).toBe(true);
  });
});
