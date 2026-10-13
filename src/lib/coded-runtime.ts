/**
 * Per-event decode cache + auto-decode-with-cached-passphrase glue.
 *
 * The body resolution for a coded event happens here, not in `effectiveBody`.
 * `eventToMessage` calls `tryAutoDecode` as a fire-and-forget; if a cached
 * passphrase exists for this event's scope, decoding completes async and a
 * notify() re-renders with the cleartext. Otherwise the message stays locked
 * until the user enters the code in the modal (which calls `decodeWith`).
 */
import type { CodedPayload } from "./coded";
import { decodeMessage } from "./coded";
import {
  getCachedAlwaysCode,
  getCachedThreadCode,
  subscribeVault,
} from "./coded-vault";

const _decoded = new Map<string /* event_id */, string /* plaintext body */>();
const _inflight = new Set<string /* event_id */>();
const _listeners = new Set<() => void>();

function notify() {
  for (const fn of _listeners) fn();
}

export function subscribeDecoded(cb: () => void): () => void {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

export function getDecodedBody(eventId: string): string | undefined {
  return _decoded.get(eventId);
}

export function clearDecodedCache(): void {
  _decoded.clear();
  _inflight.clear();
  notify();
}

/**
 * Attempt to decode using whichever scope-keyed passphrase is already cached.
 * No-op if no cached code is available; the UI will surface a locked stub
 * until the user enters one. Side-effecting and intentionally not awaited
 * from render code — completion triggers a notify() so React re-renders.
 */
export function tryAutoDecode(
  eventId: string,
  payload: CodedPayload,
  senderMxid: string,
  roomId: string,
): void {
  if (_decoded.has(eventId) || _inflight.has(eventId)) return;
  let passphrase: string | undefined;
  if (payload.scope === "always") passphrase = getCachedAlwaysCode(senderMxid);
  else if (payload.scope === "thread") passphrase = getCachedThreadCode(roomId);
  // message-scope: never auto-decoded; user always enters per message.
  if (!passphrase) return;
  _inflight.add(eventId);
  void decodeMessage(payload, passphrase)
    .then((body) => {
      _decoded.set(eventId, body);
      _inflight.delete(eventId);
      notify();
    })
    .catch(() => {
      // Wrong cached code (rotated?) — leave locked, don't poison.
      _inflight.delete(eventId);
    });
}

/**
 * Decode with a user-supplied passphrase. Throws on bad code (AES-GCM auth
 * failure). On success, caches the cleartext so subsequent renders are cheap.
 */
export async function decodeWith(
  eventId: string,
  payload: CodedPayload,
  passphrase: string,
): Promise<string> {
  const body = await decodeMessage(payload, passphrase);
  _decoded.set(eventId, body);
  notify();
  return body;
}

// When a new code lands in the vault (user just entered one), the next render
// pass will try auto-decode again for any still-locked visible event.
subscribeVault(() => notify());
