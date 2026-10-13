/**
 * gmail·sender transport — the Gmail API, directly.
 *
 * The browser holds a send-scoped OAuth token (gmail-oauth.ts) and calls
 * gmail.googleapis.com itself. No third party, no relay, no EmailJS. The
 * email is ciphertext (mail-crypto.ts); the per-recipient key rides the
 * Matrix DM channel (mail-keys.ts).
 */
import { getGmailSession, clearGmailSession } from "@/lib/gmail-oauth";
import { encryptSend } from "@/lib/mail-crypto";
import { deliverKeyToRecipient } from "@/lib/mail-keys";
import { utf8 } from "@/lib/crypto";
import type { Recipient } from "@/lib/account";

const GMAIL_SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export interface SendResult {
  ok: boolean;
  error?: string;
}

export function isSendingEnabled(): boolean {
  return getGmailSession() !== null;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A minimal RFC 2822 message carrying the ciphertext envelope. */
function buildRaw(to: string, subjectLine: string, bodyCiphertextB64: string): string {
  return [
    `To: ${to}`,
    `Subject: ${subjectLine}`,
    `Message-ID: <hmail.${Date.now().toString(16)}.${Math.random().toString(36).slice(2)}@hmail>`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    bodyCiphertextB64,
    ``,
  ].join("\r\n");
}

/** Send one ciphertext email through the Gmail API with the browser token. */
async function gmailSendRaw(raw: string): Promise<void> {
  const session = getGmailSession();
  if (!session) throw new Error("Connect Google first.");
  const res = await fetch(GMAIL_SEND, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: base64url(utf8(raw)) }),
  });
  if (res.status === 401) {
    clearGmailSession();
    throw new Error("Google session expired — reconnect.");
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(j.error?.message ?? `Gmail send failed (${res.status})`);
  }
}

export interface RecipientSendRow {
  email: string;
  ok: boolean;
  keyViaMatrix: boolean;
  error?: string;
}

export interface ListSendOutcome {
  total: number;
  ciphertextSent: boolean;
  keyed: number;
  rows: RecipientSendRow[];
}

/**
 * Send an encrypted newsletter to a list:
 *   1. encrypt subject/body under a fresh per-send key
 *   2. deliver the ciphertext email to every recipient via the Gmail API
 *   3. hand the key + manifest to each recipient who has an MXID, over E2EE DM
 * A recipient without an MXID gets ciphertext only — they must connect via
 * Matrix ("outside of google") to decrypt.
 */
export async function sendEncryptedList(opts: {
  from: string;
  recipients: Recipient[];
  subject: string;
  body: string;
}): Promise<ListSendOutcome> {
  const { manifest, subjectLine, bodyCiphertextB64 } = await encryptSend({
    from: opts.from,
    subject: opts.subject,
    body: opts.body,
  });

  const rcpts = opts.recipients.filter((r) => r.email.trim());
  const rows: RecipientSendRow[] = [];

  for (const r of rcpts) {
    const row: RecipientSendRow = {
      email: r.email,
      ok: false,
      keyViaMatrix: false,
    };
    try {
      await gmailSendRaw(buildRaw(r.email.trim(), subjectLine, bodyCiphertextB64));
      row.ok = true;
      if (r.mxid?.trim()) {
        try {
          await deliverKeyToRecipient(r.mxid.trim(), manifest);
          row.keyViaMatrix = true;
        } catch (err) {
          row.error = err instanceof Error ? err.message : String(err);
        }
      }
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    }
    rows.push(row);
  }

  return {
    total: rcpts.length,
    ciphertextSent: rows.some((r) => r.ok),
    keyed: rows.filter((r) => r.keyViaMatrix).length,
    rows,
  };
}