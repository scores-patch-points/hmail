/**
 * gmail·sender configuration. Public client config — the app keeps no server
 * of its own. Gmail sending uses Google Identity Services with the app's own
 * OAuth client ID, so the token stays in the browser and no third party is in
 * the path.
 */
const env = import.meta.env;

/**
 * The app's Google OAuth client ID (Web application). Public by design. It can
 * also be pasted in-app via the "Connect Google" wizard (stored locally), which
 * overrides this.
 */
export const GOOGLE_CLIENT_ID = (env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? "";

/** The Matrix homeserver that hosts the operator's key-delivery account. */
export const MATRIX_HOMESERVER = (
  (env.VITE_MATRIX_HOMESERVER as string | undefined) ?? "https://hyphae.social"
).replace(/\/$/, "");

/** Who operates this deployment. Decided once by whoever deploys it. */
export const OWNER = (env.VITE_OWNER as string | undefined) ?? "hyphae";

/** Deep links for the in-app "Connect Google" wizard (docs/google-oauth-setup.md). */
export const GOOGLE_LINKS = {
  enableApi: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  credentials: "https://console.cloud.google.com/apis/credentials",
  consent: "https://console.cloud.google.com/apis/credentials/consent",
} as const;