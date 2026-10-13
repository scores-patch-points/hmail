import * as sdk from "matrix-js-sdk";
import type { MatrixClient, ICreateClientOpts } from "matrix-js-sdk";
import {
  ClientEvent,
  RoomEvent,
  RoomStateEvent,
  MatrixEventEvent,
} from "matrix-js-sdk";
import {
  clearVaultCache,
  handleSecretStorageKeyRequest,
  loadVault,
} from "@/lib/coded-vault";
import { clearDecodedCache } from "@/lib/coded-runtime";

// Stage 4 wires SAS UI; we just listen so cross-signing isn't dropped silently.
const VERIFICATION_REQUEST_EVENT = "crypto.verificationRequestReceived" as const;

const SESSION_KEY = "hmail:session";
const STORE_PREFIX = "hmail:matrix:";
const CRYPTO_STORE_NAME = "hmail-crypto";

// matrix-rust-sdk uses `cryptoDatabasePrefix` as a *prefix* and creates DBs
// named like `hmail-crypto::matrix-sdk-crypto`, not the bare prefix. Anything
// we want to wipe has to be matched by these prefixes, not exact names.
const HMAIL_DB_PREFIXES = [STORE_PREFIX, CRYPTO_STORE_NAME];

/**
 * Wipe every IndexedDB database the app owns (sync cache + Rust crypto
 * stores). The crypto SDK uses `cryptoDatabasePrefix` as a prefix, so the
 * actual DB names look like `hmail-crypto::matrix-sdk-crypto` — deleting the
 * bare prefix is a no-op. We enumerate via `indexedDB.databases()` (Chromium,
 * Safari 14+, Firefox 126+) and fall back to deleting the known names so a
 * rare environment without enumeration still wipes the most-common store.
 *
 * Returns once every delete has either resolved, blocked, or errored — we
 * don't want a half-wiped state to surface on the next bootstrap.
 */
async function wipeLocalStores(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const names = new Set<string>();
  try {
    const dbs = await (
      indexedDB as unknown as {
        databases?: () => Promise<{ name?: string }[]>;
      }
    ).databases?.();
    if (Array.isArray(dbs)) {
      for (const db of dbs) {
        if (
          typeof db.name === "string" &&
          HMAIL_DB_PREFIXES.some((p) => db.name!.startsWith(p))
        ) {
          names.add(db.name);
        }
      }
    }
  } catch {
    /* enumeration not supported — fall back to known names below */
  }
  // Belt-and-suspenders: include the canonical names we created directly, in
  // case enumeration silently dropped them or isn't available.
  names.add(`${STORE_PREFIX}sync`);
  names.add(CRYPTO_STORE_NAME);
  names.add(`${CRYPTO_STORE_NAME}::matrix-sdk-crypto`);
  names.add(`${CRYPTO_STORE_NAME}::matrix-sdk-crypto-meta`);

  await Promise.all(
    Array.from(names).map(
      (name) =>
        new Promise<void>((resolve) => {
          try {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          } catch {
            resolve();
          }
        }),
    ),
  );
}

export interface PersistedSession {
  access_token: string;
  user_id: string;
  device_id: string;
  home_server: string;
}

let _client: MatrixClient | null = null;
type SyncPhase = "logged_out" | "starting" | "prepared" | "syncing" | "error";
let _syncState: SyncPhase = "logged_out";
const _listeners = new Set<() => void>();

function notify() {
  for (const fn of _listeners) fn();
}

// Mirrors HMAIL_TAG in rooms.ts. Inlined to avoid a module-init cycle
// (rooms.ts imports `subscribe` from this file). If the canonical tag name
// ever changes, update both.
const HMAIL_TAG_VALUE = "social.hyphae.hmail";
const _autoJoiningRooms = new Set<string>();

/**
 * hmail is email-shaped: a message arriving from a sender should land in the
 * inbox without the recipient first having to "accept" anything. Matrix
 * exposes new conversations as `invite`-membership rooms that get filtered
 * out of every list until joined. We auto-join, then tag with HMAIL_TAG so
 * the room shows up in `useHmailConversations`.
 */
async function autoAcceptInvite(client: MatrixClient, roomId: string) {
  if (_autoJoiningRooms.has(roomId)) return;
  _autoJoiningRooms.add(roomId);
  try {
    await client.joinRoom(roomId);
    try {
      await client.setRoomTag(roomId, HMAIL_TAG_VALUE, {});
    } catch (err) {
      // Joining is the must-have; tagging is best-effort. The user can
      // still adopt the room from Manage Rooms if this lags.
      console.warn("[hmail] failed to tag accepted invite", roomId, err);
    }
  } catch (err) {
    console.warn("[hmail] auto-accept invite failed", roomId, err);
  } finally {
    _autoJoiningRooms.delete(roomId);
  }
}

function autoAcceptPendingInvites(client: MatrixClient) {
  for (const room of client.getRooms()) {
    if (room.getMyMembership() === "invite") {
      void autoAcceptInvite(client, room.roomId);
    }
  }
}

export function subscribe(cb: () => void): () => void {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

export function getClient(): MatrixClient | null {
  return _client;
}

export function getSyncPhase(): SyncPhase {
  return _syncState;
}

export function loadSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedSession;
  } catch {
    return null;
  }
}

function saveSession(session: PersistedSession) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

/**
 * Resolve a homeserver URL from an MXID like @alice:matrix.org via
 * .well-known/matrix/client. Falls back to https://<domain>.
 */
export async function resolveHomeserver(mxidOrDomain: string): Promise<string> {
  const domain = mxidOrDomain.includes(":")
    ? mxidOrDomain.split(":").slice(1).join(":")
    : mxidOrDomain;
  const wellKnownUrl = `https://${domain}/.well-known/matrix/client`;
  try {
    const res = await fetch(wellKnownUrl, { method: "GET" });
    if (res.ok) {
      const body = await res.json();
      const base = body?.["m.homeserver"]?.base_url;
      if (typeof base === "string" && base.length > 0) {
        return base.replace(/\/$/, "");
      }
    }
  } catch {
    /* fall through */
  }
  return `https://${domain}`;
}

function buildOpts(
  baseUrl: string,
  session?: PersistedSession,
): ICreateClientOpts {
  const opts: ICreateClientOpts = {
    baseUrl,
    timelineSupport: true,
    // Wire 4S unlock prompts to the modal that the UI registers at mount.
    // The SDK calls this when it needs to read the coded-message vault and
    // the recovery key isn't already cached.
    cryptoCallbacks: {
      getSecretStorageKey: handleSecretStorageKeyRequest,
    },
  };
  if (session) {
    opts.userId = session.user_id;
    opts.deviceId = session.device_id;
    opts.accessToken = session.access_token;
  }
  // IndexedDB-backed memory store for session data; the Rust crypto store
  // is initialized separately via initRustCrypto and uses its own IDB.
  if (typeof indexedDB !== "undefined") {
    const indexedDBStore = new sdk.IndexedDBStore({
      indexedDB,
      localStorage,
      dbName: `${STORE_PREFIX}sync`,
    });
    opts.store = indexedDBStore;
  }
  return opts;
}

function attachListeners(client: MatrixClient) {
  client.on(ClientEvent.Sync, (state) => {
    if (state === "PREPARED") {
      _syncState = "prepared";
      // Account data is available by now — try warming the coded-message
      // vault. If 4S isn't bootstrapped this returns the empty cache; if it
      // is, the secret-storage-key prompter will pop the unlock modal.
      void loadVault(client).catch((err) =>
        console.warn("[hmail] coded vault warm load failed", err),
      );
      // Sweep invites that were already pending at sync time. The
      // MyMembership listener catches live invites; this catches the
      // ones that landed before this client was running.
      void autoAcceptPendingInvites(client);
    } else if (state === "SYNCING") _syncState = "syncing";
    else if (state === "ERROR") _syncState = "error";
    notify();
  });

  client.on(RoomEvent.Timeline, () => notify());
  client.on(RoomEvent.Redaction, () => notify());
  client.on(RoomEvent.Receipt, () => notify());
  client.on(RoomEvent.MyMembership, (room, membership) => {
    notify();
    if (membership === "invite") {
      void autoAcceptInvite(client, room.roomId);
    }
  });
  client.on(RoomEvent.Tags, () => notify());
  client.on(RoomEvent.Name, () => notify());
  client.on(RoomStateEvent.Events, () => notify());
  client.on(ClientEvent.AccountData, () => notify());

  client.on(MatrixEventEvent.Decrypted, () => notify());

  // Verification handler — Stage 1 just logs; Stage 4 surfaces SAS UI.
  (client as unknown as {
    on: (ev: string, cb: (req: unknown) => void) => void;
  }).on(VERIFICATION_REQUEST_EVENT, (req) => {
    console.log("[hmail] verification request received", req);
  });
}

/**
 * The error matrix-rust-sdk throws when the persisted account in the crypto
 * store doesn't match (user_id, device_id) of the freshly-logged-in client.
 * The exact wording can drift between SDK versions, so we match loosely: the
 * substrings here have to come from a single error chain we can recover from
 * by wiping local stores and reopening.
 */
function isCryptoAccountMismatch(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String((err as { message?: unknown })?.message ?? "");
  return (
    /account in the store doesn't match/i.test(msg) ||
    /CryptoStoreError/i.test(msg) ||
    /MismatchedAccount/i.test(msg)
  );
}

async function bootstrapClient(
  baseUrl: string,
  session?: PersistedSession,
): Promise<MatrixClient> {
  if (_client) return _client;
  const opts = buildOpts(baseUrl, session);
  const client = sdk.createClient(opts);

  if (opts.store) {
    await (opts.store as { startup: () => Promise<void> }).startup();
  }

  // Rust crypto, IndexedDB-backed. This is the single most important call
  // in the whole app — wrong store and decryption silently fails. If the
  // persisted store is from a previous session (different device_id), the
  // SDK refuses to open it with "account in the store doesn't match the
  // account in the constructor". Wipe and retry once so a stale store from
  // a prior login doesn't hold the user hostage.
  if ("initRustCrypto" in client && typeof client.initRustCrypto === "function") {
    try {
      await client.initRustCrypto({
        useIndexedDB: true,
        cryptoDatabasePrefix: CRYPTO_STORE_NAME,
      });
    } catch (err) {
      if (!isCryptoAccountMismatch(err)) throw err;
      console.warn(
        "[hmail] crypto store mismatch from a previous session — wiping and retrying",
        err,
      );
      await wipeLocalStores();
      await client.initRustCrypto({
        useIndexedDB: true,
        cryptoDatabasePrefix: CRYPTO_STORE_NAME,
      });
    }
  }

  attachListeners(client);

  _syncState = "starting";
  notify();

  await client.startClient({
    initialSyncLimit: 10,
    lazyLoadMembers: true,
  });

  _client = client;
  return client;
}

export async function loginWithPassword(
  homeserverUrl: string,
  user: string,
  password: string,
): Promise<MatrixClient> {
  // Use a transient client just for the login call.
  const stub = sdk.createClient({ baseUrl: homeserverUrl });
  const identifier =
    user.startsWith("@")
      ? { type: "m.id.user", user: user.slice(1).split(":")[0] }
      : { type: "m.id.user", user };
  const res = await stub.loginRequest({
    type: "m.login.password",
    identifier,
    password,
    initial_device_display_name: "hmail (web)",
  });
  const session: PersistedSession = {
    access_token: res.access_token,
    user_id: res.user_id,
    device_id: res.device_id,
    home_server: homeserverUrl,
  };
  // The homeserver issued a fresh device_id. Any IndexedDB state from a
  // previous login carries a different device_id, and the Rust crypto store
  // refuses to open against a mismatched account. Wipe before bootstrap so
  // every fresh password login starts clean — sync cache and crypto state
  // are session-bound and not useful to keep across logins.
  await wipeLocalStores();
  saveSession(session);
  return bootstrapClient(homeserverUrl, session);
}

export async function hydrateFromSession(): Promise<MatrixClient | null> {
  const session = loadSession();
  if (!session) return null;
  return bootstrapClient(session.home_server, session);
}

/**
 * Change the operator account's password on the homeserver. The site password
 * is never stored, so changing it means changing the derived Matrix password
 * here too. UIA re-auths with the current password; the live session survives.
 */
export async function changeAccountPassword(
  username: string,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  const client = getClient();
  if (!client) throw new Error("Not signed in.");
  const base = client.getHomeserverUrl().replace(/\/$/, "");
  const token = client.getAccessToken();
  const res = await fetch(`${base}/_matrix/client/v3/account/password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      new_password: newPassword,
      logout_devices: false,
      auth: {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: username },
        password: oldPassword,
      },
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Password change failed (${res.status})`);
  }
}

export async function logout() {
  if (_client) {
    try {
      await _client.logout(true);
    } catch {
      /* swallow — we still want to clear local state */
    }
    _client.stopClient();
    _client = null;
  }
  clearSession();
  // Drop in-memory coded-message state so passphrases don't survive logout.
  // The 4S vault on the server is untouched — re-login will reload it.
  clearVaultCache();
  clearDecodedCache();
  _syncState = "logged_out";
  notify();
  // Wipe IndexedDB stores so a fresh login starts clean. The crypto SDK
  // names its DBs `<prefix>::matrix-sdk-crypto*`, not the bare prefix —
  // wipeLocalStores() enumerates and deletes the actual names.
  await wipeLocalStores();
}
