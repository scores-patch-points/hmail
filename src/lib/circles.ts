/**
 * Circles over Matrix. The hub is where a person's Matrix session lives, so
 * this is where circle keys are sent and received:
 *
 *   - to give someone a circle: an end-to-end-encrypted DM carrying one custom
 *     event (CIRCLE_EVENT);
 *   - to receive: read that event type out of the DM rooms;
 *   - to hand them to the extension: window.postMessage to the bridge.
 *
 * The homeserver sees who messaged whom and when. It never sees a key.
 */
import { Preset } from "matrix-js-sdk";
import { getClient } from "@/lib/matrix";
import {
  CIRCLE_EVENT,
  circleEventContent,
  circleFromEventContent,
  isMxid,
  mergeCircles,
  type Circle,
} from "@/lib/circles-core";

const STORE_KEY = "hyphae:circles";

export function loadCircles(): Record<string, Circle> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Circle>) : {};
  } catch {
    return {};
  }
}

export function saveCircles(circles: Record<string, Circle>): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(circles));
}

/** Find the joined DM with `mxid`, or create an encrypted one. */
export async function ensureDmRoom(mxid: string): Promise<string> {
  const client = getClient();
  if (!client) throw new Error("Not signed in.");
  const existing = client
    .getRooms()
    .find((r) => r.getMyMembership() === "join" && r.guessDMUserId() === mxid);
  if (existing) return existing.roomId;
  const created = await client.createRoom({
    name: mxid,
    invite: [mxid],
    is_direct: true,
    preset: Preset.PrivateChat,
    initial_state: [
      {
        type: "m.room.encryption",
        state_key: "",
        content: { algorithm: "m.megolm.v1.aes-sha2" },
      },
    ],
  });
  return created.room_id;
}

/** Send one circle's key to one member over an E2EE DM. */
export async function shareCircle(mxid: string, circle: Circle): Promise<void> {
  const target = mxid.trim();
  if (!isMxid(target)) throw new Error("That doesn't look like a Matrix ID (@name:server).");
  const client = getClient();
  if (!client) throw new Error("Not signed in.");
  const roomId = await ensureDmRoom(target);
  await (client.sendEvent as (
    roomId: string,
    type: string,
    content: unknown,
  ) => Promise<unknown>)(roomId, CIRCLE_EVENT, circleEventContent(circle));
}

/** Circles other people have sent this account, read from the DM rooms. */
export async function collectIncoming(): Promise<Circle[]> {
  const client = getClient();
  if (!client) return [];
  const me = client.getUserId();
  const found: Circle[] = [];
  for (const room of client.getRooms()) {
    for (const ev of room.getLiveTimeline().getEvents()) {
      try {
        await client.decryptEventIfNeeded(ev);
      } catch {
        continue; // not decryptable on this device; nothing to read
      }
      if (ev.getType() !== CIRCLE_EVENT || ev.getSender() === me) continue;
      const c = circleFromEventContent(ev.getContent());
      if (c) found.push(c);
    }
  }
  return found;
}

/** Fold received circles into the local store. Returns what was new. */
export async function receiveCircles(): Promise<{ added: Circle[]; conflicts: string[] }> {
  const incoming = await collectIncoming();
  const { merged, added, conflicts } = mergeCircles(loadCircles(), incoming);
  if (added.length) saveCircles(merged);
  return { added, conflicts };
}

// --- the extension bridge -------------------------------------------------

export function pushToExtension(circles: Circle[]): void {
  window.postMessage({ source: "hyphae-app", type: "circles", circles }, window.location.origin);
}

export function pingExtension(): void {
  window.postMessage({ source: "hyphae-app", type: "ping" }, window.location.origin);
}

export interface ExtensionStatus {
  present: boolean;
  /** Circles the extension reported holding after the last push. */
  total?: number;
  added?: number;
}

/** Listen for the extension's hello/ack. Returns an unsubscribe. */
export function watchExtension(cb: (s: ExtensionStatus) => void): () => void {
  const onMsg = (ev: MessageEvent) => {
    if (ev.source !== window || ev.origin !== window.location.origin) return;
    const d = ev.data as { source?: string; type?: string; added?: number; total?: number } | null;
    if (!d || d.source !== "hyphae-ext") return;
    if (d.type === "hello") cb({ present: true });
    if (d.type === "ack") cb({ present: true, added: d.added, total: d.total });
  };
  window.addEventListener("message", onMsg);
  return () => window.removeEventListener("message", onMsg);
}
