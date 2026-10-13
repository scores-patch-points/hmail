/**
 * gmail·sender secrets — the part never shown.
 *
 * From the operator's Gmail address + the shared site password we quietly
 * derive the Matrix account that IS the connection layer — the account that
 * delivers mail keys to recipients "outside of google":
 *
 *   username  = g<sha256(email) hex, 24 chars>
 *   password  = sha256("hmail/v1\n" + email + "\n" + sitePassword)
 *
 * Nothing else is stored: the OAuth token lives in sessionStorage (send-only),
 * and there is no app password or config secret to persist.
 */
import { sha256Hex } from "@/lib/crypto";

/** Deterministic Matrix username for the operator's hyphae account. */
export async function deriveUsername(email: string): Promise<string> {
  const hex = await sha256Hex(email.toLowerCase().trim());
  return "g" + hex.slice(0, 24);
}

/** Deterministic Matrix password: a hash of the email + site password. */
export async function deriveHyphaePassword(
  email: string,
  sitePassword: string,
): Promise<string> {
  return sha256Hex(`hmail/v1\n${email.trim().toLowerCase()}\n${sitePassword}`);
}