/*
 * hyphae drive — the sealed name index.
 *
 * Sealed files carry opaque display names ("hy-….hyd"), so the Drive UI cannot
 * tell you which is which. The real name, type, size and time live inside each
 * file's own sealed META record — that is the source of truth — and this
 * catalog is a convenience: one sealed file, found by a property, mapping
 * Drive file id -> { n: name, t: type, s: size, m: mtime, p: folder path }.
 *
 * It is a cache. Losing it loses no names: rebuild() re-reads each sealed
 * file's first record (a ranged request of ~1 KiB). It is sealed with the same
 * circle key as the files, as a hyd1 blob, so Google sees one more opaque file.
 *
 * Worker/offscreen/Node only.
 */
(function (root, factory) {
  var seal = root.HyDriveSeal;
  if (!seal && typeof require === "function") seal = require("./seal.js");
  var api = factory(seal);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HyDriveCatalog = api;
})(typeof self !== "undefined" ? self : globalThis, function (Seal) {
  "use strict";

  var P_INDEX = "hyindex", P_SEALED = "hysealed", P_KID = "hykid";
  var enc = new TextEncoder(), dec = new TextDecoder();

  /** Read just a sealed file's META record with ranged requests. Returns the meta object or null. */
  async function readMeta(client, circles, id) {
    var first = new Uint8Array(await (await client.download(id, { range: "bytes=0-1023" })).arrayBuffer());
    if (!Seal.isSealed(first) || first.length < Seal.HEADER_LEN + 4) return null;
    var w = ((first[62] << 24) | (first[63] << 16) | (first[64] << 8) | first[65]) >>> 0;
    var need = Seal.HEADER_LEN + 4 + (w & 0x7fffffff);
    if (need > 1024 && need < 70000) {
      first = new Uint8Array(await (await client.download(id, { range: "bytes=0-" + (need - 1) })).arrayBuffer());
    }
    var o = Seal.createOpener(circles);
    try { await o.write(first); } catch (e) { return null; }
    return o.meta || null;
  }

  function create(deps) {
    var client = deps.client, circle = deps.circle;
    var circles = deps.circles || (function () { var m = {}; m[circle.kid] = circle; return m; })();
    var parentId = deps.parentId || "root";
    var entries = {}, fileId = null, dirty = false;

    var cat = {
      get: function (id) { return entries[id] || null; },
      set: function (id, e) { entries[id] = e; dirty = true; },
      remove: function (id) { if (entries[id]) { delete entries[id]; dirty = true; } },
      entries: function () { return entries; },
      size: function () { return Object.keys(entries).length; },
      fileId: function () { return fileId; },

      /** Load the index file if there is one. Returns the number of entries. */
      load: async function () {
        var found = await client.findByProperty(P_INDEX, "1");
        found.sort(function (a, b) { return a.modifiedTime < b.modifiedTime ? 1 : -1; });
        for (var i = 0; i < found.length; i++) {
          try {
            var chunks = [];
            var o = Seal.createOpener(circles);
            await client.downloadTo(found[i].id, async function (u8) { var out = await o.write(u8); for (var k = 0; k < out.length; k++) chunks.push(out[k]); });
            await o.end();
            var j = JSON.parse(dec.decode(Seal.concat(chunks)));
            if (j && j.v === 1 && j.entries) { entries = j.entries; fileId = found[i].id; dirty = false; return cat.size(); }
          } catch (e) { /* not ours or damaged: try the next, or start fresh */ }
        }
        return 0;
      },

      /** Write the index (in place if it exists), then drop its older ciphertext revisions. */
      save: async function () {
        if (!dirty && fileId) return false;
        var body = enc.encode(JSON.stringify({ v: 1, updated: new Date().toISOString(), entries: entries }));
        var sealed = await Seal.sealBytes(circle, body, { name: "hyphae-index", mime: "application/json", size: body.length });
        var props = {}; props[P_INDEX] = "1"; props[P_SEALED] = "1"; props[P_KID] = circle.kid;
        var up = await client.startUpload({
          fileId: fileId || undefined, parents: fileId ? undefined : [parentId],
          metadata: { name: fileId ? undefined : Seal.randomName(), mimeType: "application/octet-stream", properties: props },
          totalSize: sealed.length,
        });
        await up.write(sealed);
        var f = await up.finish();
        fileId = f.id; dirty = false;
        try {
          var revs = await client.revisions(fileId);
          if (f.headRevisionId) for (var i = 0; i < revs.length; i++) if (revs[i].id !== f.headRevisionId) await client.deleteRevision(fileId, revs[i].id);
        } catch (e) { /* older index revisions are ciphertext; leaving them is harmless */ }
        return true;
      },

      /** Re-derive every entry from the sealed files themselves. Returns the count. */
      rebuild: async function () {
        var found = await client.findByProperty(P_SEALED, "1");
        var next = {};
        for (var i = 0; i < found.length; i++) {
          if ((found[i].properties || {})[P_INDEX] === "1") continue;
          var m = await readMeta(client, circles, found[i].id);
          if (m) next[found[i].id] = { n: m.name || "", t: m.mime || "", s: m.size || 0, m: m.mtime || "", p: m.path || "" };
        }
        entries = next; dirty = true;
        return cat.size();
      },
    };
    return cat;
  }

  return { create: create, readMeta: readMeta };
});
