// Accounts for the web UI: every app admin has one, and signs in with a passkey (WebAuthn: Face ID / Touch ID),
// no password (winhost design "Accounts and login"). Accounts are created on the server's machine with
// `agentry user add`, which prints a one-time registration link (30 minutes, single use) to open on the device
// that will hold the passkey. `agentry user reset` revokes a user's passkeys and sessions and prints a new link.
// `agentry user remove` deletes the account. Owners can do the same on the settings page.
// Settings changes need a passkey check within the last STEP_UP_TTL_MS on the session that makes them (step-up):
// sign-in and registration count as one, and `finishStepUp` makes one with a passkey of the signed-in user.
// Verification is @simplewebauthn/server's; user verification (biometric or device PIN) is required.
// Only hashes of registration codes, login challenge ids and session tokens are stored.
import type { Database } from "bun:sqlite";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { createHash, randomBytes } from "node:crypto";
import { logEvent } from "./db.ts";

export const REGISTRATION_TTL_MS = 30 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
export const STEP_UP_TTL_MS = 5 * 60_000;

export type Role = "owner" | "admin";
export type User = { id: number; name: string; role: Role; theme?: string | null };  // theme: views.ts THEMES; none: the default
// The relying party: the public origin the browser sees, e.g. https://agentry.example.com.
export type RelyingParty = { rpID: string; origin: string };

export class AuthError extends Error {}

export function relyingParty(publicUrl: string): RelyingParty {
  const u = new URL(publicUrl);
  return { rpID: u.hostname, origin: u.origin };
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");

export function addUser(db: Database, name: string, role: Role, now = Date.now()): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(name)) throw new AuthError("a user name is 1-32 letters, digits, '.', '_' or '-'");
  if (db.query("SELECT 1 FROM users WHERE name = ?").get(name)) throw new AuthError(`user ${name} already exists`);
  return db.transaction(() => {
    const id = Number(db.query("INSERT INTO users (name, role, webauthn_id, created_at) VALUES (?, ?, ?, ?)")
      .run(name, role, token(), now).lastInsertRowid);
    logEvent(db, null, "user_add", { name, role }, now);
    return issueRegistration(db, id, now);
  })();
}

// Revokes every passkey and session of the user and returns a new one-time registration code.
export function resetUser(db: Database, name: string, now = Date.now()): string {
  const user = db.query("SELECT id FROM users WHERE name = ?").get(name) as { id: number } | null;
  if (!user) throw new AuthError(`no user ${name}`);
  return db.transaction(() => {
    db.query("DELETE FROM credentials WHERE user_id = ?").run(user.id);
    db.query("UPDATE sessions SET revoked = 1 WHERE user_id = ?").run(user.id);
    db.query("UPDATE registrations SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(now, user.id);
    logEvent(db, null, "user_reset", { name }, now);
    return issueRegistration(db, user.id, now);
  })();
}

// Deletes the user with their passkeys, sessions and registration links; the name can then be used again. Events keep
// the name as their actor. The last owner stays, so the web UI always has someone who can sign in.
export function removeUser(db: Database, name: string, now = Date.now()): void {
  const user = db.query("SELECT id, role FROM users WHERE name = ?").get(name) as { id: number; role: Role } | null;
  if (!user) throw new AuthError(`no user ${name}`);
  const owners = (db.query("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled = 0").get() as { n: number }).n;
  if (user.role === "owner" && owners <= 1) throw new AuthError(`${name} is the last owner; add another with \`agentry user add <name>\` first`);
  db.transaction(() => {
    for (const table of ["credentials", "sessions", "registrations"]) db.query(`DELETE FROM ${table} WHERE user_id = ?`).run(user.id);
    db.query("DELETE FROM users WHERE id = ?").run(user.id);
    logEvent(db, null, "user_remove", { name }, now);
  })();
}

// A new one-time registration code for one more passkey of the user (another device); keeps their passkeys and sessions.
export function passkeyLink(db: Database, name: string, now = Date.now()): string {
  const user = db.query("SELECT id FROM users WHERE name = ?").get(name) as { id: number } | null;
  if (!user) throw new AuthError(`no user ${name}`);
  return issueRegistration(db, user.id, now);
}

function issueRegistration(db: Database, userId: number, now: number): string {
  const code = token();
  db.query("INSERT INTO registrations (code_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hash(code), userId, now + REGISTRATION_TTL_MS);
  return code;
}

type Registration = { code_hash: string; user_id: number; name: string; webauthn_id: string };

function openRegistration(db: Database, code: string, now: number): Registration {
  const reg = db.query(`SELECT g.code_hash, g.user_id, u.name, u.webauthn_id FROM registrations g JOIN users u ON u.id = g.user_id
    WHERE g.code_hash = ? AND g.used_at IS NULL AND g.expires_at > ? AND u.disabled = 0`).get(hash(code), now) as Registration | null;
  if (!reg) throw new AuthError("this registration link is invalid, used or expired; ask for a new one");
  return reg;
}

export function registrationUser(db: Database, code: string, now = Date.now()): string {
  return openRegistration(db, code, now).name;
}

export async function registrationOptions(db: Database, rp: RelyingParty, code: string, now = Date.now()) {
  const reg = openRegistration(db, code, now);
  const existing = db.query("SELECT id, transports FROM credentials WHERE user_id = ?").all(reg.user_id) as { id: string; transports: string | null }[];
  const options = await generateRegistrationOptions({
    rpName: "Agentry", rpID: rp.rpID, userName: reg.name, userID: new TextEncoder().encode(reg.webauthn_id),
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
  });
  db.query("UPDATE registrations SET challenge = ? WHERE code_hash = ?").run(options.challenge, reg.code_hash);
  return options;
}

// Verifies the new passkey, stores it, uses up the link and starts a session. Returns the session token.
export async function finishRegistration(db: Database, rp: RelyingParty, code: string, response: RegistrationResponseJSON, device: string, now = Date.now()): Promise<string> {
  const reg = openRegistration(db, code, now);
  const row = db.query("SELECT challenge FROM registrations WHERE code_hash = ?").get(reg.code_hash) as { challenge: string | null };
  if (!row.challenge) throw new AuthError("start the registration again");
  const result = await verifyRegistrationResponse({
    response, expectedChallenge: row.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true,
  }).catch((e) => { throw new AuthError(`passkey not accepted: ${e instanceof Error ? e.message : e}`); });
  if (!result.verified) throw new AuthError("passkey not accepted");
  const c = result.registrationInfo.credential;
  return db.transaction(() => {
    const used = db.query("UPDATE registrations SET used_at = ? WHERE code_hash = ? AND used_at IS NULL").run(now, reg.code_hash);
    if (used.changes !== 1) throw new AuthError("this registration link was already used");
    db.query("INSERT INTO credentials (id, user_id, public_key, counter, transports, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(c.id, reg.user_id, c.publicKey, c.counter, c.transports ? JSON.stringify(c.transports) : null, device, now);
    logEvent(db, null, "passkey_add", { user: reg.name, device }, now);
    return startSession(db, reg.user_id, device, now);
  })();
}

// Options for a discoverable-credential sign-in, plus the id the browser returns with its answer.
export async function loginOptions(db: Database, rp: RelyingParty, now = Date.now()) {
  return challenge(db, await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required" }), now);
}

// Options for a step-up: only the signed-in user's own passkeys are offered.
export async function stepUpOptions(db: Database, rp: RelyingParty, userId: number, now = Date.now()) {
  const creds = db.query("SELECT id, transports FROM credentials WHERE user_id = ?").all(userId) as { id: string; transports: string | null }[];
  return challenge(db, await generateAuthenticationOptions({
    rpID: rp.rpID, userVerification: "required",
    allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
  }), now);
}

function challenge<T extends { challenge: string }>(db: Database, options: T, now: number): { options: T; challengeId: string } {
  const challengeId = token();
  db.query("DELETE FROM challenges WHERE expires_at <= ?").run(now);
  db.query("INSERT INTO challenges (id_hash, challenge, expires_at) VALUES (?, ?, ?)").run(hash(challengeId), options.challenge, now + CHALLENGE_TTL_MS);
  return { options, challengeId };
}

type Cred = { id: string; public_key: Uint8Array; counter: number; transports: string | null; user_id: number; name: string; role: Role };

// Checks a passkey's answer to the challenge `challengeId` and records its use. Returns the passkey with its user.
async function verifyAssertion(db: Database, rp: RelyingParty, challengeId: string, response: AuthenticationResponseJSON, now: number): Promise<Cred> {
  const ch = db.query("DELETE FROM challenges WHERE id_hash = ? AND expires_at > ? RETURNING challenge").get(hash(challengeId), now) as { challenge: string } | null;
  if (!ch) throw new AuthError("sign-in expired; try again");
  const cred = db.query(`SELECT c.id, c.public_key, c.counter, c.transports, u.id AS user_id, u.name, u.role FROM credentials c
    JOIN users u ON u.id = c.user_id WHERE c.id = ? AND u.disabled = 0`).get(response.id) as Cred | null;
  if (!cred) {
    throw new AuthError("this site doesn't have the passkey this device offered (unknown passkey), probably one a reset removed: "
      + "choose another passkey, or get a new link with `agentry user passkey <name>` on the server");
  }
  const result = await verifyAuthenticationResponse({
    response, expectedChallenge: ch.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true,
    credential: { id: cred.id, publicKey: new Uint8Array(cred.public_key), counter: cred.counter, transports: cred.transports ? JSON.parse(cred.transports) : undefined },
  }).catch((e) => { throw new AuthError(`sign-in not accepted: ${e instanceof Error ? e.message : e}`); });
  if (!result.verified) throw new AuthError("sign-in not accepted");
  db.query("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?").run(result.authenticationInfo.newCounter, now, cred.id);
  return cred;
}

export async function finishLogin(db: Database, rp: RelyingParty, challengeId: string, response: AuthenticationResponseJSON, device: string, now = Date.now()): Promise<{ token: string; user: User }> {
  const cred = await verifyAssertion(db, rp, challengeId, response, now);
  return db.transaction(() => {
    logEvent(db, null, "login", { user: cred.name, device }, now);
    return { token: startSession(db, cred.user_id, device, now), user: { id: cred.user_id, name: cred.name, role: cred.role } };
  })();
}

// A step-up on the session `sessionToken`: the answer must come from a passkey of the session's own user.
export async function finishStepUp(db: Database, rp: RelyingParty, sessionToken: string, challengeId: string, response: AuthenticationResponseJSON, now = Date.now()): Promise<void> {
  const user = sessionUser(db, sessionToken, now);
  if (!user) throw new AuthError("sign in first");
  const cred = await verifyAssertion(db, rp, challengeId, response, now);
  if (cred.user_id !== user.id) throw new AuthError(`that passkey belongs to ${cred.name}, not ${user.name}`);
  db.query("UPDATE sessions SET verified_at = ? WHERE token_hash = ?").run(now, hash(sessionToken));
  logEvent(db, null, "step_up", { user: user.name }, now);
}

// True when the session's passkey was checked within STEP_UP_TTL_MS.
export function recentlyVerified(db: Database, sessionToken: string | undefined, now = Date.now()): boolean {
  if (!sessionToken) return false;
  const row = db.query("SELECT verified_at FROM sessions WHERE token_hash = ? AND revoked = 0").get(hash(sessionToken)) as { verified_at: number | null } | null;
  return !!row?.verified_at && row.verified_at > now - STEP_UP_TTL_MS;
}

function startSession(db: Database, userId: number, device: string, now: number): string {
  const t = token();
  db.query("INSERT INTO sessions (token_hash, user_id, device, created_at, expires_at, verified_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(hash(t), userId, device.slice(0, 200), now, now + SESSION_TTL_MS, now);
  return t;
}

export function sessionUser(db: Database, sessionToken: string | undefined, now = Date.now()): User | null {
  if (!sessionToken) return null;
  return db.query(`SELECT u.id, u.name, u.role, u.theme FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked = 0 AND s.expires_at > ? AND u.disabled = 0`).get(hash(sessionToken), now) as User | null;
}

// A user's own theme; null is the default (views.ts DEFAULT_THEME), which so stays everyone's until they pick another.
export function setTheme(db: Database, userId: number, theme: string | null): void {
  db.query("UPDATE users SET theme = ? WHERE id = ?").run(theme, userId);
}

export function endSession(db: Database, sessionToken: string): void {
  db.query("UPDATE sessions SET revoked = 1 WHERE token_hash = ?").run(hash(sessionToken));
}

// Failed sign-ins per client address: at most `max` in `windowMs`, kept in memory (a restart forgets them,
// which is fine for limits measured in minutes).
export class LoginThrottle {
  private failures = new Map<string, number[]>();
  constructor(private max = 10, private windowMs = 15 * 60_000) {}
  blocked(key: string, now = Date.now()): boolean {
    const recent = (this.failures.get(key) ?? []).filter((t) => t > now - this.windowMs);
    this.failures.set(key, recent);
    return recent.length >= this.max;
  }
  failed(key: string, now = Date.now()): void {
    this.failures.set(key, [...(this.failures.get(key) ?? []), now]);
  }
}
