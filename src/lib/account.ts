/**
 * hyphae account — under the hood, never shown.
 *
 * The hub signs in to a Matrix homeserver (hyphae.social by default, or the
 * one the deployment points at). The account is derived from an email address
 * and a password, so there is nothing to look up and nothing to recover from
 * a server: the homeserver holds only ciphertext and the derived credentials.
 * Circles, keys and (later) the activity ledger travel over that session.
 */
import { changeAccountPassword, getClient, loginWithPassword, logout } from "@/lib/matrix";
import { MATRIX_HOMESERVER } from "@/lib/config";
import { deriveHyphaePassword, deriveUsername } from "@/lib/secrets";

const LOCAL_CONFIG_KEY = "gmail-sender:config"; // key name kept so existing sign-ins keep working

// ---------------------------------------------------------------------------
// Matrix connection
// ---------------------------------------------------------------------------

async function registerHyphaeAccount(
  username: string,
  password: string,
): Promise<void> {
  const url = `${MATRIX_HOMESERVER}/_matrix/client/v3/register`;
  async function attempt(auth: unknown): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, auth }),
    });
  }
  let res = await attempt({ type: "m.login.dummy" });
  if (res.status === 401 || res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as {
      flows?: { type: string }[];
      errcode?: string;
    };
    const flows = body.flows ?? [];
    if (flows.some((f) => f.type === "m.login.terms")) {
      res = await attempt({ type: "m.login.terms" });
    } else if (flows.some((f) => f.type === "m.login.dummy")) {
      res = await attempt({ type: "m.login.dummy" });
    } else {
      throw new Error(
        `Registration not permitted on ${MATRIX_HOMESERVER}: ` +
          (body.errcode ?? JSON.stringify(body.flows ?? body)),
      );
    }
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { errcode?: string; error?: string };
    if (body.errcode === "M_USER_IN_USE") return; // already provisioned — login instead
    throw new Error(`Provisioning failed (${res.status}): ${body.error ?? body.errcode ?? ""}`);
  }
}

/**
 * The one unlock. Derives the Matrix account from email + password,
 * provisions it if needed, and logs in.
 */
export async function signIn(
  email: string,
  sitePassword: string,
): Promise<void> {
  const username = await deriveUsername(email);
  const password = await deriveHyphaePassword(email, sitePassword);
  try {
    await registerHyphaeAccount(username, password);
  } catch (err) {
    if ((err as { errcode?: string })?.errcode !== "M_USER_IN_USE") throw err;
  }
  await loginWithPassword(MATRIX_HOMESERVER, username, password);
}

export async function signOut(): Promise<void> {
  await logout();
}

export function isMatrixConnected(): boolean {
  return getClient() !== null;
}

// ---------------------------------------------------------------------------
// Local config — browser only. The only thing stored is the email address the
// account was derived from. The password is never persisted.
// ---------------------------------------------------------------------------

export interface ConfigRecord {
  v: 1;
  email: string;
}

export function hasLocalConfig(): boolean {
  try {
    return localStorage.getItem(LOCAL_CONFIG_KEY) !== null;
  } catch {
    return false;
  }
}

export function getLocalEmail(): string | null {
  try {
    const raw = localStorage.getItem(LOCAL_CONFIG_KEY);
    if (!raw) return null;
    return (JSON.parse(raw) as ConfigRecord).email ?? null;
  } catch {
    return null;
  }
}

export function saveConfig(email: string): void {
  const rec: ConfigRecord = { v: 1, email };
  localStorage.setItem(LOCAL_CONFIG_KEY, JSON.stringify(rec));
}

export function loadConfig(): { email: string } | null {
  try {
    const raw = localStorage.getItem(LOCAL_CONFIG_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as ConfigRecord;
    return rec.email ? { email: rec.email } : null;
  } catch {
    return null;
  }
}

/** Forget the local config so the app starts over at setup. */
export function resetLocalConfig(): void {
  try {
    localStorage.removeItem(LOCAL_CONFIG_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Change the password. Since it is never stored, this changes the derived
 * Matrix password on the homeserver (the only place it exists).
 */
export async function changeSitePassword(
  email: string,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  const username = await deriveUsername(email);
  const oldMatrixPassword = await deriveHyphaePassword(email, oldPassword);
  const newMatrixPassword = await deriveHyphaePassword(email, newPassword);
  await changeAccountPassword(username, oldMatrixPassword, newMatrixPassword);
}
