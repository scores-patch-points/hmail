/*
 * hyphae drive — sealing a Drive in place, verifying it, and undoing it.
 *
 *   var engine = HyDriveSweep.create({ client, circle, circles?, store?, catalog?, onProgress? });
 *   engine.sweep({ folderId?, dryRun?, purge?, ... })   walk, seal, verify, report
 *   engine.sealOne(file, opts) / engine.unsealOne(id) / engine.purgeOne(id) / engine.readSealed(id)
 *
 * The order of operations for one file, in the default "inplace" mode:
 *
 *   1  classify   (never touches a file that is a folder, a native Google file,
 *                  already sealed, not ours, shared, or not editable)
 *   2  read       stream the original down, hashing it as it goes
 *   3  seal+send  seal each chunk and push it into a resumable upload that
 *                  CANNOT commit until the last bytes are sent
 *   4  check      the downloaded bytes match Drive's own checksum and size,
 *                  and the file's version did not move while we worked;
 *                  otherwise abort — Drive was never written to
 *   5  commit     the last chunk lands: same file id (shares and links
 *                  survive), new content, the old content becomes the
 *                  previous revision
 *   6  read back  download the sealed head, open it with the key, compare the
 *                  plaintext identity with step 2. On failure: restore the
 *                  previous revision into the head and report.
 *   7  purge      ONLY if asked, ONLY now: delete the older plaintext
 *                  revisions. Until then the plaintext is still on Drive.
 *
 * Idempotent: sealed files carry properties { hysealed: "1", hykid } and the
 * sealed magic, either of which makes the file ineligible; a run killed
 * between steps 5 and 6 is found in the ledger and verified on the next run.
 *
 * Worker/offscreen/Node only: it is handed a circle key.
 */
(function (root, factory) {
  var seal = root.HyDriveSeal, hash = root.HyHash;
  if (!seal && typeof require === "function") seal = require("./seal.js");
  if (!hash && typeof require === "function") hash = require("./hash.js");
  var api = factory(seal, hash);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HyDriveSweep = api;
})(typeof self !== "undefined" ? self : globalThis, function (Seal, HyHash) {
  "use strict";

  var FOLDER = "application/vnd.google-apps.folder";
  var SHORTCUT = "application/vnd.google-apps.shortcut";
  var NATIVE_PREFIX = "application/vnd.google-apps.";
  var P_SEALED = "hysealed", P_KID = "hykid", P_INDEX = "hyindex", P_MD5 = "hymd5";
  var EXPORTS = {
    "application/vnd.google-apps.document": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx" },
    "application/vnd.google-apps.spreadsheet": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" },
    "application/vnd.google-apps.presentation": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: ".pptx" },
    "application/vnd.google-apps.drawing": { mime: "image/png", ext: ".png" },
  };
  var DEFAULTS = {
    mode: "inplace",          // "inplace" | "sibling"
    names: "opaque",          // "opaque" | "suffix" | "keep"
    purge: false,             // delete older plaintext revisions / the original after read-back
    dryRun: false,
    includeShared: false,
    includeNotOwned: false,
    native: "skip",           // "skip" | "export-copy"
    trashOriginal: false,     // export-copy: trash the native original once the sealed copy is verified
    maxBytes: 4 * 1024 * 1024 * 1024,
    chunkSize: Seal.DEFAULT_CHUNK,
    uploadChunk: 8 * 1024 * 1024,
    concurrency: 1,
    maxAttempts: 3,
    retryFailed: false,
    maxFiles: Infinity,
    order: "small-first",
    sniff: true,
    exclude: null,            // function(file) -> true to skip
    folderId: null,
    signal: null,
  };

  function fail(code, msg, extra) {
    var e = new Error("drive sweep: " + msg);
    e.code = code;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }
  function merge(base, over) {
    var o = {};
    Object.keys(base).forEach(function (k) { o[k] = base[k]; });
    Object.keys(over || {}).forEach(function (k) { if (over[k] !== undefined) o[k] = over[k]; });
    return o;
  }
  function noop() {}

  // ---- storage adapters ---------------------------------------------------------
  function memoryStorage() {
    var m = {};
    return {
      get: function (k) { return Promise.resolve(m[k] === undefined ? undefined : JSON.parse(JSON.stringify(m[k]))); },
      set: function (k, v) { m[k] = JSON.parse(JSON.stringify(v)); return Promise.resolve(); },
    };
  }
  /** Wrap chrome.storage.local (or any area with promise get/set). */
  function chromeStorageAdapter(area) {
    return {
      get: function (k) { return area.get(k).then(function (r) { return r[k]; }); },
      set: function (k, v) { var o = {}; o[k] = v; return area.set(o); },
    };
  }

  // ---- ledger -------------------------------------------------------------------
  /**
   * Progress and resume state, kept by file id only (no names). One record per
   * Google account. States: committing (new content sent, not yet read back),
   * verified, purged, failed, skipped, unsealed.
   */
  function createLedger(storage, accountKey) {
    var key = "hyphae.drive.v1." + accountKey;
    var data = null, dirty = 0;
    return {
      key: key,
      load: async function () {
        var d = storage ? await storage.get(key) : null;
        data = (d && d.v === 1) ? d : { v: 1, files: {}, meta: {} };
        return data;
      },
      get: function (id) { return data.files[id] || null; },
      set: async function (id, patch) {
        var cur = data.files[id] || {};
        Object.keys(patch).forEach(function (k) { cur[k] = patch[k]; });
        cur.t = Date.now();
        data.files[id] = cur;
        if (++dirty >= 20) await this.flush();
      },
      meta: function (k, v) { if (v === undefined) return data.meta[k]; data.meta[k] = v; dirty++; return v; },
      flush: async function () { dirty = 0; if (storage) await storage.set(key, data); },
      ids: function () { return Object.keys(data.files); },
      counts: function () {
        var c = {};
        Object.keys(data.files).forEach(function (k) { var s = data.files[k].s; c[s] = (c[s] || 0) + 1; });
        return c;
      },
    };
  }

  // ---- the engine ----------------------------------------------------------------
  function create(deps) {
    var client = deps.client;
    var circle = deps.circle;
    if (!circle) throw new Error("drive sweep: a circle is required");
    var circles = deps.circles || (function () { var m = {}; m[circle.kid] = circle; return m; })();
    if (!circles[circle.kid]) circles[circle.kid] = circle;
    var storage = deps.store || null;
    var catalog = deps.catalog || null;
    var onProgress = deps.onProgress || noop;
    var ledger = null;

    async function ready() {
      if (ledger) return ledger;
      var key = deps.accountKey;
      if (!key) {
        try { key = (await client.about()).user.permissionId; } catch (e) { key = "default"; }
      }
      ledger = createLedger(storage, key);
      await ledger.load();
      return ledger;
    }

    // ---- classification -----------------------------------------------------------
    /** { eligible, reason, exportMime? } for a file resource. Pure. */
    function classify(f, o) {
      o = o || DEFAULTS;
      var props = f.properties || {};
      if (f.mimeType === FOLDER) return { eligible: false, reason: "folder" };
      if (f.mimeType === SHORTCUT) return { eligible: false, reason: "shortcut" };
      if (f.trashed) return { eligible: false, reason: "trashed" };
      if (props[P_INDEX] === "1") return { eligible: false, reason: "own-index" };
      // A sealed mark is trusted only while the content is the content we sealed: if the
      // head's md5 no longer matches the one recorded at seal time (a new plaintext version
      // was uploaded onto the file), the mark is stale and the file is eligible again.
      var stale = false;
      if (props[P_SEALED] === "1") {
        if (props[P_MD5] && f.md5Checksum && props[P_MD5] !== f.md5Checksum) stale = true;
        else return { eligible: false, reason: "already-sealed" };
      }
      if (f.ownedByMe === false && !o.includeNotOwned) return { eligible: false, reason: "not-owner" };
      if (f.shared === true && !o.includeShared) return { eligible: false, reason: "shared" };
      var native = f.mimeType && f.mimeType.indexOf(NATIVE_PREFIX) === 0;
      if (native) {
        if (o.native !== "export-copy") return { eligible: false, reason: "native-google-file" };
        if (!EXPORTS[f.mimeType]) return { eligible: false, reason: "native-unsupported" };
        if (f.ownedByMe === false && !o.includeNotOwned) return { eligible: false, reason: "not-owner" };
        return { eligible: true, reason: "export-copy", exportMime: EXPORTS[f.mimeType].mime, ext: EXPORTS[f.mimeType].ext };
      }
      if (f.size === undefined || f.size === null) return { eligible: false, reason: "no-content" };
      if (f.contentRestrictions && f.contentRestrictions.some(function (r) { return r && r.readOnly; })) return { eligible: false, reason: "content-restricted" };
      if (o.mode === "inplace" && f.capabilities && f.capabilities.canEdit === false) return { eligible: false, reason: "no-edit-permission" };
      if (Number(f.size) > o.maxBytes) return { eligible: false, reason: "too-large" };
      if (typeof o.exclude === "function" && o.exclude(f)) return { eligible: false, reason: "excluded" };
      return { eligible: true, reason: stale ? "reseal" : "ok" };
    }

    function sealedName(f, o, ext) {
      if (o.names === "keep") return f.name;
      if (o.names === "suffix") return f.name + (ext || "") + ".hyd";
      return Seal.randomName();
    }

    function sealProps(kid, extra) {
      var p = {}; p[P_SEALED] = "1"; p[P_KID] = kid;
      if (extra) Object.keys(extra).forEach(function (k) { p[k] = extra[k]; });
      return p;
    }

    // ---- read-back --------------------------------------------------------------------
    /** Download the file's current content and open it; returns the manifest or throws. */
    async function readBack(id) {
      var opener = Seal.createOpener(circles);
      await client.downloadTo(id, async function (u8) { await opener.write(u8); });
      return opener.end();
    }

    // ---- the seal pipeline ------------------------------------------------------------
    /**
     * source: { size, pump(onChunk), expect: {sha256?, md5?}, guard?() }
     * target: { fileId? | parents, metadata }
     * Returns { file, manifest, checks[], uploader }. Throws before anything is
     * committed on any mismatch.
     */
    async function sealPipeline(meta, source, target, o, beforeCommit) {
      var metaBytes = Seal.encodeMeta(meta);
      var total = Seal.sealedSize(source.size, metaBytes.length, o.chunkSize);
      var sealer = await Seal.createSealer(circle, metaBytes, { chunkSize: o.chunkSize });
      var uploader = null, head = [], headLen = 0, got = 0;

      async function ensureUploader() {
        if (uploader) return;
        uploader = await client.startUpload({
          fileId: target.fileId, parents: target.parents, metadata: target.metadata,
          totalSize: total, contentType: "application/octet-stream", chunkSize: o.uploadChunk,
        });
      }
      async function feed(u8) {
        var parts = await sealer.write(u8);
        for (var i = 0; i < parts.length; i++) await uploader.write(parts[i]);
      }
      try {
        await source.pump(async function (u8) {
          got += u8.length;
          if (got > source.size) throw fail("source-integrity", "source delivered more bytes than its size");
          if (!uploader) {
            head.push(u8); headLen += u8.length;
            if (headLen < Seal.HEADER_LEN && got < source.size) return;
            var first = Seal.concat(head); head = null;
            if (Seal.isSealed(first)) throw fail("already-sealed", "content is already sealed (unmarked)");
            await ensureUploader();
            await feed(first);
          } else {
            await feed(u8);
          }
        });
        if (got !== source.size) throw fail("source-integrity", "source delivered " + got + " of " + source.size + " bytes");
        if (!uploader) {
          await ensureUploader();
          if (head && headLen) await feed(Seal.concat(head));
        }
        var tail = await sealer.end();
        var mf = sealer.manifest, checks = ["size"];
        if (source.expect && source.expect.sha256) {
          if (mf.sha256 !== source.expect.sha256) throw fail("source-integrity", "downloaded bytes do not match Drive's sha256");
          checks.push("sha256");
        } else if (source.expect && source.expect.md5) {
          if (mf.md5 !== source.expect.md5) throw fail("source-integrity", "downloaded bytes do not match Drive's md5");
          checks.push("md5");
        }
        if (source.guard) await source.guard();
        for (var i = 0; i < tail.length; i++) await uploader.write(tail[i]);
        if (beforeCommit) await beforeCommit();
        var file = await uploader.finish();
        return { file: file, manifest: mf, checks: checks, uploader: uploader, total: total };
      } catch (e) {
        if (uploader) { try { await uploader.abort(); } catch (x) { /* nothing to undo */ } }
        throw e;
      }
    }

    // ---- sealOne ----------------------------------------------------------------------
    /**
     * Seal one file. Returns a result { id, state, reason?, ... }; typed
     * failures are returned (state "failed"), only programmer errors throw.
     */
    async function sealOne(file, opts, ctx) {
      var o = merge(DEFAULTS, opts);
      var L = await ready();
      ctx = ctx || {};
      var id = file.id || file;
      var f;
      try { f = await client.get(id); }
      catch (e) { return { id: id, state: "failed", reason: e.code || "error", message: e.message }; }
      var c = classify(f, o);
      if (!c.eligible) return { id: id, state: "skipped", reason: c.reason };

      var isExport = c.reason === "export-copy";
      var mode = isExport ? "sibling" : o.mode;
      var startHead = f.headRevisionId || null;
      var newName = sealedName(f, o, c.ext);
      var meta = { name: isExport ? f.name + c.ext : f.name, mime: isExport ? c.exportMime : f.mimeType, size: undefined, mtime: f.modifiedTime, id: f.id, path: ctx.path };
      var source;

      if (isExport) {
        var bytes;
        try {
          var resp = await client.exportFile(id, c.exportMime);
          var parts = [], n = 0;
          await client.pump(resp, function (u8) { parts.push(u8); n += u8.length; });
          bytes = new Uint8Array(n);
          var p = 0; parts.forEach(function (x) { bytes.set(x, p); p += x.length; });
        } catch (e) { return { id: id, state: "failed", reason: e.code || "error", message: e.message }; }
        meta.size = bytes.length;
        source = { size: bytes.length, expect: null, pump: async function (cb) { await cb(bytes); } };
      } else {
        meta.size = Number(f.size);
        source = {
          size: Number(f.size),
          expect: { sha256: f.sha256Checksum || null, md5: f.md5Checksum || null },
          pump: function (cb) { return client.downloadTo(id, cb); },
          guard: async function () {
            var g = await client.get(id, "version,headRevisionId,md5Checksum,modifiedTime,trashed");
            if (g.trashed || String(g.version) !== String(f.version) || (f.headRevisionId && g.headRevisionId !== f.headRevisionId)) {
              throw fail("changed-during-seal", "the file changed while it was being sealed");
            }
          },
        };
      }

      var target = mode === "inplace"
        ? { fileId: id, metadata: { name: newName, mimeType: "application/octet-stream", properties: sealProps(circle.kid) } }
        : { parents: f.parents, metadata: { name: newName, mimeType: "application/octet-stream", properties: sealProps(circle.kid, { hysrc: id }) } };

      if (o.dryRun) {
        return { id: id, state: "would-seal", mode: mode, bytes: source.size, name: f.name, newName: newName, native: isExport };
      }

      var attempts = ((L.get(id) || {}).n || 0) + 1;
      var res;
      try {
        res = await sealPipeline(meta, source, target, o, async function () {
          await L.set(id, { s: "committing", n: attempts, k: circle.kid });
          await L.flush();
        });
      } catch (e) {
        if (e.code === "already-sealed") {
          // Sealed by something that did not mark it. Adopt: mark it so the next scan is free.
          if (mode === "inplace") {
            try { var kid = Seal.parseHeader(await firstBytes(id)).kid; await client.patch(id, { properties: sealProps(kid) }); } catch (x) { /* best effort */ }
          }
          await L.set(id, { s: "skipped", r: "already-sealed", n: attempts });
          return { id: id, state: "skipped", reason: "already-sealed" };
        }
        await L.set(id, { s: "failed", r: e.code || "error", n: attempts });
        return { id: id, state: "failed", reason: e.code || "error", message: e.message };
      }

      // --- committed: now prove it ---
      var newId = res.file.id;
      var verifyErr = null, mf = null;
      try {
        if (String(res.file.size) !== String(res.total)) throw fail("verify-failed", "Drive reports size " + res.file.size + ", sent " + res.total);
        if (res.file.sha256Checksum && res.file.sha256Checksum !== res.uploader.sha256()) throw fail("verify-failed", "Drive's sha256 of the sealed upload differs from what was sent");
        if (!res.file.sha256Checksum && res.file.md5Checksum && res.file.md5Checksum !== res.uploader.md5()) throw fail("verify-failed", "Drive's md5 of the sealed upload differs from what was sent");
        mf = await readBack(newId);
        if (mf.sha256 !== res.manifest.sha256 || mf.size !== res.manifest.size) throw fail("verify-failed", "read-back plaintext differs from the original");
      } catch (e) { verifyErr = e; }

      if (verifyErr) {
        var rolled = false;
        try {
          if (mode === "inplace" && startHead) rolled = await rollback(id, startHead, f);
          else if (mode === "sibling") { await client.trash(newId); rolled = true; }
        } catch (x) { rolled = false; }
        await L.set(id, { s: "failed", r: rolled ? "verify-failed-rolled-back" : "verify-failed-ROLLBACK-FAILED", n: attempts });
        return { id: id, state: "failed", reason: rolled ? "verify-failed" : "rollback-failed", message: verifyErr.message, rolledBack: rolled };
      }

      // remember which content we sealed, so a later plaintext upload onto this file is noticed
      var sealedMd5 = res.file.md5Checksum || res.uploader.md5();
      try { var mp = {}; mp[P_MD5] = sealedMd5; await client.patch(newId, { properties: mp }); } catch (e) { /* the mark still stands without it */ }
      var out = { id: id, newId: newId, state: "verified", mode: mode, bytes: source.size, checks: res.checks.concat(["readback"]), name: f.name, newName: newName, plaintextRetained: true };
      await L.set(id, { s: "verified", n: attempts, k: circle.kid, b: source.size, sid: newId });
      if (catalog) catalog.set(newId, { n: meta.name, t: meta.mime, s: source.size, m: f.modifiedTime, p: ctx.path || "" });

      // --- the only irreversible step, and only on request ---
      var removeOriginal = mode === "sibling" && (!isExport || o.trashOriginal);
      try {
        if (removeOriginal) {
          if (o.purge) { await client.deletePermanently(id); out.purged = 1; out.plaintextRetained = false; }
          else { await client.trash(id); out.trashed = true; }      // still in the trash, still plaintext
        } else if (mode === "inplace" && o.purge) {
          out.purged = await purgeRevisions(newId, mf);
          out.plaintextRetained = false;
        } else if (isExport) {
          out.note = "native original left in place";
        }
        if (out.purged) await L.set(id, { s: "purged" });
      } catch (e) { out.purgeError = e.message; }
      return out;
    }

    async function firstBytes(id) {
      var r = await client.download(id, { range: "bytes=0-" + (Seal.HEADER_LEN - 1) });
      return new Uint8Array(await r.arrayBuffer());
    }

    /** Put revision `revId` back as the head content, restoring name and type. */
    async function rollback(id, revId, original) {
      var rev = (await client.revisions(id)).filter(function (r) { return r.id === revId; })[0];
      if (!rev) return false;
      var size = Number(rev.size);
      var up = await client.startUpload({
        fileId: id, totalSize: size, chunkSize: DEFAULTS.uploadChunk,
        contentType: original.mimeType,
        metadata: { name: original.name, mimeType: original.mimeType, properties: (function () { var p = {}; p[P_SEALED] = null; p[P_KID] = null; p[P_MD5] = null; return p; })() },
      });
      var h = HyHash.md5(), n = 0;
      try {
        await client.downloadTo(id, async function (u8) { h.update(u8); n += u8.length; await up.write(u8); }, { revisionId: revId });
        if (n !== size || (rev.md5Checksum && HyHash.hex(h.digest()) !== rev.md5Checksum)) { await up.abort(); return false; }
        await up.finish();
        return true;
      } catch (e) { await up.abort(); return false; }
    }

    // ---- purge --------------------------------------------------------------------------
    /** Delete every non-head revision of an already-verified sealed file. */
    async function purgeRevisions(id, manifest) {
      var f = await client.get(id, "id,headRevisionId,properties");
      if (!f.properties || f.properties[P_SEALED] !== "1") throw fail("not-sealed", "refusing to purge a file that is not marked sealed");
      var revs = await client.revisions(id);
      if (revs.length < 2) return 0;
      var headIdx = -1;
      revs.forEach(function (r, i) { if (r.id === f.headRevisionId) headIdx = i; });
      if (headIdx < 0) throw fail("purge-refused", "cannot find the head revision");
      // The revision just before the head is the content we sealed: its md5 must be the plaintext's.
      if (headIdx > 0) {
        var prev = revs[headIdx - 1];
        if (!prev.md5Checksum || prev.md5Checksum !== manifest.md5) throw fail("purge-refused", "previous revision does not match the sealed plaintext");
      }
      var n = 0;
      for (var i = 0; i < revs.length; i++) {
        if (i === headIdx) continue;
        if (revs[i].keepForever) { try { await client.unpinRevision(id, revs[i].id); } catch (e) { /* try delete anyway */ } }
        await client.deleteRevision(id, revs[i].id);
        n++;
      }
      return n;
    }

    /**
     * Purge as its own step, any time after sealing: re-verifies by reading the
     * sealed head back and matching it to the revision it replaced.
     */
    async function purgeOne(id) {
      var L = await ready();
      var mf;
      try { mf = await readBack(id); }
      catch (e) { return { id: id, state: "failed", reason: "purge-refused", message: "sealed head does not open: " + e.message }; }
      try {
        var n = await purgeRevisions(id, mf);
        await L.set(id, { s: "purged" });
        return { id: id, state: "purged", purged: n };
      } catch (e) {
        return { id: id, state: "failed", reason: e.code || "error", message: e.message };
      }
    }

    // ---- unseal ---------------------------------------------------------------------------
    /** Open one sealed file in memory: { meta, bytes, manifest }. For previews and exports. */
    async function readSealed(id) {
      var opener = Seal.createOpener(circles), parts = [];
      await client.downloadTo(id, async function (u8) { var out = await opener.write(u8); for (var i = 0; i < out.length; i++) parts.push(out[i]); });
      var manifest = await opener.end();
      return { meta: opener.meta, bytes: Seal.concat(parts), manifest: manifest };
    }

    /** Undo sealing for one file: plaintext goes back into the same file id, name and type restored. */
    async function unsealOne(id, opts) {
      var o = merge(DEFAULTS, opts);
      var L = await ready();
      var f;
      try { f = await client.get(id); } catch (e) { return { id: id, state: "failed", reason: e.code || "error", message: e.message }; }
      if (!f.properties || f.properties[P_SEALED] !== "1") return { id: id, state: "skipped", reason: "not-sealed" };
      if (f.capabilities && f.capabilities.canEdit === false) return { id: id, state: "skipped", reason: "no-edit-permission" };
      if (o.dryRun) return { id: id, state: "would-unseal" };

      var opener = Seal.createOpener(circles), uploader = null, pendingPlain = [], written = 0;
      async function emit(list) {
        for (var i = 0; i < list.length; i++) {
          written += list[i].length;
          if (!uploader) pendingPlain.push(list[i]); else await uploader.write(list[i]);
        }
      }
      async function ensure() {
        if (uploader || !opener.meta) return;
        if (typeof opener.meta.size !== "number") throw fail("no-size", "sealed file does not record its size");
        var props = {}; props[P_SEALED] = null; props[P_KID] = null; props[P_MD5] = null;
        uploader = await client.startUpload({
          fileId: id, totalSize: opener.meta.size, chunkSize: o.uploadChunk,
          contentType: opener.meta.mime || "application/octet-stream",
          metadata: { name: opener.meta.name || f.name, mimeType: opener.meta.mime || "application/octet-stream", properties: props },
        });
        var held = pendingPlain; pendingPlain = [];
        for (var i = 0; i < held.length; i++) await uploader.write(held[i]);
      }
      try {
        await client.downloadTo(id, async function (u8) {
          var out = await opener.write(u8);
          await ensure();
          await emit(out);
        });
        var mf = await opener.end();           // the file is authenticated end to end only now
        await ensure();
        if (written !== mf.size || (typeof opener.meta.size === "number" && opener.meta.size !== mf.size)) throw fail("manifest", "recorded size disagrees with the content");
        if (!uploader) throw fail("manifest", "nothing to write");
        var file = await uploader.finish();
        if (file.sha256Checksum && file.sha256Checksum !== mf.sha256) throw fail("verify-failed", "restored content checksum differs");
        if (!file.sha256Checksum && file.md5Checksum && file.md5Checksum !== mf.md5) throw fail("verify-failed", "restored content checksum differs");
        await L.set(id, { s: "unsealed" });
        if (catalog) catalog.remove(id);
        return { id: id, state: "unsealed", name: opener.meta.name, bytes: mf.size };
      } catch (e) {
        if (uploader) { try { await uploader.abort(); } catch (x) { /* nothing committed */ } }
        return { id: id, state: "failed", reason: e.code || "error", message: e.message };
      }
    }

    // ---- sweeping ---------------------------------------------------------------------------
    async function enumerate(o, visit) {
      var owned = o.includeNotOwned ? "" : "'me' in owners and ";
      if (o.folderId) {
        var queue = [{ id: o.folderId, path: "" }];
        while (queue.length) {
          var node = queue.shift();
          await client.listAll({ q: "'" + client.esc(node.id) + "' in parents and trashed = false" }, async function (f) {
            if (f.mimeType === FOLDER) queue.push({ id: f.id, path: node.path + "/" + f.name });
            else return visit(f, node.path);
          });
        }
      } else {
        await client.listAll({ q: owned + "trashed = false and mimeType != '" + FOLDER + "'" }, function (f) { return visit(f, null); });
      }
    }

    /** Verify files a previous run committed but never read back. */
    async function recoverPending(o, report) {
      var L = await ready();
      var ids = L.ids().filter(function (k) { return L.get(k).s === "committing"; });
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i], f;
        try { f = await client.get(id); } catch (e) { if (!o.dryRun) await L.set(id, { s: "failed", r: e.code || "error" }); continue; }
        if (!f.properties || f.properties[P_SEALED] !== "1") { if (!o.dryRun) await L.set(id, { s: "pending" }); continue; }
        if (o.dryRun) { report.recovered = (report.recovered || 0) + 1; continue; }
        try {
          var mf = await readBack(id);
          var revs = await client.revisions(id), head = -1;
          revs.forEach(function (r, k) { if (r.id === f.headRevisionId) head = k; });
          if (head > 0 && revs[head - 1].md5Checksum && revs[head - 1].md5Checksum !== mf.md5) throw fail("verify-failed", "sealed head does not match the revision it replaced");
          await L.set(id, { s: "verified", k: mf.kid, b: mf.size });
          report.recovered = (report.recovered || 0) + 1;
          if (o.purge) { var n = await purgeRevisions(id, mf); if (n) { await L.set(id, { s: "purged" }); report.purged += n; } }
        } catch (e) {
          await L.set(id, { s: "failed", r: "recover-" + (e.code || "error") });
          report.failed.push({ id: id, reason: "recover-" + (e.code || "error"), message: e.message });
        }
      }
    }

    function bump(map, k) { map[k] = (map[k] || 0) + 1; }

    function newReport(o) {
      return {
        startedAt: new Date().toISOString(), finishedAt: null, dryRun: !!o.dryRun, mode: o.mode, names: o.names, purge: !!o.purge,
        scanned: 0, candidates: 0, sealed: 0, verified: 0, purged: 0, skipped: {}, failed: [], bytes: 0,
        plan: o.dryRun ? [] : undefined, retainedPlaintext: 0, aborted: null, notes: [],
      };
    }

    /** Classify listed files; returns candidates the ledger doesn't rule out. */
    async function toCandidates(files, o, report) {
      var L = await ready(), cands = [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i].f || files[i], path = files[i].path === undefined ? null : files[i].path;
        report.scanned++;
        var c = classify(f, o);
        if (!c.eligible) { bump(report.skipped, c.reason); continue; }
        var led = L.get(f.id);
        if (led && led.s === "failed" && (led.n || 0) >= o.maxAttempts && !o.retryFailed) { bump(report.skipped, "gave-up"); continue; }
        cands.push({ id: f.id, size: Number(f.size || 0), name: f.name, path: path, mime: f.mimeType, f: f });
      }
      return cands;
    }

    /** Seal a list of candidates, verifying each; fills `report`. */
    async function runCandidates(cands, o, report) {
      var L = await ready();
      if (o.order === "small-first") cands.sort(function (a, b) { return a.size - b.size; });
      if (cands.length > o.maxFiles) cands = cands.slice(0, o.maxFiles);
      report.candidates += cands.length;

      if (o.dryRun && o.sniff) {
        // Files already sealed by something that didn't mark them: cheap 62-byte read each.
        var keep = [];
        for (var s = 0; s < cands.length; s++) {
          var cd = cands[s];
          if (cd.size >= Seal.HEADER_LEN && (cd.mime || "").indexOf(NATIVE_PREFIX) !== 0) {
            try { if (Seal.isSealed(await firstBytes(cd.id))) { bump(report.skipped, "already-sealed"); report.candidates--; continue; } } catch (e) { /* treat as eligible */ }
          }
          keep.push(cd);
        }
        cands = keep;
      }

      var stopped = false;
      async function one(cd) {
        if (stopped) return;
        if (o.signal && o.signal.aborted) { stopped = true; report.aborted = "cancelled"; return; }
        var r = o.dryRun
          ? { id: cd.id, state: "would-seal", bytes: cd.size, name: cd.name, newName: sealedName(cd.f, o), native: (cd.mime || "").indexOf(NATIVE_PREFIX) === 0 }
          : await sealOne(cd.id, o, { path: cd.path });
        onProgress({ type: "file", id: cd.id, state: r.state, reason: r.reason, bytes: r.bytes });
        if (r.state === "would-seal") { report.plan.push({ id: r.id, name: r.name, bytes: r.bytes, newName: r.newName, native: r.native }); report.bytes += r.bytes || 0; }
        else if (r.state === "verified") {
          report.sealed++; report.verified++; report.bytes += r.bytes || 0;
          if (r.purged) report.purged += r.purged;
          if (r.plaintextRetained) report.retainedPlaintext++;
        } else if (r.state === "skipped") bump(report.skipped, r.reason);
        else if (r.state === "failed") {
          report.failed.push({ id: r.id, reason: r.reason, message: r.message });
          if (r.reason === "quota" || r.reason === "auth" || r.reason === "rollback-failed") { stopped = true; report.aborted = r.reason; }
        }
      }
      var next = 0;
      async function worker() {
        while (!stopped) {
          var k = next++;
          if (k >= cands.length) return;
          await one(cands[k]);
        }
      }
      var workers = [];
      for (var w = 0; w < Math.max(1, o.concurrency); w++) workers.push(worker());
      await Promise.all(workers);
      return report;
    }

    async function finishReport(o, report) {
      var L = await ready();
      if (!o.dryRun) {
        L.meta("lastSweepAt", Date.now());
        await L.flush();
        if (catalog) { try { await catalog.save(); } catch (e) { report.notes.push("index not saved: " + e.message); } }
      } else {
        report.estimate = { bytesToSeal: report.bytes, extraStorageUntilPurge: o.purge ? 0 : report.bytes };
      }
      if (report.retainedPlaintext) report.notes.push(report.retainedPlaintext + " file(s) still have their plaintext on Drive (an older revision, the trash, or the native original) until purged or removed");
      report.finishedAt = new Date().toISOString();
      onProgress({ type: "done", report: report });
      return report;
    }

    /** Walk the scope, seal, verify. Returns the report. */
    async function sweep(opts) {
      var o = merge(DEFAULTS, opts);
      var report = newReport(o);
      await recoverPending(o, report);
      var listed = [];
      await enumerate(o, async function (f, path) {
        listed.push({ f: f, path: path });
        if (listed.length % 200 === 0) onProgress({ type: "scan", scanned: listed.length });
      });
      var cands = await toCandidates(listed, o, report);
      await runCandidates(cands, o, report);
      return finishReport(o, report);
    }

    /** Seal a given set of file resources (the changes feed, or a retry list). Same report shape. */
    async function sweepFiles(files, opts) {
      var o = merge(DEFAULTS, opts);
      var report = newReport(o);
      await recoverPending(o, report);
      var cands = await toCandidates(files, o, report);
      await runCandidates(cands, o, report);
      return finishReport(o, report);
    }

    /** Undo: unseal every sealed file under a folder (or the whole Drive). */
    async function unsealAll(opts) {
      var o = merge(DEFAULTS, opts);
      var report = { unsealed: 0, skipped: {}, failed: [], scanned: 0 };
      var ids = [];
      var owned = o.includeNotOwned ? "" : "'me' in owners and ";
      var q = owned + "trashed = false and properties has { key='" + P_SEALED + "' and value='1' }";
      await client.listAll({ q: q }, function (f) { report.scanned++; if (f.properties && f.properties[P_INDEX] !== "1") ids.push(f.id); });
      for (var i = 0; i < ids.length; i++) {
        if (o.signal && o.signal.aborted) break;
        var r = await unsealOne(ids[i], o);
        if (r.state === "unsealed") report.unsealed++;
        else if (r.state === "skipped") bump(report.skipped, r.reason);
        else report.failed.push({ id: r.id, reason: r.reason, message: r.message });
      }
      var L = await ready(); await L.flush();
      if (catalog) { try { await catalog.save(); } catch (e) { /* index is rebuildable */ } }
      return report;
    }

    /** Purge every verified file the ledger knows about that still keeps plaintext revisions. */
    async function purgeAll(opts) {
      var L = await ready();
      var ids = L.ids().filter(function (k) { return L.get(k).s === "verified"; });
      var report = { purged: 0, failed: [] };
      for (var i = 0; i < ids.length; i++) {
        var sid = L.get(ids[i]).sid || ids[i];
        var r = await purgeOne(sid);
        if (r.state === "purged") { report.purged += r.purged; await L.set(ids[i], { s: "purged" }); }
        else report.failed.push({ id: sid, reason: r.reason, message: r.message });
      }
      await L.flush();
      return report;
    }

    return {
      classify: classify, sealOne: sealOne, unsealOne: unsealOne, readSealed: readSealed, purgeOne: purgeOne,
      sweep: sweep, sweepFiles: sweepFiles, unsealAll: unsealAll, purgeAll: purgeAll, readBack: readBack, ledger: ready,
      DEFAULTS: DEFAULTS,
    };
  }

  return {
    create: create, createLedger: createLedger, memoryStorage: memoryStorage, chromeStorageAdapter: chromeStorageAdapter,
    DEFAULTS: DEFAULTS, EXPORTS: EXPORTS, P_SEALED: P_SEALED, P_KID: P_KID, P_INDEX: P_INDEX,
  };
});
