/**
 * Circles — the part shared with the browser extension (extension/crypto.js).
 *
 * A circle is a name plus a symmetric key. Whoever holds the key reads what
 * was sealed to it. This file has no Matrix or browser imports on purpose:
 * the shapes, the validation and the merge rule are the contract between the
 * hub and the extension, so they stay testable on their own.
 */

export interface Circle {
  /** 8 random bytes, base64url (11 chars). Public: it labels sealed tokens. */
  kid: string;
  name: string;
  /** 32 random bytes, base64url (43 chars). The secret. */
  key: string;
}

/** Matrix event type that carries a circle key to one member. */
export const CIRCLE_EVENT = "social.hyphae.circle.key";

const KID_RE = /^[A-Za-z0-9_-]{11}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const MXID_RE = /^@[^\s:@]+:[^\s:@]+$/;

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newCircle(name: string): Circle {
  const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
  return {
    kid: b64u(rand(8)),
    name: name.trim().slice(0, 60) || "circle",
    key: b64u(rand(32)),
  };
}

export function isCircle(v: unknown): v is Circle {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.kid === "string" && KID_RE.test(c.kid) &&
    typeof c.key === "string" && KEY_RE.test(c.key) &&
    typeof c.name === "string"
  );
}

export function isMxid(s: string): boolean {
  return MXID_RE.test(s.trim());
}

/**
 * Add incoming circles to what we hold. Never replaces a key we already
 * have: a circle id that arrives again with a different key is a conflict,
 * not an update, and is reported rather than applied.
 */
export function mergeCircles(
  have: Record<string, Circle>,
  incoming: unknown[],
): { merged: Record<string, Circle>; added: Circle[]; conflicts: string[] } {
  const merged = { ...have };
  const added: Circle[] = [];
  const conflicts: string[] = [];
  for (const c of incoming) {
    if (!isCircle(c)) continue;
    const prev = merged[c.kid];
    if (!prev) {
      const clean = { kid: c.kid, name: c.name.trim().slice(0, 60) || "circle", key: c.key };
      merged[c.kid] = clean;
      added.push(clean);
    } else if (prev.key !== c.key) {
      conflicts.push(c.kid);
    }
  }
  return { merged, added, conflicts };
}

export function circleEventContent(c: Circle): { v: 1; circle: Circle } {
  return { v: 1, circle: { kid: c.kid, name: c.name, key: c.key } };
}

export function circleFromEventContent(content: unknown): Circle | null {
  if (!content || typeof content !== "object") return null;
  const c = content as { v?: unknown; circle?: unknown };
  return c.v === 1 && isCircle(c.circle) ? c.circle : null;
}
