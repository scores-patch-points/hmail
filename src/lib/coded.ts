/**
 * App-level "coded message" crypto: a passphrase-gated layer that lives
 * *inside* the Matrix-encrypted message content. The wire flow is:
 *
 *   plaintext body  --AES-GCM(passphrase-derived key)-->  CodedPayload
 *   CodedPayload    --megolm (Matrix E2EE)--------------> homeserver
 *
 * The server sees double-wrapped bytes; it can't even tell the inner blob
 * exists. A recipient's hmail client recognizes the inner shape, looks up the
 * passphrase by scope (always / thread / message), and decrypts.
 *
 * Three scopes pick *which key* unlocks the message; persistence (whether the
 * derived key is cached, and where) is orthogonal and handled by the vault
 * layer, not here.
 */
const ALG = "PBKDF2-SHA256+AES-GCM" as const;
const KDF_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

// WiFi-password vibe: 16 chars from an unambiguous alphabet (no 0/O/o/1/l/I),
// grouped into four blocks of four for human recall and dictation.
const CODE_ALPHABET =
  "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 16;
const CODE_GROUP = 4;

export const CODED_CONTENT_KEY = "io.hmail.coded";
export const CODED_BODY_FALLBACK =
  "🔒 Coded message — open in hmail to unlock";

export type CodeScope = "always" | "thread" | "message";

export interface CodedPayload {
  v: 1;
  scope: CodeScope;
  alg: typeof ALG;
  kdf: { salt_b64: string; iterations: number };
  iv_b64: string;
  /** AES-GCM ciphertext of the inner plaintext (utf-8). */
  ciphertext_b64: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// Explicit `Uint8Array<ArrayBuffer>` everywhere we touch crypto.subtle: the
// Web Crypto API expects a non-shared ArrayBuffer backing, and TS 5.7+
// distinguishes Uint8Array<ArrayBuffer> from Uint8Array<ArrayBufferLike>
// (which can also wrap a SharedArrayBuffer). Crypto.subtle rejects the
// latter at the type level.
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(n));
  crypto.getRandomValues(out);
  return out;
}

function utf8(input: string): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder().encode(input);
  // TextEncoder returns Uint8Array<ArrayBufferLike>; copy into a known-good
  // ArrayBuffer-backed view so we can hand it to crypto.subtle.
  const out = new Uint8Array(new ArrayBuffer(enc.byteLength));
  out.set(enc);
  return out;
}

/** Strip user-friendly separators so "abcd-efgh" and "abcdefgh" are equivalent. */
export function normalizeCode(input: string): string {
  return input.replace(/[\s-]+/g, "");
}

/** Group raw chars into four blocks of four for display: `abcd-efgh-ijkl-mnop`. */
export function formatCode(raw: string): string {
  const clean = normalizeCode(raw);
  const groups: string[] = [];
  for (let i = 0; i < clean.length; i += CODE_GROUP) {
    groups.push(clean.slice(i, i + CODE_GROUP));
  }
  return groups.join("-");
}

/**
 * Generate a fresh code with ~93 bits of entropy. Rejection-sample to keep the
 * distribution uniform — modulo bias matters when the alphabet length doesn't
 * divide 256 evenly (it doesn't: 256 % 56 != 0).
 */
export function generateCode(): string {
  const max = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  const out: string[] = [];
  while (out.length < CODE_LENGTH) {
    const buf = randomBytes(CODE_LENGTH * 2);
    for (let i = 0; i < buf.length && out.length < CODE_LENGTH; i++) {
      if (buf[i] < max) out.push(CODE_ALPHABET[buf[i] % CODE_ALPHABET.length]);
    }
  }
  return formatCode(out.join(""));
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    utf8(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a plaintext body for the wire. Caller picks the scope label. */
export async function encodeMessage(
  plaintextBody: string,
  passphrase: string,
  scope: CodeScope,
): Promise<CodedPayload> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(normalizeCode(passphrase), salt, KDF_ITERATIONS);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(plaintextBody)),
  );
  return {
    v: 1,
    scope,
    alg: ALG,
    kdf: { salt_b64: bytesToBase64(salt), iterations: KDF_ITERATIONS },
    iv_b64: bytesToBase64(iv),
    ciphertext_b64: bytesToBase64(ciphertext),
  };
}

/** Throws on bad passphrase / tampered ciphertext (AES-GCM auth failure). */
export async function decodeMessage(
  payload: CodedPayload,
  passphrase: string,
): Promise<string> {
  if (payload.alg !== ALG) {
    throw new Error(`unsupported coded alg: ${payload.alg}`);
  }
  const salt = base64ToBytes(payload.kdf.salt_b64);
  const iv = base64ToBytes(payload.iv_b64);
  const ciphertext = base64ToBytes(payload.ciphertext_b64);
  const key = await deriveKey(
    normalizeCode(passphrase),
    salt,
    payload.kdf.iterations,
  );
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export function isCodedPayload(x: unknown): x is CodedPayload {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  if (p.v !== 1) return false;
  if (typeof p.alg !== "string") return false;
  if (p.scope !== "always" && p.scope !== "thread" && p.scope !== "message") {
    return false;
  }
  if (typeof p.iv_b64 !== "string" || typeof p.ciphertext_b64 !== "string") {
    return false;
  }
  const kdf = p.kdf as Record<string, unknown> | undefined;
  if (!kdf || typeof kdf.salt_b64 !== "string" || typeof kdf.iterations !== "number") {
    return false;
  }
  return true;
}

/** Pull a CodedPayload out of a Matrix message content blob, if present. */
export function extractCodedPayload(
  content: Record<string, unknown> | undefined,
): CodedPayload | null {
  if (!content) return null;
  const raw = content[CODED_CONTENT_KEY];
  return isCodedPayload(raw) ? raw : null;
}
