/*
 * hyphae drive — the sealed-file format ("hyd1"): a binary blob sealed under a
 * circle key, built to be streamed in chunks of any size without ever holding
 * the file in memory, and to refuse a truncated, reordered or re-labelled copy.
 *
 *   header   62 bytes, plain:
 *              "HYD1" | version 1 | flags 0 | circle id (8) | chunk size u32 |
 *              salt (32) | nonce base (12)
 *   records  each:  u32 length (top bit = final record) | AES-256-GCM ciphertext+tag
 *              #0        META   JSON: the real name, type, size, mtime
 *              #1..n     DATA   plaintext chunks, chunk size each, the last may be shorter
 *              #n+1      FINAL  manifest: chunk count u32 | length u64 | sha256 | md5
 *
 * Cipher: AES-256-GCM, the same cipher and the same circle key as crypto.js,
 * but never the circle key itself — each file gets a subkey,
 *     HKDF-SHA256(circle key, salt = header.salt, info = "hyphae-drive-v1/file-key" | circle id)
 * so a file can never be confused with a text token and no (key, nonce) pair
 * repeats across files however many are sealed.
 *
 * Every record is authenticated with additional data = the whole header | type
 * byte | record index, and its nonce is the header's nonce base with the
 * index folded in. So a chunk cannot be moved, repeated, dropped, re-labelled
 * (circle id lives in the header) or spliced in from another file, and a file
 * with no authenticated FINAL record — or bytes after it — is refused: that is
 * the manifest. The FINAL record also carries the plaintext's sha256 and md5,
 * so read-back can be checked against what Drive itself reports.
 *
 * Streaming contract: the opener hands plaintext out as soon as each record
 * authenticates, but the stream is only complete — and the plaintext only to
 * be trusted as the whole file — once end() has returned. Callers that write
 * plaintext somewhere durable must not commit it before end() resolves.
 *
 * Loaded in the worker with importScripts (global HyDriveSeal) and with
 * require() in Node. Bytes passed to write() must not be modified afterwards.
 */
(function (root, factory) {
  var wc = (root.crypto && root.crypto.subtle) ? root.crypto : null;
  if (!wc && typeof require === "function") wc = require("node:crypto").webcrypto;
  var hash = root.HyHash;
  if (!hash && typeof require === "function") hash = require("./hash.js");
  var api = factory(wc, hash);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HyDriveSeal = api;
})(typeof self !== "undefined" ? self : globalThis, function (webcrypto, HyHash) {
  "use strict";

  var enc = new TextEncoder();
  var dec = new TextDecoder();

  var MAGIC = [0x48, 0x59, 0x44, 0x31]; // "HYD1"
  var VERSION = 1;
  var HEADER_LEN = 62;
  var DEFAULT_CHUNK = 1048576;          // 1 MiB
  var MIN_CHUNK = 4096;
  var MAX_CHUNK = 16 * 1048576;         // refused above this on open: a header can't ask us for gigabytes
  var META_MAX = 65536;
  var FINAL_LEN = 60;
  var T_META = 0x4d, T_DATA = 0x44, T_FINAL = 0x46;
  var FINAL_BIT = 0x80000000;
  var MAX_INDEX = 0xfffffff0;
  var NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

  function fail(code, msg) {
    var e = new Error("hyphae drive: " + msg);
    e.code = code;
    return e;
  }

  // ---- small byte helpers ----------------------------------------------------
  function b64uEncode(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64uDecode(str) {
    var s = String(str).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function rand(n) {
    var b = new Uint8Array(n);
    webcrypto.getRandomValues(b);
    return b;
  }
  function putU32(b, o, n) { b[o] = n >>> 24; b[o + 1] = n >>> 16; b[o + 2] = n >>> 8; b[o + 3] = n; }
  function getU32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function putU64(b, o, n) { putU32(b, o, Math.floor(n / 4294967296)); putU32(b, o + 4, n >>> 0); }
  function getU64(b, o) { return getU32(b, o) * 4294967296 + getU32(b, o + 4); }
  function concat(list) {
    var n = 0, i;
    for (i = 0; i < list.length; i++) n += list[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], o); o += list[i].length; }
    return out;
  }
  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    var d = 0;
    for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }

  // A FIFO of byte pieces that can hand out exactly n bytes.
  function ByteQueue() { this.q = []; this.len = 0; }
  ByteQueue.prototype.push = function (u8) {
    if (u8 && u8.length) { this.q.push(u8); this.len += u8.length; }
  };
  ByteQueue.prototype.peekU32 = function () {
    var out = new Uint8Array(4), o = 0, i = 0;
    while (o < 4) {
      var p = this.q[i++];
      for (var j = 0; j < p.length && o < 4; j++) out[o++] = p[j];
    }
    return getU32(out, 0);
  };
  ByteQueue.prototype.take = function (n) {
    var out = new Uint8Array(n), o = 0;
    while (o < n) {
      var p = this.q[0], need = n - o;
      if (p.length <= need) { out.set(p, o); o += p.length; this.q.shift(); }
      else { out.set(p.subarray(0, need), o); this.q[0] = p.subarray(need); o += need; }
    }
    this.len -= n;
    return out;
  };

  // ---- header, metadata, key ---------------------------------------------------
  function circleParts(circle) {
    if (!circle || typeof circle.kid !== "string" || typeof circle.key !== "string") throw fail("bad-circle", "circle needs a kid and a key");
    var kid, key;
    try { kid = b64uDecode(circle.kid); key = b64uDecode(circle.key); } catch (e) { throw fail("bad-circle", "circle id or key is not base64url"); }
    if (kid.length !== 8 || key.length !== 32) throw fail("bad-circle", "circle id must be 8 bytes and key 32 bytes");
    return { kid: kid, key: key };
  }

  /** The header's fields, or null when `bytes` doesn't start like a sealed file. */
  function parseHeader(bytes) {
    if (!bytes || bytes.length < HEADER_LEN) return null;
    for (var i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) return null;
    if (bytes[4] !== VERSION || bytes[5] !== 0) return null;
    var chunkSize = getU32(bytes, 14);
    if (chunkSize < MIN_CHUNK || chunkSize > MAX_CHUNK) return null;
    return {
      version: bytes[4],
      kid: b64uEncode(bytes.subarray(6, 14)),
      chunkSize: chunkSize,
      salt: bytes.subarray(18, 50),
      nonceBase: bytes.subarray(50, 62),
    };
  }
  function isSealed(bytes) { return parseHeader(bytes) !== null; }

  /** Canonical metadata bytes. Only these fields are kept, all optional. */
  function encodeMeta(meta) {
    meta = meta || {};
    var m = { v: 1 };
    if (typeof meta.name === "string") m.name = meta.name.slice(0, 1024);
    if (typeof meta.mime === "string") m.mime = meta.mime.slice(0, 256);
    if (typeof meta.size === "number" && isFinite(meta.size)) m.size = meta.size;
    if (typeof meta.mtime === "string") m.mtime = meta.mtime.slice(0, 64);
    if (typeof meta.id === "string") m.id = meta.id.slice(0, 128);
    if (typeof meta.path === "string") m.path = meta.path.slice(0, 2048);
    var bytes = enc.encode(JSON.stringify(m));
    if (bytes.length > META_MAX) throw fail("bad-meta", "metadata is too large");
    return bytes;
  }

  async function deriveFileKey(circle, header) {
    var parts = circleParts(circle);
    var ikm = await webcrypto.subtle.importKey("raw", parts.key, "HKDF", false, ["deriveKey"]);
    var info = concat([enc.encode("hyphae-drive-v1/file-key"), header.subarray(6, 14)]);
    return webcrypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: header.subarray(18, 50), info: info },
      ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
  }

  function recordAad(header, type, index) {
    var a = new Uint8Array(HEADER_LEN + 5);
    a.set(header, 0);
    a[HEADER_LEN] = type;
    putU32(a, HEADER_LEN + 1, index);
    return a;
  }
  function recordNonce(header, index) {
    var n = new Uint8Array(header.subarray(50, 62));
    n[8] ^= index >>> 24; n[9] ^= index >>> 16; n[10] ^= index >>> 8; n[11] ^= index;
    return n;
  }

  /** Exactly how many bytes sealing `plainSize` bytes yields (for Content-Length / resumable uploads). */
  function sealedSize(plainSize, metaBytesLength, chunkSize) {
    chunkSize = chunkSize || DEFAULT_CHUNK;
    var full = Math.floor(plainSize / chunkSize), rem = plainSize - full * chunkSize;
    return HEADER_LEN + (4 + metaBytesLength + 16) + full * (4 + chunkSize + 16) + (rem > 0 ? 4 + rem + 16 : 0) + (4 + FINAL_LEN + 16);
  }

  // ---- sealer -----------------------------------------------------------------
  /**
   * A push-style sealer. Every call returns an array of Uint8Array to send, in
   * order; the first array also carries the header and the META record.
   *   var s = await createSealer(circle, { name, mime, size, mtime });
   *   parts = await s.write(bytes); ...; parts = await s.end();
   * s.manifest is set once end() has returned.
   */
  async function createSealer(circle, meta, opts) {
    opts = opts || {};
    var chunkSize = opts.chunkSize || DEFAULT_CHUNK;
    if (chunkSize < MIN_CHUNK || chunkSize > MAX_CHUNK || Math.floor(chunkSize) !== chunkSize) throw fail("bad-chunk", "chunk size out of range");
    var parts = circleParts(circle);
    var header = new Uint8Array(HEADER_LEN);
    header.set(MAGIC, 0);
    header[4] = VERSION;
    header[5] = 0;
    header.set(parts.kid, 6);
    putU32(header, 14, chunkSize);
    header.set(rand(32), 18);
    header.set(rand(12), 50);
    var key = await deriveFileKey(circle, header);
    var metaBytes = (meta instanceof Uint8Array) ? meta : encodeMeta(meta);

    var sha = HyHash.sha256(), md5 = HyHash.md5();
    var index = 0, dataChunks = 0, size = 0, started = false, done = false;
    var pending = [], pendingLen = 0;

    async function record(type, plain, final) {
      if (index > MAX_INDEX) throw fail("too-large", "file has too many chunks");
      var idx = index++;
      var ct = new Uint8Array(await webcrypto.subtle.encrypt(
        { name: "AES-GCM", iv: recordNonce(header, idx), additionalData: recordAad(header, type, idx), tagLength: 128 },
        key, plain));
      var out = new Uint8Array(4 + ct.length);
      putU32(out, 0, (ct.length | (final ? FINAL_BIT : 0)) >>> 0);
      out.set(ct, 4);
      return out;
    }
    function takePending(n) {
      var out = new Uint8Array(n), o = 0;
      while (o < n) {
        var p = pending[0], need = n - o;
        if (p.length <= need) { out.set(p, o); o += p.length; pending.shift(); }
        else { out.set(p.subarray(0, need), o); pending[0] = p.subarray(need); o += need; }
      }
      pendingLen -= n;
      return out;
    }
    async function start(out) {
      if (started) return;
      started = true;
      out.push(header);
      out.push(await record(T_META, metaBytes, false));
    }

    var sealer = {
      chunkSize: chunkSize,
      kid: circle.kid,
      metaBytes: metaBytes,
      manifest: null,
      write: async function (bytes) {
        if (done) throw fail("closed", "sealer already ended");
        var out = [];
        await start(out);
        if (bytes && bytes.length) {
          sha.update(bytes); md5.update(bytes);
          size += bytes.length;
          pending.push(bytes); pendingLen += bytes.length;
        }
        while (pendingLen >= chunkSize) {
          out.push(await record(T_DATA, takePending(chunkSize), false));
          dataChunks++;
        }
        return out;
      },
      end: async function () {
        if (done) throw fail("closed", "sealer already ended");
        var out = [];
        await start(out);
        if (pendingLen > 0) {
          out.push(await record(T_DATA, takePending(pendingLen), false));
          dataChunks++;
        }
        var shaD = sha.digest(), md5D = md5.digest();
        var f = new Uint8Array(FINAL_LEN);
        putU32(f, 0, dataChunks);
        putU64(f, 4, size);
        f.set(shaD, 12);
        f.set(md5D, 44);
        out.push(await record(T_FINAL, f, true));
        done = true;
        sealer.manifest = { chunks: dataChunks, size: size, sha256: HyHash.hex(shaD), md5: HyHash.hex(md5D) };
        return out;
      },
    };
    return sealer;
  }

  // ---- opener -----------------------------------------------------------------
  function circleLookup(circles) {
    if (!circles) return {};
    if (Array.isArray(circles)) {
      var m = {};
      for (var i = 0; i < circles.length; i++) if (circles[i] && circles[i].kid) m[circles[i].kid] = circles[i];
      return m;
    }
    if (typeof circles.kid === "string" && typeof circles.key === "string") {
      var one = {}; one[circles.kid] = circles; return one;
    }
    return circles;
  }

  /**
   * A push-style opener over the circles you hold (a circle, an array, or a
   * { kid: circle } map). write() returns plaintext pieces as they
   * authenticate; end() returns the manifest and throws if the file is not
   * complete. opener.meta is set once the first record has opened.
   */
  function createOpener(circles) {
    var byKid = circleLookup(circles);
    var q = new ByteQueue();
    var header = null, key = null, info = null;
    var index = 0, chunks = 0, size = 0, shortSeen = false, done = false;
    var sha = HyHash.sha256(), md5 = HyHash.md5();

    async function decryptRecord(type, idx, ct) {
      try {
        return new Uint8Array(await webcrypto.subtle.decrypt(
          { name: "AES-GCM", iv: recordNonce(header, idx), additionalData: recordAad(header, type, idx), tagLength: 128 },
          key, ct));
      } catch (e) {
        if (idx === 0) throw fail("auth", "wrong key, or the file was changed");
        throw fail("tampered", "chunk " + idx + " failed authentication: tampered, reordered or spliced");
      }
    }

    var opener = {
      meta: null,
      manifest: null,
      kid: null,
      write: async function (bytes) {
        if (done) {
          if (bytes && bytes.length) throw fail("trailing-data", "bytes after the final record");
          return [];
        }
        q.push(bytes);
        var plain = [];
        for (;;) {
          if (!header) {
            if (q.len < HEADER_LEN) break;
            header = q.take(HEADER_LEN);
            info = parseHeader(header);
            if (!info) throw fail("bad-header", "not a sealed file, or an unsupported version");
            opener.kid = info.kid;
            var circle = byKid[info.kid];
            if (!circle) throw fail("no-key", "sealed to a circle we do not hold (" + info.kid + ")");
            key = await deriveFileKey(circle, header);
          }
          if (q.len < 4) break;
          var word = q.peekU32();
          var isFinal = (word & FINAL_BIT) !== 0;
          var len = (word & ~FINAL_BIT) >>> 0;
          var type, maxLen, minLen = 16;
          if (index === 0) {
            if (isFinal) throw fail("bad-frame", "first record cannot be final");
            type = T_META; maxLen = META_MAX + 16;
          } else if (isFinal) {
            type = T_FINAL; maxLen = minLen = FINAL_LEN + 16;
          } else {
            type = T_DATA; maxLen = info.chunkSize + 16; minLen = 17;
          }
          if (len < minLen || len > maxLen) throw fail("bad-frame", "record " + index + " has an impossible length");
          if (q.len < 4 + len) break;
          q.take(4);
          var pt = await decryptRecord(type, index, q.take(len));
          index++;
          if (type === T_META) {
            try { opener.meta = JSON.parse(dec.decode(pt)); } catch (e) { throw fail("bad-meta", "metadata record is not JSON"); }
          } else if (type === T_DATA) {
            if (shortSeen) throw fail("bad-frame", "a short chunk was followed by more data");
            if (pt.length < info.chunkSize) shortSeen = true;
            sha.update(pt); md5.update(pt);
            size += pt.length; chunks++;
            plain.push(pt);
          } else {
            var shaD = HyHash.hex(sha.digest()), md5D = HyHash.hex(md5.digest());
            var count = getU32(pt, 0), total = getU64(pt, 4);
            if (count !== chunks || total !== size) throw fail("manifest", "manifest disagrees with the chunks received");
            if (HyHash.hex(pt.subarray(12, 44)) !== shaD || HyHash.hex(pt.subarray(44, 60)) !== md5D) throw fail("manifest", "manifest hash disagrees with the plaintext");
            done = true;
            opener.manifest = { chunks: chunks, size: size, sha256: shaD, md5: md5D, kid: info.kid, chunkSize: info.chunkSize, meta: opener.meta };
            if (q.len > 0) throw fail("trailing-data", "bytes after the final record");
            break;
          }
        }
        return plain;
      },
      end: async function () {
        if (!done) throw fail("truncated", "the file ends before its final record");
        return opener.manifest;
      },
    };
    return opener;
  }

  // ---- whole-buffer conveniences ---------------------------------------------------
  async function sealBytes(circle, bytes, meta, opts) {
    var s = await createSealer(circle, meta, opts);
    var out = await s.write(bytes);
    out = out.concat(await s.end());
    return concat(out);
  }
  async function openBytes(circles, sealed) {
    var o = createOpener(circles);
    var plain = await o.write(sealed);
    var manifest = await o.end();
    return { meta: o.meta, bytes: concat(plain), manifest: manifest };
  }

  // ---- WHATWG stream wrappers --------------------------------------------------
  function sealStream(circle, source, meta, opts) {
    var sealer = null, reader = source.getReader(), ended = false;
    return new ReadableStream({
      pull: async function (controller) {
        if (!sealer) sealer = await createSealer(circle, meta, opts);
        for (;;) {
          if (ended) { controller.close(); return; }
          var r = await reader.read(), out;
          if (r.done) { ended = true; out = await sealer.end(); }
          else out = await sealer.write(r.value);
          for (var i = 0; i < out.length; i++) controller.enqueue(out[i]);
          if (ended) { controller.close(); return; }
          if (out.length) return;
        }
      },
      cancel: function (reason) { return reader.cancel(reason); },
    });
  }
  function openStream(circles, source) {
    var opener = createOpener(circles), reader = source.getReader(), ended = false;
    return new ReadableStream({
      pull: async function (controller) {
        for (;;) {
          if (ended) { controller.close(); return; }
          var r = await reader.read(), out;
          if (r.done) { ended = true; await opener.end(); out = []; }
          else out = await opener.write(r.value);
          for (var i = 0; i < out.length; i++) controller.enqueue(out[i]);
          if (ended) { controller.close(); return; }
          if (out.length) return;
        }
      },
      cancel: function (reason) { return reader.cancel(reason); },
    });
  }

  /** A random display name for a sealed file: carries nothing of the original. */
  function randomName() {
    var r = rand(24), s = "hy-";
    for (var i = 0; i < 24; i++) s += NAME_ALPHABET[r[i] & 31];
    return s + ".hyd";
  }

  return {
    HEADER_LEN: HEADER_LEN, DEFAULT_CHUNK: DEFAULT_CHUNK, MIN_CHUNK: MIN_CHUNK, MAX_CHUNK: MAX_CHUNK,
    parseHeader: parseHeader, isSealed: isSealed, encodeMeta: encodeMeta, sealedSize: sealedSize,
    createSealer: createSealer, createOpener: createOpener,
    sealBytes: sealBytes, openBytes: openBytes, sealStream: sealStream, openStream: openStream,
    randomName: randomName, concat: concat,
  };
});
