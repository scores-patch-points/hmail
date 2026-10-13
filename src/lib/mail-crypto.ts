/**
 * Per-send encryption for gmail·sender.
 *
 * Every send is AES-256-GCM under a fresh key:
 *   - subject + body are encrypted into the manifest
 *   - the email Gmail carries is ciphertext only (subject `[hmail <id>] …`,
 *     body base64) — a normal Gmail login sees nothing readable
 *   - the manifest (with the key) is delivered per-recipient over an E2EE
 *     Matrix DM — the "outside of google" channel that decrypts it
 */
import {
  encryptBytes,
  exportKeyB64,
  newAesKey,
  shortId,
  utf8,
  type EncPart,
} from "@/lib/crypto";

/** Matrix event type that carries the manifest + key to a recipient. */
export const KEY_EVENT_TYPE = "social.hyphae.mail.key";

export interface SendManifest {
  v: 1;
  id: string;
  from: string;
  sent_at: string;
  key_b64: string;
  subject: EncPart;
  body: EncPart;
}

export interface EncryptedSend {
  manifest: SendManifest;
  /** Gmail subject line: `[hmail <id>] iv:ct` — ciphertext only. */
  subjectLine: string;
  /** Gmail body: base64 AES ciphertext — nothing readable. */
  bodyCiphertextB64: string;
}

export async function encryptSend(opts: {
  from: string;
  subject: string;
  body: string;
}): Promise<EncryptedSend> {
  const key = await newAesKey();
  const id = shortId(4);
  const subjectEnc = await encryptBytes(key, utf8(opts.subject || "(no subject)"));
  const bodyEnc = await encryptBytes(key, utf8(opts.body || ""));
  const manifest: SendManifest = {
    v: 1,
    id,
    from: opts.from,
    sent_at: new Date().toISOString(),
    key_b64: await exportKeyB64(key),
    subject: subjectEnc,
    body: bodyEnc,
  };
  return {
    manifest,
    subjectLine: `[hmail ${id}] ${subjectEnc.iv}:${subjectEnc.ct}`,
    bodyCiphertextB64: bodyEnc.ct,
  };
}