/**
 * Matrix = the connection layer. The operator's hyphae session delivers the
 * per-send manifest (containing the AES key) to each recipient who has an
 * MXID, in an end-to-end-encrypted DM. No data is stored on Matrix — this is
 * a transient key handoff, nothing more. A recipient without an MXID gets
 * ciphertext only and cannot decrypt.
 */
import { Preset } from "matrix-js-sdk";
import { getClient } from "@/lib/matrix";
import { KEY_EVENT_TYPE, type SendManifest } from "@/lib/mail-crypto";

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

/**
 * Hand the key + manifest to one recipient over their E2EE DM. The room event
 * is Megolm-encrypted, so the key never exists in plaintext anywhere.
 */
export async function deliverKeyToRecipient(
  mxid: string,
  manifest: SendManifest,
): Promise<void> {
  const client = getClient();
  if (!client) throw new Error("Not signed in.");
  const roomId = await ensureDmRoom(mxid);
  await (client.sendEvent as (
    roomId: string,
    type: string,
    content: unknown,
  ) => Promise<unknown>)(roomId, KEY_EVENT_TYPE, { v: 1, manifest });
}