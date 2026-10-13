/**
 * gmail·sender account — under the hood, never shown.
 *
 * The app is a skin on Gmail: its DATA (config, lists, send history) lives in
 * the browser, never on Matrix. Matrix is only the connection + encryption
 * layer: the operator's hyphae account (derived from email + site password)
 * is what delivers mail keys to recipients "outside of google."
 */
import { changeAccountPassword, getClient, loginWithPassword, logout } from "@/lib/matrix";
import { MATRIX_HOMESERVER } from "@/lib/config";
import { deriveHyphaePassword, deriveUsername } from "@/lib/secrets";
import { sha256Hex } from "@/lib/crypto";

const LOCAL_CONFIG_KEY = "gmail-sender:config";
const LISTS_KEY = "gmail-sender:lists";

// ---------------------------------------------------------------------------
// Matrix connection (the operator's account — encryption + key delivery)
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
 * The one unlock. Derives the operator's hyphae account from email + site
 * password, provisions it if needed, and logs in. The Matrix session is the
 * channel that encrypts and connects — the data itself stays in the browser.
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
// Local config — browser only. The only thing stored is the Gmail address
// (public: it is the From line). The site password and OAuth token are never
// persisted here.
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

/** Forget the local config so the app starts over at the Connect Google setup. */
export function resetLocalConfig(): void {
  try {
    localStorage.removeItem(LOCAL_CONFIG_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Change the shared site password. Since it is never stored, this changes the
 * derived Matrix password on the homeserver (the only place it exists).
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

// ---------------------------------------------------------------------------
// Lists — browser only. A recipient is an email plus an optional Matrix MXID
// (their "outside of google" identity, where the decryption key is delivered).
// ---------------------------------------------------------------------------

export interface Recipient {
  email: string;
  name?: string;
  mxid?: string;
}

export interface MailList {
  id: string;
  name: string;
  members: Recipient[];
}

export async function getLists(): Promise<MailList[]> {
  try {
    const raw = localStorage.getItem(LISTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { v?: number; lists?: MailList[] };
    return Array.isArray(parsed.lists) ? parsed.lists : [];
  } catch {
    return [];
  }
}

export async function saveLists(lists: MailList[]): Promise<void> {
  localStorage.setItem(LISTS_KEY, JSON.stringify({ v: 1, lists }));
}

export async function newListId(): Promise<string> {
  const h = await sha256Hex(`${Date.now()}:${crypto.getRandomValues(new Uint32Array(1))[0]}`);
  return h.slice(0, 16);
}