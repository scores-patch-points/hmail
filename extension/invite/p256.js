/*
 * P-256 point arithmetic in BigInt — only what SPAKE2 needs and WebCrypto does
 * not expose: point addition and scalar multiplication of arbitrary points.
 * Everything else in the invite flow uses WebCrypto directly.
 *
 * NOT constant time. The secrets it touches are a short-lived SPAKE2 scalar
 * and a password-derived scalar on the user's own device; there is no remote
 * party that can time it. It is cross-checked against WebCrypto's ECDH in
 * attacks.test.mjs (scalar multiplication of G and of arbitrary points), so a
 * mistake here is caught, not assumed away.
 *
 * Points are { x, y } (BigInt) or null for the point at infinity. P-256 has
 * cofactor 1, so every on-curve non-identity point is in the prime-order group
 * and there is no small-subgroup case to refuse.
 */
(function (root, factory) {
  var wc = (root.crypto && root.crypto.subtle) ? root.crypto : null;
  if (!wc && typeof require === "function") wc = require("node:crypto").webcrypto;
  var api = factory(wc);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HyP256 = api;
})(typeof self !== "undefined" ? self : globalThis, function (webcrypto) {
  "use strict";

  var P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
  var N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  var B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
  var G = {
    x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
    y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
  };

  function mod(a) { var r = a % P; return r >= 0n ? r : r + P; }
  function modN(a) { var r = a % N; return r >= 0n ? r : r + N; }
  function powmod(b, e, m) {
    var r = 1n; b %= m;
    while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
    return r;
  }
  function inv(a) { return powmod(mod(a), P - 2n, P); }

  function isOnCurve(pt) {
    if (!pt) return false;
    if (pt.x < 0n || pt.x >= P || pt.y < 0n || pt.y >= P) return false;
    return mod(pt.y * pt.y) === mod(pt.x * pt.x * pt.x - 3n * pt.x + B);
  }

  // ---- Jacobian arithmetic (a = -3), one inversion per scalar multiplication ----
  function jDouble(p) {
    if (!p || p.y === 0n) return null;
    var delta = mod(p.z * p.z), gamma = mod(p.y * p.y), beta = mod(p.x * gamma);
    var alpha = mod(3n * (p.x - delta) * (p.x + delta));
    var x3 = mod(alpha * alpha - 8n * beta);
    var z3 = mod((p.y + p.z) * (p.y + p.z) - gamma - delta);
    var y3 = mod(alpha * (4n * beta - x3) - 8n * gamma * gamma);
    return { x: x3, y: y3, z: z3 };
  }
  function jAdd(p, q) {
    if (!p) return q;
    if (!q) return p;
    var z1z1 = mod(p.z * p.z), z2z2 = mod(q.z * q.z);
    var u1 = mod(p.x * z2z2), u2 = mod(q.x * z1z1);
    var s1 = mod(p.y * q.z * z2z2), s2 = mod(q.y * p.z * z1z1);
    var h = mod(u2 - u1), r = mod(2n * (s2 - s1));
    if (h === 0n) return r === 0n ? jDouble(p) : null;
    var i = mod(4n * h * h), j = mod(h * i), v = mod(u1 * i);
    var x3 = mod(r * r - j - 2n * v);
    var y3 = mod(r * (v - x3) - 2n * s1 * j);
    var z3 = mod(((p.z + q.z) * (p.z + q.z) - z1z1 - z2z2) * h);
    return { x: x3, y: y3, z: z3 };
  }
  function toJ(pt) { return pt ? { x: pt.x, y: pt.y, z: 1n } : null; }
  function fromJ(p) {
    if (!p || p.z === 0n) return null;
    var zi = inv(p.z), zi2 = mod(zi * zi);
    return { x: mod(p.x * zi2), y: mod(p.y * zi2 * zi) };
  }

  function add(a, b) { return fromJ(jAdd(toJ(a), toJ(b))); }
  function neg(a) { return a ? { x: a.x, y: mod(-a.y) } : null; }
  function mul(k, pt) {
    k = modN(k);
    if (k === 0n || !pt) return null;
    var acc = null, base = toJ(pt);
    while (k > 0n) {
      if (k & 1n) acc = jAdd(acc, base);
      base = jDouble(base);
      k >>= 1n;
    }
    return fromJ(acc);
  }

  // ---- encodings ---------------------------------------------------------------
  function i2b(v, len) {
    var out = new Uint8Array(len);
    for (var i = len - 1; i >= 0; i--) { out[i] = Number(v & 255n); v >>= 8n; }
    return out;
  }
  function b2i(bytes) {
    var v = 0n;
    for (var i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
    return v;
  }
  /** SEC1 compressed, 33 bytes. Refuses the identity. */
  function encode(pt) {
    if (!pt) throw new Error("identity point");
    var out = new Uint8Array(33);
    out[0] = (pt.y & 1n) ? 3 : 2;
    out.set(i2b(pt.x, 32), 1);
    return out;
  }
  /** Decode compressed or uncompressed SEC1. Returns null for anything that is not a valid non-identity point. */
  function decode(bytes) {
    if (!bytes) return null;
    if (bytes.length === 33 && (bytes[0] === 2 || bytes[0] === 3)) {
      var x = b2i(bytes.subarray(1));
      if (x >= P) return null;
      var rhs = mod(x * x * x - 3n * x + B);
      var y = powmod(rhs, (P + 1n) / 4n, P);
      if (mod(y * y) !== rhs) return null;
      if (Number(y & 1n) !== (bytes[0] & 1)) y = mod(-y);
      return { x: x, y: y };
    }
    if (bytes.length === 65 && bytes[0] === 4) {
      var pt = { x: b2i(bytes.subarray(1, 33)), y: b2i(bytes.subarray(33)) };
      return isOnCurve(pt) ? pt : null;
    }
    return null;
  }

  function randomScalar() {
    // 64 random bytes reduced mod n: bias is ~2^-256.
    var b = new Uint8Array(64);
    webcrypto.getRandomValues(b);
    var k = b2i(b) % (N - 1n) + 1n;
    return k;
  }

  /**
   * Nothing-up-my-sleeve generator by try-and-increment: SHA-256(label || ctr)
   * as an x coordinate, first ctr that lands on the curve, y with even parity.
   * No one knows its discrete log relative to G or to another label's point
   * (that is the whole requirement SPAKE2 places on M and N).
   */
  async function hashToPoint(label) {
    var enc = new TextEncoder().encode(label);
    for (var ctr = 0; ctr < 1000; ctr++) {
      var buf = new Uint8Array(enc.length + 4);
      buf.set(enc, 0);
      new DataView(buf.buffer).setUint32(enc.length, ctr);
      var h = new Uint8Array(await webcrypto.subtle.digest("SHA-256", buf));
      var x = b2i(h);
      if (x >= P) continue;
      var rhs = mod(x * x * x - 3n * x + B);
      var y = powmod(rhs, (P + 1n) / 4n, P);
      if (mod(y * y) !== rhs) continue;
      if (y & 1n) y = mod(-y);
      return { x: x, y: y };
    }
    throw new Error("no point found");
  }

  return {
    P: P, N: N, G: G, add: add, neg: neg, mul: mul, isOnCurve: isOnCurve,
    encode: encode, decode: decode, randomScalar: randomScalar, hashToPoint: hashToPoint,
    i2b: i2b, b2i: b2i,
  };
});
