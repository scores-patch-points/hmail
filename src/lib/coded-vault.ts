/**
 * Persistent storage for coded-message passphrases. Three layers:
 *
 *   1. In-memory cache (always)        — survives until reload/logout.
 *   2. Matrix Secret Storage / 4S      — encrypted-at-rest on the homeserver,
 *                                        keyed by the user's recovery key.
 *                                        This is the "permanent, cross-device"
 *                                        layer.
 *   3. UI (separate file)              — modal to enter / save / reveal codes.
 *
 * 4S is the canonical Matrix vault. Contents are AES-CTR'd with a key derived
 * from the user's recovery passphrase before they ever leave the device, so
 * the homeserver only ever sees ciphertext. This is the same storage other
 * Matrix clients use for cross-signing keys, and it's the answer to "the
 * stored unlock key has to be encrypted at rest too."
 *
 * Reading from 4S triggers a `getSecretStorageKey` callback (registered in
 * matrix.ts). If 4S isn't bootstrapped, persistent storage is unavailable and
 * codes live in memory only.
 */
import type { MatrixClient } from "matrix-js-sdk";
import type { CodeScope } from "./coded";

export const VAULT_SECRET_NAME = "io.hmail.coded.vault.v1";

/** The decrypted vault contents. Both maps are passphrase strings, not derived keys. */
export interface VaultData {
  /** Sender MXID → passphrase. One code per contact. */
  always: Record<string, string>;
  /** Room ID → passphrase. One code per thread. */
  thread: Record<string, string>;
}

function emptyVault(): VaultData {
  return { always: {}, thread: {} };
}

// ---------------------------------------------------------------------------
// Secret-storage-key prompter (registered by the UI)
// ---------------------------------------------------------------------------

/**
 * The matrix-js-sdk calls our `getSecretStorageKey` callback when it needs to
 * decrypt a 4S secret (e.g. our vault) and the key isn't already cached. We
 * defer that prompt to whatever React component is currently mounted to show
 * the modal — this registry is how that component installs itself.
 *
 * Returns `[keyId, keyBytes]` on success, or null if the user cancelled.
 */
export type SecretStorageKeyPrompter = (input: {
  keyId: string;
  keyName?: string;
  secretName: string;
}) => Promise<[string, Uint8Array<ArrayBuffer>] | null>;

let _prompter: SecretStorageKeyPrompter | null = null;

export function setSecretStoragePrompter(p: SecretStorageKeyPrompter | null) {
  _prompter = p;
}

/** Wired into matrix-js-sdk's `cryptoCallbacks.getSecretStorageKey`. */
export async function handleSecretStorageKeyRequest(
  opts: { keys: Record<string, { name?: string }> },
  secretName: string,
): Promise<[string, Uint8Array<ArrayBuffer>] | null> {
  if (!_prompter) return null;
  const entries = Object.entries(opts.keys);
  if (entries.length === 0) return null;
  const [keyId, info] = entries[0];
  return _prompter({ keyId, keyName: info?.name, secretName });
}

// ---------------------------------------------------------------------------
// In-memory cache (layer 1)
// ---------------------------------------------------------------------------

let _cache: VaultData = emptyVault();
let _loaded = false;
const _listeners = new Set<() => void>();

function notify() {
  for (const fn of _listeners) fn();
}

export function subscribeVault(cb: () => void): () => void {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

export function getCachedAlwaysCode(senderMxid: string): string | undefined {
  return _cache.always[senderMxid];
}

export function getCachedThreadCode(roomId: string): string | undefined {
  return _cache.thread[roomId];
}

/** Drop the in-memory cache. Called on logout so codes don't leak across sessions. */
export function clearVaultCache(): void {
  _cache = emptyVault();
  _loaded = false;
  notify();
}

// ---------------------------------------------------------------------------
// Matrix Secret Storage (layer 2)
// ---------------------------------------------------------------------------

/**
 * Subset of the matrix-js-sdk SecretStorage interface we actually call. Typed
 * inline because the SDK doesn't re-export the type cleanly across versions
 * and we'd rather depend on shape than identity.
 */
interface SecretStorageLike {
  isStored(name: string): Promise<Record<string, unknown> | null>;
  store(name: string, secret: string, keys?: string[] | null): Promise<void>;
  get(name: string): Promise<string | undefined>;
  getDefaultKeyId(): Promise<string | null>;
}

function secretStorageOf(client: MatrixClient): SecretStorageLike | null {
  const ss = (client as unknown as { secretStorage?: SecretStorageLike }).secretStorage;
  return ss ?? null;
}

/** True iff the user has bootstrapped 4S (a default key exists). */
export async function isVaultAvailable(client: MatrixClient): Promise<boolean> {
  const ss = secretStorageOf(client);
  if (!ss) return false;
  try {
    const id = await ss.getDefaultKeyId();
    return !!id;
  } catch {
    return false;
  }
}

/**
 * Read the vault from 4S into the in-memory cache. Idempotent — returns the
 * current cache on subsequent calls. May trigger the secret-storage-key
 * prompt registered in matrix.ts.
 */
export async function loadVault(client: MatrixClient): Promise<VaultData> {
  if (_loaded) return _cache;
  const ss = secretStorageOf(client);
  if (!ss) {
    _loaded = true;
    return _cache;
  }
  try {
    const stored = await ss.isStored(VAULT_SECRET_NAME);
    if (!stored) {
      _loaded = true;
      return _cache;
    }
    const raw = await ss.get(VAULT_SECRET_NAME);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<VaultData>;
      _cache = {
        always: { ...(parsed.always ?? {}) },
        thread: { ...(parsed.thread ?? {}) },
      };
    }
    _loaded = true;
    notify();
  } catch (err) {
    // A failed read leaves us with the empty cache and isn't fatal — the user
    // can still enter codes per-message; we just can't pre-fill known ones.
    console.warn("[hmail] coded vault load failed", err);
    _loaded = true;
  }
  return _cache;
}

async function saveVault(client: MatrixClient): Promise<void> {
  const ss = secretStorageOf(client);
  if (!ss) {
    throw new Error(
      "Secret storage unavailable — finish setting up secure storage first.",
    );
  }
  const defaultKey = await ss.getDefaultKeyId();
  if (!defaultKey) {
    throw new Error(
      "No secret-storage key set up — finish setting up secure storage first.",
    );
  }
  await ss.store(VAULT_SECRET_NAME, JSON.stringify(_cache));
}

// ---------------------------------------------------------------------------
// Public set/persist API
// ---------------------------------------------------------------------------

/**
 * Store a code in the in-memory cache only. Call this when the recipient
 * unlocks a message but doesn't want to keep the code across sessions.
 */
export function rememberCodeInMemory(
  scope: CodeScope,
  key: string,
  passphrase: string,
): void {
  if (scope === "always") _cache.always[key] = passphrase;
  else if (scope === "thread") _cache.thread[key] = passphrase;
  // message-scoped codes are never cached.
  notify();
}

/**
 * Persist a code to 4S (encrypted at rest on the server). Throws if the
 * vault isn't bootstrapped — the caller should fall back to in-memory or
 * prompt the user to set up secure storage.
 */
export async function persistCode(
  client: MatrixClient,
  scope: CodeScope,
  key: string,
  passphrase: string,
): Promise<void> {
  if (scope === "message") {
    throw new Error("per-message codes are not persisted by design");
  }
  rememberCodeInMemory(scope, key, passphrase);
  await saveVault(client);
}

/** Forget a single code (both in-memory and persisted). */
export async function forgetCode(
  client: MatrixClient,
  scope: CodeScope,
  key: string,
): Promise<void> {
  if (scope === "always") delete _cache.always[key];
  else if (scope === "thread") delete _cache.thread[key];
  notify();
  if (await isVaultAvailable(client)) {
    try {
      await saveVault(client);
    } catch (err) {
      console.warn("[hmail] coded vault save (forget) failed", err);
    }
  }
}
