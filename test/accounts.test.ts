// Passkey accounts (winhost design "Accounts and login"), with a software passkey, so @simplewebauthn's
// verification runs for real: one-time registration links, sign-in, sessions, reset, throttling.
import { describe, expect, test } from "bun:test";
import {
  addUser, AuthError, finishLogin, finishRegistration, LoginThrottle, loginOptions, REGISTRATION_TTL_MS, registrationOptions,
  relyingParty, removeUser, resetUser, SESSION_TTL_MS, sessionUser,
} from "../src/accounts.ts";
import { openDb } from "../src/db.ts";
import { SoftPasskey } from "./helpers/passkey.ts";

const rp = relyingParty("https://agentry.example.test");

async function registered(name = "ertan") {
  const db = openDb(":memory:");
  const code = addUser(db, name, "owner");
  const key = await SoftPasskey.create();
  const session = await finishRegistration(db, rp, code, await key.register(await registrationOptions(db, rp, code), rp.origin), "iPhone");
  return { db, code, key, session };
}

async function signIn(db: ReturnType<typeof openDb>, key: SoftPasskey, origin = rp.origin) {
  const { options, challengeId } = await loginOptions(db, rp);
  return finishLogin(db, rp, challengeId, await key.login(options, origin), "Mac");
}

describe("registration", () => {
  test("a one-time link registers a passkey and starts a session", async () => {
    const { db, session } = await registered();
    expect(sessionUser(db, session)).toMatchObject({ name: "ertan", role: "owner" });
    expect(db.query("SELECT COUNT(*) AS n FROM credentials").get()).toEqual({ n: 1 });
  });

  test("the link works once", async () => {
    const { db, code } = await registered();
    await expect(registrationOptions(db, rp, code)).rejects.toThrow("invalid, used or expired");
  });

  test("an expired link is refused", async () => {
    const db = openDb(":memory:");
    const code = addUser(db, "ertan", "admin", 1_000);
    await expect(registrationOptions(db, rp, code, 1_000 + REGISTRATION_TTL_MS + 1)).rejects.toThrow("invalid, used or expired");
  });

  test("a passkey made for another site is refused", async () => {
    const db = openDb(":memory:");
    const code = addUser(db, "ertan", "admin");
    const key = await SoftPasskey.create();
    const options = await registrationOptions(db, rp, code);
    await expect(finishRegistration(db, rp, code, await key.register(options, "https://evil.example.test"), "x")).rejects.toThrow(AuthError);
  });

  test("bad user names and duplicates are refused", () => {
    const db = openDb(":memory:");
    expect(() => addUser(db, "a b", "admin")).toThrow("letters, digits");
    addUser(db, "ertan", "admin");
    expect(() => addUser(db, "ertan", "admin")).toThrow("already exists");
  });
});

describe("sign-in", () => {
  test("a registered passkey signs in; the session names the user", async () => {
    const { db, key } = await registered();
    const { token, user } = await signIn(db, key);
    expect(user).toMatchObject({ name: "ertan", role: "owner" });
    expect(sessionUser(db, token)?.name).toBe("ertan");
  });

  test("a replayed answer is refused: each challenge is single use", async () => {
    const { db, key } = await registered();
    const { options, challengeId } = await loginOptions(db, rp);
    const answer = await key.login(options, rp.origin);
    await finishLogin(db, rp, challengeId, answer, "Mac");
    await expect(finishLogin(db, rp, challengeId, answer, "Mac")).rejects.toThrow("expired");
  });

  test("an answer for another origin is refused", async () => {
    const { db, key } = await registered();
    await expect(signIn(db, key, "https://evil.example.test")).rejects.toThrow(AuthError);
  });

  test("a forged signature is refused", async () => {
    const { db, key } = await registered();
    const { options, challengeId } = await loginOptions(db, rp);
    const answer = await key.login(options, rp.origin);
    const sig = Buffer.from(answer.response.signature, "base64url");
    sig[sig.length - 1] ^= 0xff;
    answer.response.signature = sig.toString("base64url");
    await expect(finishLogin(db, rp, challengeId, answer, "Mac")).rejects.toThrow(AuthError);
  });

  test("an unknown passkey is refused", async () => {
    const { db } = await registered();
    await expect(signIn(db, await SoftPasskey.create())).rejects.toThrow("unknown passkey");
  });

  test("sessions expire after 30 days", async () => {
    const { db, session } = await registered();
    expect(sessionUser(db, session, Date.now() + SESSION_TTL_MS + 1)).toBeNull();
    expect(sessionUser(db, "not-a-session")).toBeNull();
    expect(sessionUser(db, undefined)).toBeNull();
  });
});

describe("reset (lost device)", () => {
  test("reset revokes passkeys and sessions; the new link registers a new passkey", async () => {
    const { db, key, session } = await registered();
    const code = resetUser(db, "ertan");
    expect(sessionUser(db, session)).toBeNull();
    await expect(signIn(db, key)).rejects.toThrow("unknown passkey");
    const fresh = await SoftPasskey.create();
    const s2 = await finishRegistration(db, rp, code, await fresh.register(await registrationOptions(db, rp, code), rp.origin), "new phone");
    expect(sessionUser(db, s2)?.name).toBe("ertan");
    expect((await signIn(db, fresh)).user.name).toBe("ertan");
  });

  test("an old unused link stops working after a reset", async () => {
    const db = openDb(":memory:");
    const first = addUser(db, "ertan", "admin");
    resetUser(db, "ertan");
    await expect(registrationOptions(db, rp, first)).rejects.toThrow("invalid, used or expired");
  });
});

describe("remove", () => {
  test("removing a user deletes their passkeys, sessions and links; the name can be used again", async () => {
    const { db, key, session } = await registered();
    addUser(db, "alice", "owner");
    const pending = addUser(db, "bob", "admin");
    removeUser(db, "ertan");
    removeUser(db, "bob");
    expect(sessionUser(db, session)).toBeNull();
    await expect(signIn(db, key)).rejects.toThrow("unknown passkey");
    await expect(registrationOptions(db, rp, pending)).rejects.toThrow("invalid, used or expired");
    for (const t of ["credentials", "sessions", "registrations"]) {
      expect(db.query(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id NOT IN (SELECT id FROM users)`).get()).toEqual({ n: 0 });
    }
    expect(db.query("SELECT name FROM users").all()).toEqual([{ name: "alice" }]);
    expect(() => addUser(db, "ertan", "admin")).not.toThrow();
  });

  test("the last owner and unknown users are refused", () => {
    const db = openDb(":memory:");
    addUser(db, "ertan", "owner");
    addUser(db, "bob", "admin");
    expect(() => removeUser(db, "ertan")).toThrow("last owner");
    expect(() => removeUser(db, "nobody")).toThrow("no user nobody");
    removeUser(db, "bob");
    addUser(db, "alice", "owner");
    removeUser(db, "ertan");
    expect(db.query("SELECT name FROM users").all()).toEqual([{ name: "alice" }]);
  });
});

describe("LoginThrottle", () => {
  test("blocks an address after max failures in the window, then lets it go", () => {
    const t = new LoginThrottle(3, 1000);
    for (let i = 0; i < 3; i++) t.failed("1.2.3.4", 100);
    expect(t.blocked("1.2.3.4", 200)).toBe(true);
    expect(t.blocked("5.6.7.8", 200)).toBe(false);
    expect(t.blocked("1.2.3.4", 1_200)).toBe(false);
  });
});
