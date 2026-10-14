/*
 * HyUpdate — the checks behind "the extension upgrades itself".
 *
 * An update is a release zip plus a detached signature (ECDSA P-256 / SHA-256, raw r||s,
 * base64). The extension holds only the PUBLIC key; the private key stays on the machine
 * that makes releases. Nothing is written until the signature over the exact zip bytes
 * verifies, and a zip that fails any structural check is refused whole.
 *
 * No chrome.*, no DOM, no network: pure functions, so the same file runs in the update
 * page and under Node tests. Classic script; registers HyUpdate on `self`.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HyUpdate = api;
})(typeof self !== "undefined" ? self : globalThis, function (root) {
  "use strict";

  var td = new TextDecoder();
  var MAX_FILES = 400, MAX_FILE = 8 * 1024 * 1024, MAX_TOTAL = 40 * 1024 * 1024;

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function fail(code, msg) { var e = new Error("update: " + msg); e.code = code; return e; }

  function b64decode(s) {
    var bin = atob(String(s).replace(/\s+/g, ""));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** "0.10.2" > "0.9.9". Non-numeric parts count as 0. */
  function compareVersions(a, b) {
    var pa = String(a).split("."), pb = String(b).split(".");
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = parseInt(pa[i] || "0", 10) || 0, y = parseInt(pb[i] || "0", 10) || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  /** True only if `sigB64` is a valid signature over exactly `bytes` by the key in `pubJwk`. */
  async function verify(pubJwk, bytes, sigB64) {
    try {
      var key = await root.crypto.subtle.importKey("jwk", pubJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      var sig = b64decode(sigB64);
      if (sig.length !== 64) return false;
      return await root.crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, bytes);
    } catch (e) { return false; }
  }

  async function inflateRaw(u8) {
    var ds = new DecompressionStream("deflate-raw");
    var w = ds.writable.getWriter();
    w.write(u8); w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }

  /** The files of a zip, read from its central directory. Zip64 and encryption are refused. */
  function readZip(u8) {
    var i = u8.length - 22, lim = Math.max(0, u8.length - 65557);
    for (; i >= lim; i--) if (u32(u8, i) === 0x06054b50) break;
    if (i < lim) throw fail("zip", "not a zip file");
    var count = u16(u8, i + 10), p = u32(u8, i + 16), out = [];
    if (count === 0xffff) throw fail("zip", "zip64 is not supported");
    if (count > MAX_FILES) throw fail("zip", "too many files");
    for (var n = 0; n < count; n++) {
      if (p + 46 > u8.length || u32(u8, p) !== 0x02014b50) throw fail("zip", "damaged zip directory");
      var flags = u16(u8, p + 8), method = u16(u8, p + 10), csize = u32(u8, p + 20), usize = u32(u8, p + 24);
      var nlen = u16(u8, p + 28), elen = u16(u8, p + 30), clen = u16(u8, p + 32), lho = u32(u8, p + 42);
      if (flags & 1) throw fail("zip", "encrypted entries are not supported");
      var name = td.decode(u8.subarray(p + 46, p + 46 + nlen));
      out.push(makeEntry(u8, name, method, csize, usize, lho));
      p += 46 + nlen + elen + clen;
    }
    return out;
  }
  function makeEntry(u8, name, method, csize, usize, lho) {
    return {
      name: name, dir: /\/$/.test(name), size: usize,
      read: async function () {
        if (usize > MAX_FILE) throw fail("zip", name + " is too large");
        if (lho + 30 > u8.length || u32(u8, lho) !== 0x04034b50) throw fail("zip", "damaged entry " + name);
        var nlen = u16(u8, lho + 26), elen = u16(u8, lho + 28), start = lho + 30 + nlen + elen;
        if (start + csize > u8.length) throw fail("zip", "truncated entry " + name);
        var raw = u8.subarray(start, start + csize), data;
        if (method === 0) data = raw;
        else if (method === 8) data = await inflateRaw(raw);
        else throw fail("zip", "unsupported compression in " + name);
        if (data.length !== usize) throw fail("zip", "size mismatch for " + name);
        return data;
      },
    };
  }

  /** A path that stays inside the extension folder, or null. */
  function safePath(name) {
    if (!name || name.length > 240) return null;
    if (name.charAt(0) === "/" || name.indexOf("\\") !== -1 || name.indexOf(":") !== -1 || name.indexOf("\0") !== -1) return null;
    var parts = name.split("/");
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === ".." || parts[i] === "." || (parts[i] === "" && i !== parts.length - 1)) return null;
    }
    return name;
  }

  /**
   * What to write, or a thrown refusal. `current` is the running manifest ({name, version}).
   * Returns { manifest, files: [{ name, entry }] } with manifest.json last.
   */
  async function plan(entries, current) {
    var files = [], total = 0, seen = {};
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.dir) continue;
      var p = safePath(e.name);
      if (!p) throw fail("path", "unsafe path in release: " + e.name);
      if (seen[p]) throw fail("path", "duplicate entry: " + p);
      seen[p] = true;
      if (/\.(?:exe|dll|bat|cmd|sh|command|app)$/i.test(p)) throw fail("path", "unexpected file type: " + p);
      total += e.size;
      if (total > MAX_TOTAL) throw fail("zip", "release is too large");
      files.push({ name: p, entry: e });
    }
    var mf = files.filter(function (f) { return f.name === "manifest.json"; })[0];
    if (!mf) throw fail("manifest", "release has no manifest.json at its root");
    var manifest;
    try { manifest = JSON.parse(td.decode(await mf.entry.read())); } catch (x) { throw fail("manifest", "manifest.json is not valid JSON"); }
    if (manifest.manifest_version !== 3) throw fail("manifest", "not a manifest v3 extension");
    if (current && current.name && manifest.name !== current.name) throw fail("manifest", "this release is a different extension");
    if (typeof manifest.version !== "string" || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) throw fail("manifest", "release has no usable version");
    if (current && current.version && compareVersions(manifest.version, current.version) <= 0) {
      throw fail("version", "release " + manifest.version + " is not newer than " + current.version);
    }
    files.sort(function (a, b) { return (a.name === "manifest.json") - (b.name === "manifest.json"); });
    return { manifest: manifest, files: files };
  }

  return { verify: verify, readZip: readZip, plan: plan, safePath: safePath, compareVersions: compareVersions, b64decode: b64decode };
});
