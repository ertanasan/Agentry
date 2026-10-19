// A software passkey for tests: what a phone's authenticator does, with a P-256 key in memory. It builds the
// same CBOR attestation ("none" format) and ECDSA assertions a real device sends, so the server's
// @simplewebauthn verification runs for real. Flags always claim user presence and user verification.
import { createHash, randomBytes } from "node:crypto";

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => new Uint8Array(createHash("sha256").update(b).digest());

// Minimal CBOR: unsigned/negative ints, byte and text strings, maps.
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;
function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function cbor(v: Cbor): number[] {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = new TextEncoder().encode(v); return [...head(3, b.length), ...b]; }
  if (v instanceof Uint8Array) return [...head(2, v.length), ...v];
  const out = head(5, v.size);
  for (const [k, val] of v) out.push(...cbor(k), ...cbor(val));
  return out;
}

const u32 = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];

// WebCrypto ECDSA signatures are r||s; WebAuthn wants ASN.1 DER.
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if (v[0] & 0x80) v = new Uint8Array([0, ...v]);
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.subarray(0, 32)), ...int(raw.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

export class SoftPasskey {
  readonly credentialId = new Uint8Array(randomBytes(16));
  private keys!: CryptoKeyPair;
  private userHandle = new Uint8Array();
  private count = 0;

  static async create(): Promise<SoftPasskey> {
    const p = new SoftPasskey();
    p.keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    return p;
  }

  get id(): string { return b64u(this.credentialId); }

  // Answers navigator.credentials.create() for these options (PublicKeyCredentialCreationOptionsJSON).
  async register(options: { challenge: string; rp: { id?: string }; user: { id: string } }, origin: string) {
    const rpId = options.rp.id ?? new URL(origin).hostname;
    this.userHandle = Buffer.from(options.user.id, "base64url");
    const jwk = await crypto.subtle.exportKey("jwk", this.keys.publicKey);
    const cose = new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]);
    const authData = new Uint8Array([
      ...sha256(rpId), 0x45, ...u32(this.count),
      ...new Uint8Array(16), this.credentialId.length >> 8, this.credentialId.length & 255, ...this.credentialId, ...cbor(cose),
    ]);
    const clientData = JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false });
    const attestation = new Uint8Array(cbor(new Map<string, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]])));
    return {
      id: this.id, rawId: this.id, type: "public-key" as const, clientExtensionResults: {}, authenticatorAttachment: "platform" as const,
      response: { clientDataJSON: b64u(new TextEncoder().encode(clientData)), attestationObject: b64u(attestation), transports: ["internal" as const] },
    };
  }

  // Answers navigator.credentials.get() for these options (PublicKeyCredentialRequestOptionsJSON).
  async login(options: { challenge: string; rpId?: string }, origin: string) {
    const rpId = options.rpId ?? new URL(origin).hostname;
    this.count++;
    const authData = new Uint8Array([...sha256(rpId), 0x05, ...u32(this.count)]);
    const clientData = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
    const signed = new Uint8Array([...authData, ...sha256(clientData)]);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed));
    return {
      id: this.id, rawId: this.id, type: "public-key" as const, clientExtensionResults: {}, authenticatorAttachment: "platform" as const,
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(derSignature(raw)), userHandle: b64u(this.userHandle) },
    };
  }
}
