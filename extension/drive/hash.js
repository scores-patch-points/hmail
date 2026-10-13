/*
 * hyphae drive — incremental SHA-256 and MD5.
 *
 * WebCrypto only digests a whole buffer at once, and a Drive file is read as
 * a stream. These two are used for read-back verification, not secrecy:
 *
 *   sha256  the plaintext identity recorded in a sealed file's manifest, and
 *           the check against Drive's sha256Checksum
 *   md5     Drive's md5Checksum, which every binary file carries
 *
 * Dependency-free; the same file runs in the worker and in Node tests (where
 * test-hash.js compares both against node:crypto).
 *
 *   var h = HyHash.sha256(); h.update(bytes); h.update(more); h.digest() // Uint8Array
 *   HyHash.hex(bytes)
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HyHash = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  var K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function Sha256() {
    this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.w = new Uint32Array(64);
    this.buf = new Uint8Array(64);
    this.n = 0;      // bytes held in buf
    this.total = 0;  // bytes hashed so far
  }
  Sha256.prototype._block = function (b, o) {
    var w = this.w, h = this.h, i;
    for (i = 0; i < 16; i++, o += 4) w[i] = (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    for (i = 16; i < 64; i++) {
      var x = w[i - 15], y = w[i - 2];
      var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    var a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (i = 0; i < 64; i++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var t1 = (hh + S1 + ch + K256[i] + w[i]) | 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var mj = (a & bb) ^ (a & c) ^ (bb & c);
      var t2 = (S0 + mj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + bb) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  };
  Sha256.prototype.update = function (data) {
    var i = 0, len = data.length;
    this.total += len;
    if (this.n > 0) {
      while (this.n < 64 && i < len) this.buf[this.n++] = data[i++];
      if (this.n < 64) return this;
      this._block(this.buf, 0);
      this.n = 0;
    }
    while (i + 64 <= len) { this._block(data, i); i += 64; }
    while (i < len) this.buf[this.n++] = data[i++];
    return this;
  };
  Sha256.prototype.digest = function () {
    var bits = this.total * 8, n = this.n, buf = this.buf, i;
    buf[n++] = 0x80;
    if (n > 56) { while (n < 64) buf[n++] = 0; this._block(buf, 0); n = 0; }
    while (n < 56) buf[n++] = 0;
    var hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
    buf[56] = hi >>> 24; buf[57] = hi >>> 16; buf[58] = hi >>> 8; buf[59] = hi;
    buf[60] = lo >>> 24; buf[61] = lo >>> 16; buf[62] = lo >>> 8; buf[63] = lo;
    this._block(buf, 0);
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) {
      out[i * 4] = this.h[i] >>> 24; out[i * 4 + 1] = this.h[i] >>> 16;
      out[i * 4 + 2] = this.h[i] >>> 8; out[i * 4 + 3] = this.h[i];
    }
    return out;
  };

  // ---- MD5 ------------------------------------------------------------------
  var MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  var MD5_K = new Uint32Array(64);
  (function () {
    for (var i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  })();

  function Md5() {
    this.h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
    this.m = new Uint32Array(16);
    this.buf = new Uint8Array(64);
    this.n = 0;
    this.total = 0;
  }
  Md5.prototype._block = function (b, o) {
    var m = this.m, h = this.h, i;
    for (i = 0; i < 16; i++, o += 4) m[i] = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
    var a = h[0], bb = h[1], c = h[2], d = h[3];
    for (i = 0; i < 64; i++) {
      var f, g, r = i >> 4;
      if (r === 0) { f = (bb & c) | (~bb & d); g = i; }
      else if (r === 1) { f = (d & bb) | (~d & c); g = (5 * i + 1) & 15; }
      else if (r === 2) { f = bb ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (bb | ~d); g = (7 * i) & 15; }
      var t = (a + f + MD5_K[i] + m[g]) | 0;
      var s = MD5_S[(r << 2) | (i & 3)];
      a = d; d = c; c = bb;
      bb = (bb + ((t << s) | (t >>> (32 - s)))) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + bb) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
  };
  Md5.prototype.update = Sha256.prototype.update;
  Md5.prototype.digest = function () {
    var bits = this.total * 8, n = this.n, buf = this.buf, i;
    buf[n++] = 0x80;
    if (n > 56) { while (n < 64) buf[n++] = 0; this._block(buf, 0); n = 0; }
    while (n < 56) buf[n++] = 0;
    var lo = bits >>> 0, hi = Math.floor(bits / 0x100000000);
    buf[56] = lo; buf[57] = lo >>> 8; buf[58] = lo >>> 16; buf[59] = lo >>> 24;
    buf[60] = hi; buf[61] = hi >>> 8; buf[62] = hi >>> 16; buf[63] = hi >>> 24;
    this._block(buf, 0);
    var out = new Uint8Array(16);
    for (i = 0; i < 4; i++) {
      out[i * 4] = this.h[i]; out[i * 4 + 1] = this.h[i] >>> 8;
      out[i * 4 + 2] = this.h[i] >>> 16; out[i * 4 + 3] = this.h[i] >>> 24;
    }
    return out;
  };

  function hex(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return s;
  }

  return {
    sha256: function () { return new Sha256(); },
    md5: function () { return new Md5(); },
    hex: hex,
  };
});
