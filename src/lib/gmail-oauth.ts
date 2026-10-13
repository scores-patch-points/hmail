/**
 * Real Google OAuth via Google Identity Services (token model) — with an
 * in-app guided setup. The Client ID can come from the env (repo variables)
 * or be pasted in the app's "Connect Google" wizard; it is public either way.
 *
 * The token is issued to the browser and no third party ever holds it. Scope
 * is `gmail.send` only — the app can send as you, never read.
 */
import { GOOGLE_CLIENT_ID } from "@/lib/config";

const SCOPE = "openid email https://www.googleapis.com/auth/gmail.send";
const TOKEN_KEY = "gmail-sender:gmail-session";
const CLIENT_ID_KEY = "gmail-sender:google-client-id";
const GSI_SRC = "https://accounts.google.com/gsi/client";

/**
 * The client ID in use. A deployment that ships its own client ID (the
 * verified, hosted one) always wins; the in-app paste only applies to
 * self-hosted builds that have none baked in.
 */
export function getGmailClientId(): string {
  if (GOOGLE_CLIENT_ID) return GOOGLE_CLIENT_ID;
  try {
    return localStorage.getItem(CLIENT_ID_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

/** True when this build carries its own client ID, so users never see the setup wizard. */
export const IS_HOSTED = Boolean(GOOGLE_CLIENT_ID);

/** Plain-language error for the hosted flow, where there is nothing for the user to configure. */
export function hostedOauthHint(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/popup|closed|cancelled/i.test(msg)) return "The Google window was closed. Try Continue with Google again.";
  if (/access_denied|denied/i.test(msg)) {
    return "Google permission wasn't granted. hmail needs the send permission to deliver your messages.";
  }
  return msg || "Google sign-in failed. Try again.";
}

export function setGmailClientId(id: string): void {
  localStorage.setItem(CLIENT_ID_KEY, id.trim());
}

export function hasGmailClientId(): boolean {
  return Boolean(getGmailClientId());
}

interface GsiTokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void;
}
interface GsiOAuth2 {
  initTokenClient: (cfg: {
    client_id: string;
    scope: string;
    callback: (res: { access_token?: string; expires_in?: number; error?: string }) => void;
    error_callback?: (e: { type?: string; message?: string }) => void;
  }) => GsiTokenClient;
}

let _gsi: Promise<GsiOAuth2 | null> | null = null;
function loadGsi(): Promise<GsiOAuth2 | null> {
  if (!_gsi) {
    _gsi = new Promise((resolve) => {
      const w = window as unknown as { google?: { accounts?: { oauth2?: GsiOAuth2 } } };
      if (w.google?.accounts?.oauth2) {
        resolve(w.google.accounts.oauth2);
        return;
      }
      const s = document.createElement("script");
      s.src = GSI_SRC;
      s.async = true;
      s.onload = () => {
        const w2 = window as unknown as { google?: { accounts?: { oauth2?: GsiOAuth2 } } };
        resolve(w2.google?.accounts?.oauth2 ?? null);
      };
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  }
  return _gsi;
}

export interface GmailSession {
  token: string;
  email: string;
  expires_at: number;
}

export function getGmailSession(): GmailSession | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as GmailSession;
    if (!s.token || s.expires_at <= Date.now()) {
      sessionStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function clearGmailSession(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

/**
 * Map a Google OAuth failure to the tutorial step that fixes it.
 * Used by the in-app wizard so nobody has to guess what's wrong.
 */
export function oauthFixHint(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const low = msg.toLowerCase();
  if (/no registered origin|invalid_client|unauthorized origin|redirect_uri_mismatch/i.test(low)) {
    return "Step 2: add this app's URL to the client's Authorized JavaScript origins.";
  }
  if (/access blocked|scope|not authorized|insufficient/i.test(low)) {
    return "Step 3: add the gmail.send scope and your account as a test user.";
  }
  if (/client id|not configured/i.test(low)) {
    return "Paste your Client ID into the app first (Step 2/4).";
  }
  if (/popup|closed|cancelled/i.test(low)) return "The popup was closed — try Continue with Google again.";
  return msg;
}

/**
 * Open Google's real consent popup and resolve with a send-scoped session.
 * Google remembers the consent, so on later sessions it's a single click.
 */
export function connectGoogle(): Promise<GmailSession> {
  const clientId = getGmailClientId();
  if (!clientId) {
    return Promise.reject(new Error("Paste your Google Client ID into the app first."));
  }
  return loadGsi().then((oauth2) => {
    if (!oauth2) throw new Error("Couldn't load Google sign-in.");
    return new Promise<GmailSession>((resolve, reject) => {
      const client = oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: (res) => {
          if (!res.access_token) {
            reject(new Error(res.error ?? "Google sign-in returned no token."));
            return;
          }
          emailFromToken(res.access_token)
            .then((email) => {
              const session: GmailSession = {
                token: res.access_token as string,
                email,
                expires_at: Date.now() + (res.expires_in ?? 3600) * 1000,
              };
              sessionStorage.setItem(TOKEN_KEY, JSON.stringify(session));
              resolve(session);
            })
            .catch(reject);
        },
        error_callback: (e) =>
          reject(new Error(e?.message ?? e?.type ?? "Google sign-in failed.")),
      });
      client.requestAccessToken();
    });
  });
}

async function emailFromToken(token: string): Promise<string> {
  const r = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`,
  );
  const j = (await r.json()) as { email?: string };
  if (!j.email) throw new Error("Google didn't return an email address.");
  return j.email;
}