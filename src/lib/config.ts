/**
 * hyphae configuration. Public client config only — the app keeps no server
 * of its own. The Matrix homeserver is the one piece of infrastructure, and it
 * is whichever the user points the hub at.
 */
const env = import.meta.env;

/**
 * The Matrix homeserver the hub signs in to by default. hyphae.social is the
 * default; anyone can build the hub with their own (VITE_MATRIX_HOMESERVER).
 */
export const MATRIX_HOMESERVER = (
  (env.VITE_MATRIX_HOMESERVER as string | undefined) ?? "https://hyphae.social"
).replace(/\/$/, "");

/** Who operates this deployment. Decided once by whoever deploys it. */
export const OWNER = (env.VITE_OWNER as string | undefined) ?? "hyphae";
