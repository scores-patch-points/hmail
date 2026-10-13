/*
 * SPAKE2 over P-256, with key confirmation — a short spoken code turned into a
 * strong shared key over a channel the adversary can read and rewrite.
 *
 *   A (inviter):  x random, X = x*G + w*M          sends X
 *   B (joiner):   y random, Y = y*G + w*N          sends Y
 *   A: K = x * (Y - w*N)        B: K = y * (X - w*M)
 *
 * w is derived from the code (stretched with PBKDF2, bound to the invite's
 * context). M and N are nothing-up-my-sleeve points (p256.hashToPoint of a
 * fixed label), so nobody knows their discrete log.
 *
 * What it buys: an eavesdropper (Google, the mailbox, a scanner) who sees X and
 * Y learns nothing it can test a code guess against — there is no offline
 * verifier. An active attacker gets exactly ONE guess per session, and learns
 * only whether that one guess was right. The inviter side counts failures and
 * kills the invite after a few, so the code only has to survive that many
 * guesses, not a dictionary.
 *
 * The roles are asymmetric (M for A, N for B), so a message reflected back at
 * its sender does not validate.
 *
 * NOT audited. It is the textbook SPAKE2 (Abdalla–Pointcheval) shape of RFC
 * 9382, but with its own M/N and a smaller key schedule, and its point
 * arithmetic is variable-time BigInt. Use a reviewed library before this
 * protects anything that matters (VERDICT.md says so too).
 */
(function (root, factory) {
  var wc = (root.crypto && root.crypto.subtle) ? root.crypto : null;
  if (!wc && typeof require === "function") wc = require("node:crypto").webcrypto;
  var curve = root.HyP256 || (typeof require === "function" ? require("./p256.js") : null);
  var api = factory(wc, curve);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HySpake2 = api;
})(typeof self !== "undefined" ? self : globalThis, function (webcrypto, C) {
  "use strict";

  var enc = new TextEncoder();
  var subtle = webcrypto.subtle;
  var MN = null;

  function concat() {
    var n = 0, i;
    for (i = 0; i < arguments.length; i++) n += arguments[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < arguments.length; i++) { out.set(arguments[i], o); o += arguments[i].length; }
    return out;
  }
  function utf8(s) { return enc.encode(s); }

  async function sha256(bytes) { return new Uint8Array(await subtle.digest("SHA-256", bytes)); }

  async function hkdf(ikm, salt, info, len) {
    var k = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt, info: utf8(info) }, k, len * 8));
  }
  async function hmac(keyBytes, data) {
    var k = await subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await subtle.sign("HMAC", k, data));
  }
  function ctEq(a, b) {
    if (a.length !== b.length) return false;
    var d = 0;
    for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }

  /** Length-prefixed concatenation, so no two field lists encode alike. */
  function lp(parts) {
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = typeof parts[i] === "string" ? utf8(parts[i]) : parts[i];
      var len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, p.length);
      out.push(len, p);
    }
    return concat.apply(null, out);
  }

  async function points() {
    if (!MN) {
      MN = {
        M: await C.hashToPoint("hyphae/spake2/p256/M/v1"),
        N: await C.hashToPoint("hyphae/spake2/p256/N/v1"),
      };
    }
    return MN;
  }

  /** w from the (already normalized) code, bound to `context` bytes. */
  async function deriveW(code, context, iters) {
    var salt = await sha256(concat(utf8("hyphae/spake2/w/v1\0"), context));
    var base = await subtle.importKey("raw", utf8(code), "PBKDF2", false, ["deriveBits"]);
    var bits = new Uint8Array(await subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: salt, iterations: Math.max(1, iters | 0) }, base, 512));
    var w = C.b2i(bits) % C.N;
    return w === 0n ? 1n : w;
  }

  /** Begin: role "A" (inviter) or "B" (joiner). Returns { x, msg } — keep x private. */
  async function start(role, w) {
    var p = await points();
    var x = C.randomScalar();
    var mask = C.mul(w, role === "A" ? p.M : p.N);
    var pt = C.add(C.mul(x, C.G), mask);
    return { x: x, msg: C.encode(pt) };
  }

  /**
   * Finish: our scalar x, w, and the peer's 33-byte message. Returns the
   * encoded shared point, or null if the peer's message is not a valid point or
   * is the degenerate "exactly the mask" value (which would force K = identity).
   */
  async function finish(role, w, x, peerMsg) {
    var p = await points();
    var peer = C.decode(peerMsg);
    if (!peer || peerMsg.length !== 33) return null;
    var unmasked = C.add(peer, C.neg(C.mul(w, role === "A" ? p.N : p.M)));
    if (!unmasked) return null;
    var k = C.mul(x, unmasked);
    if (!k) return null;
    return C.encode(k);
  }

  /**
   * From the full transcript bytes: { h, ke, kcA, kcB }. `ke` feeds the pair
   * key; kcA/kcB are the two directions' confirmation keys.
   */
  async function schedule(transcript) {
    var h = await sha256(transcript);
    return {
      h: h,
      ke: await hkdf(h, new Uint8Array(0), "hyphae/spake2/ke", 32),
      kcA: await hkdf(h, new Uint8Array(0), "hyphae/spake2/kcA", 32),
      kcB: await hkdf(h, new Uint8Array(0), "hyphae/spake2/kcB", 32),
    };
  }
  /** Confirmation tag by one side over the transcript hash. */
  function tag(kc, h, label) { return hmac(kc, concat(utf8(label), h)); }

  return {
    deriveW: deriveW, start: start, finish: finish, schedule: schedule, tag: tag,
    points: points, lp: lp, concat: concat, utf8: utf8, sha256: sha256, hkdf: hkdf, hmac: hmac, ctEq: ctEq,
  };
});
