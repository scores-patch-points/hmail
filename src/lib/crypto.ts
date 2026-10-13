/**
 * Shared AES-GCM primitives for the hmail ciphertext layer.
 *
 * Layering model (no plaintext ever touches Google or the homeserver):
 *
 *   plaintext  --AES-GCM(key)---------------------->  ciphertext blob
 *     stored in Gmail (mail bodies) or Drive (documents)
 *   key        --Megolm (Matrix E2EE)-------------->  shared room event
 *     the "outside channel": only room members ever see a key
 */

export const IV_BYTES = 12;
export const KEY_BYTES = 32;
/** Each ciphertext chunk is encrypted independently with its own IV. */
export const CHUNK_BYTES = 1 << 20; // 1 MiB

type AB = Uint8Array<ArrayBuffer>;

export function randomBytes(n: number): AB {
  const out = new Uint8Array(new ArrayBuffer(n));
  crypto.getRandomValues(out);
  return out;
}

export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view =
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
  let s = "";
  for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i]);
  return btoa(s);
}

export function base64ToBytes(b64: string): AB {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** base64url (RFC 4648 §5) — used for Google's PKCE challenge. */
export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function utf8(input: string): AB {
  const enc = new TextEncoder().encode(input);
  const out = new Uint8Array(new ArrayBuffer(enc.byteLength));
  out.set(enc);
  return out;
}

export function utf8FromBytes(bytes: ArrayBuffer | Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** SHA-256 hex digest of an arbitrary string or bytes. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? utf8(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Bytes(input: string | Uint8Array): Promise<AB> {
  const data = typeof input === "string" ? utf8(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(digest);
}

export async function newAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

export async function exportKeyB64(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bytesToBase64(raw);
}

export async function importKeyB64(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", base64ToBytes(b64), {
    name: "AES-GCM",
    length: 256,
  }, false, ["encrypt", "decrypt"]);
}

export interface EncPart {
  iv: string;
  ct: string;
}

/** Encrypt a small payload (subject line, message body). Returns IV + ciphertext. */
export async function encryptBytes(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad?: Uint8Array<ArrayBuffer>,
): Promise<EncPart> {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      key,
      plaintext as BufferSource,
    ),
  );
  return { iv: bytesToBase64(iv), ct: bytesToBase64(ct) };
}

/** Decrypt an EncPart. Throws on wrong key / tampering (GCM auth failure). */
export async function decryptBytes(
  key: CryptoKey,
  part: EncPart,
  aad?: Uint8Array<ArrayBuffer>,
): Promise<AB> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(part.iv), additionalData: aad },
    key,
    base64ToBytes(part.ct) as BufferSource,
  );
  return new Uint8Array(pt);
}

/**
 * A chunked ciphertext blob: one random IV per 1 MiB chunk, so arbitrarily
 * large documents are handled without a single monolithic buffer.
 */
export interface EncBlob {
  ivs: string[];
  chunks: string[];
}

export async function encryptBlob(
  key: CryptoKey,
  data: ArrayBuffer,
  aad?: Uint8Array<ArrayBuffer>,
): Promise<EncBlob> {
  const src = new Uint8Array(data);
  const ivs: string[] = [];
  const chunks: string[] = [];
  for (let off = 0; off < src.length; off += CHUNK_BYTES) {
    const slice = src.subarray(off, Math.min(off + CHUNK_BYTES, src.length));
    const part = await encryptBytes(key, slice, aad);
    ivs.push(part.iv);
    chunks.push(part.ct);
  }
  return { ivs, chunks };
}

export async function decryptBlob(
  key: CryptoKey,
  blob: EncBlob,
  aad?: Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
  if (blob.ivs.length !== blob.chunks.length) {
    throw new Error("corrupt ciphertext: iv/chunk count mismatch");
  }
  const out = new Uint8Array(
    new ArrayBuffer(blob.chunks.reduce((n, c) => n + atob(c).length, 0)),
  );
  let off = 0;
  for (let i = 0; i < blob.chunks.length; i++) {
    const pt = await decryptBytes(
      key,
      { iv: blob.ivs[i], ct: blob.chunks[i] },
      aad,
    );
    out.set(pt, off);
    off += pt.length;
  }
  return out.buffer as ArrayBuffer;
}

/** Flatten an EncBlob into a single opaque byte array (for Drive upload). */
export function blobToBytes(blob: EncBlob): ArrayBuffer {
  const parts = blob.chunks.map((c) => base64ToBytes(c));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out.buffer as ArrayBuffer;
}

/** Wrap a content key under an epoch/master key (AES-GCM, AAD = object id). */
export async function wrapKey(
  wrappingKey: CryptoKey,
  contentKey: CryptoKey,
  aadText: string,
): Promise<EncPart> {
  const raw = await crypto.subtle.exportKey("raw", contentKey);
  return encryptBytes(wrappingKey, new Uint8Array(raw), utf8(aadText));
}

/** Unwrap a wrapped content key. */
export async function unwrapKey(
  wrappingKey: CryptoKey,
  wrapped: EncPart,
  aadText: string,
): Promise<CryptoKey> {
  const raw = await decryptBytes(wrappingKey, wrapped, utf8(aadText));
  return crypto.subtle.importKey("raw", raw as BufferSource, {
    name: "AES-GCM",
    length: 256,
  }, false, ["encrypt", "decrypt"]);
}

/** Random short id used in mail subjects (`[hmail <id>]`) and Drive file names. */
export function shortId(bytes = 8): string {
  const b = randomBytes(bytes);
  let hex = "";
  for (const x of b) hex += x.toString(16).padStart(2, "0");
  return hex;
}