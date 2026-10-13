/*
 * A stand-in for the part of Google Drive v3 that hyphae drive's client uses, for the
 * demo page only. Written from the documented behaviour; it is NOT Google. It exposes a
 * fetch-compatible function, a way to seed files, and a way to read what it holds, so a
 * page can show exactly what "Google" has stored.
 */
(function (root) {
  "use strict";
  var H = root.HyHash;
  var FOLDER = "application/vnd.google-apps.folder";
  var enc = new TextEncoder(), dec = new TextDecoder();

  function create() {
    var files = {}, seqId = 0, seqRev = 0, clock = Date.UTC(2026, 9, 1), log = [], sessions = {}, seqSess = 0;
    var email = "you@gmail.com";

    function stamp() { clock += 60000; return new Date(clock).toISOString(); }
    function md5(u8) { var h = H.md5(); h.update(u8); return H.hex(h.digest()); }
    function note(id, removed) { log.push({ seq: log.length + 1, fileId: id, removed: !!removed }); }
    function bytesOf(x) { return typeof x === "string" ? enc.encode(x) : x; }

    function resource(f) {
      var head = f.revs.length ? f.revs[f.revs.length - 1] : null;
      var r = {
        id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, version: String(f.version),
        ownedByMe: f.ownedByMe, shared: f.shared, trashed: f.trashed, parents: f.parents.slice(),
        properties: Object.assign({}, f.properties),
        capabilities: { canEdit: f.canEdit, canTrash: true, canDelete: true, canAddChildren: f.mimeType === FOLDER },
      };
      if (head) { r.size = String(head.bytes.length); r.md5Checksum = head.md5; r.headRevisionId = head.id; }
      return r;
    }
    function add(spec) {
      var id = "f" + (++seqId);
      var f = {
        id: id, name: spec.name, mimeType: spec.mimeType || "application/octet-stream", parents: spec.parents || ["root"],
        properties: spec.properties || {}, trashed: false, ownedByMe: spec.ownedByMe !== false, shared: !!spec.shared,
        canEdit: spec.canEdit !== false, version: 1, modifiedTime: spec.modifiedTime || stamp(), revs: [],
      };
      if (spec.bytes !== undefined && spec.bytes !== null) {
        var b = bytesOf(spec.bytes);
        f.revs.push({ id: "r" + (++seqRev), bytes: b, md5: md5(b), modifiedTime: f.modifiedTime, keepForever: false });
      }
      files[id] = f; note(id);
      return id;
    }
    function putRevision(f, bytes) {
      var b = bytes;
      f.revs.push({ id: "r" + (++seqRev), bytes: b, md5: md5(b), modifiedTime: stamp(), keepForever: false });
      f.version++; f.modifiedTime = f.revs[f.revs.length - 1].modifiedTime;
      note(f.id);
    }

    function J(obj, status, headers) {
      return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ "Content-Type": "application/json" }, headers || {}) });
    }
    function err(status, reason, message) {
      return J({ error: { code: status, message: message || reason, errors: [{ reason: reason }] } }, status);
    }
    function parseQ(q) {
      var out = { props: [], trashed: null, parent: null };
      if (!q) return out;
      var re = /properties has \{ key='((?:\\.|[^'])*)' and value='((?:\\.|[^'])*)' \}/g, m;
      while ((m = re.exec(q))) out.props.push([m[1].replace(/\\(.)/g, "$1"), m[2].replace(/\\(.)/g, "$1")]);
      if (/trashed\s*=\s*false/.test(q)) out.trashed = false;
      var p = /'([^']+)' in parents/.exec(q);
      if (p) out.parent = p[1];
      return out;
    }

    async function doFetch(url, init) {
      init = init || {};
      var method = (init.method || "GET").toUpperCase();
      var u = new URL(url);
      var path = u.pathname, sp = u.searchParams;
      var hdr = init.headers || {};
      var h = function (k) { for (var n in hdr) if (n.toLowerCase() === k.toLowerCase()) return hdr[n]; return null; };

      // resumable upload session
      var mUp = /^\/mock-upload\/(\w+)$/.exec(path);
      if (mUp) {
        var s = sessions[mUp[1]];
        if (!s) return err(404, "notFound", "upload session gone");
        var cr = h("Content-Range") || "";
        var star = /^bytes \*\/(\d+)$/.exec(cr);
        if (star) {
          if (s.got >= s.total && s.done) return J(s.done);
          return new Response(null, { status: 308, headers: s.got ? { Range: "bytes=0-" + (s.got - 1) } : {} });
        }
        var mm = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
        if (!mm) return err(400, "badRequest", "bad Content-Range");
        var a = +mm[1], body = init.body;
        if (typeof body === "string") body = enc.encode(body);
        else if (!(body instanceof Uint8Array)) body = new Uint8Array(await new Response(body).arrayBuffer());
        if (a > s.got) return new Response(null, { status: 308, headers: s.got ? { Range: "bytes=0-" + (s.got - 1) } : {} });
        s.buf.set(body, a);
        s.got = Math.max(s.got, a + body.length);
        if (s.got < s.total) return new Response(null, { status: 308, headers: { Range: "bytes=0-" + (s.got - 1) } });
        var f;
        if (s.fileId) {
          f = files[s.fileId];
          if (s.meta.name) f.name = s.meta.name;
          if (s.meta.properties) Object.assign(f.properties, s.meta.properties);
          putRevision(f, s.buf);
        } else {
          var id = add({ name: s.meta.name || "Untitled", mimeType: s.contentType, parents: s.meta.parents, properties: s.meta.properties, bytes: s.buf });
          f = files[id];
        }
        s.done = resource(f);
        return J(s.done);
      }

      var up = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(path);
      if (up && sp.get("uploadType") === "resumable") {
        var fid = up[1] ? decodeURIComponent(up[1]) : null;
        if (fid && !files[fid]) return err(404, "notFound", "file not found");
        var meta = {};
        try { meta = JSON.parse(typeof init.body === "string" ? init.body : "{}"); } catch (e) { /* none */ }
        var total = parseInt(h("X-Upload-Content-Length") || "0", 10);
        var sid = "s" + (++seqSess);
        sessions[sid] = { fileId: fid, meta: meta, total: total, buf: new Uint8Array(total), got: 0, contentType: h("X-Upload-Content-Type") || "application/octet-stream", done: null };
        return new Response("", { status: 200, headers: { Location: "https://mock.drive.local/mock-upload/" + sid } });
      }

      if (!/^\/drive\/v3\//.test(path)) return err(404, "notFound", "unknown path " + path);
      var rest = path.slice("/drive/v3".length);

      if (rest === "/about" && method === "GET") {
        return J({ user: { permissionId: "perm-demo", emailAddress: email, displayName: "You" }, storageQuota: { limit: "16106127360", usage: "1048576" } });
      }
      if (rest === "/changes/startPageToken") return J({ startPageToken: String(log.length + 1) });
      if (rest === "/changes" && method === "GET") {
        var from = parseInt(sp.get("pageToken") || "1", 10);
        var seen = {}, ch = [];
        log.filter(function (c) { return c.seq >= from; }).forEach(function (c) { seen[c.fileId] = c; });
        Object.keys(seen).forEach(function (id) {
          ch.push({ fileId: id, removed: !files[id], file: files[id] ? resource(files[id]) : undefined });
        });
        return J({ changes: ch, newStartPageToken: String(log.length + 1) });
      }
      if (rest === "/files" && method === "GET") {
        var q = parseQ(sp.get("q"));
        var list = Object.keys(files).map(function (k) { return files[k]; }).filter(function (f) {
          if (q.trashed === false && f.trashed) return false;
          if (q.parent && f.parents.indexOf(q.parent) === -1) return false;
          return q.props.every(function (p) { return f.properties[p[0]] === p[1]; });
        });
        return J({ files: list.map(resource) });
      }
      if (rest === "/files" && method === "POST") {
        var md = JSON.parse(init.body || "{}");
        var nid = add({ name: md.name, mimeType: md.mimeType, parents: md.parents, properties: md.properties });
        return J(resource(files[nid]));
      }
      var mf = /^\/files\/([^/]+)(?:\/(revisions)(?:\/([^/]+))?)?$/.exec(rest);
      if (mf) {
        var file = files[decodeURIComponent(mf[1])];
        if (!file) return err(404, "notFound", "file not found");
        if (mf[2] === "revisions") {
          if (!mf[3] && method === "GET") {
            return J({ revisions: file.revs.map(function (r) { return { id: r.id, modifiedTime: r.modifiedTime, size: String(r.bytes.length), md5Checksum: r.md5, keepForever: r.keepForever }; }) });
          }
          var rev = file.revs.filter(function (r) { return r.id === mf[3]; })[0];
          if (!rev) return err(404, "notFound", "revision not found");
          if (method === "DELETE") {
            if (file.revs[file.revs.length - 1] === rev) return err(403, "cannotDeleteHead", "head revision");
            file.revs = file.revs.filter(function (r) { return r !== rev; });
            return new Response(null, { status: 204 });
          }
          if (method === "PATCH") { var pb = JSON.parse(init.body || "{}"); if ("keepForever" in pb) rev.keepForever = !!pb.keepForever; return J({ id: rev.id, keepForever: rev.keepForever }); }
          if (method === "GET" && sp.get("alt") === "media") return media(rev.bytes, h("Range"));
        }
        if (method === "GET" && sp.get("alt") === "media") {
          var hd = file.revs[file.revs.length - 1];
          if (!hd) return err(403, "fileNotDownloadable", "no content");
          return media(hd.bytes, h("Range"));
        }
        if (method === "GET") return J(resource(file));
        if (method === "PATCH") {
          var b = JSON.parse(init.body || "{}");
          if (b.name !== undefined) file.name = b.name;
          if (b.trashed !== undefined) file.trashed = !!b.trashed;
          if (b.properties) Object.keys(b.properties).forEach(function (k) { if (b.properties[k] === null) delete file.properties[k]; else file.properties[k] = b.properties[k]; });
          if (sp.get("addParents")) file.parents = file.parents.concat(sp.get("addParents").split(","));
          if (sp.get("removeParents")) file.parents = file.parents.filter(function (p) { return sp.get("removeParents").split(",").indexOf(p) === -1; });
          file.modifiedTime = stamp(); note(file.id);
          return J(resource(file));
        }
        if (method === "DELETE") { delete files[file.id]; note(file.id, true); return new Response(null, { status: 204 }); }
      }
      return err(404, "notFound", method + " " + rest);
    }

    function media(bytes, range) {
      var m = range && /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m) {
        var a = +m[1], b = m[2] === "" ? bytes.length - 1 : Math.min(+m[2], bytes.length - 1);
        return new Response(bytes.slice(a, b + 1), { status: 206, headers: { "Content-Range": "bytes " + a + "-" + b + "/" + bytes.length } });
      }
      return new Response(bytes.slice(0), { status: 200 });
    }

    return {
      fetch: doFetch,
      seed: add,
      folder: function (name, parents) { return add({ name: name, mimeType: FOLDER, parents: parents }); },
      /** What Google holds: every file as its resource, plus revisions and the head's bytes. */
      dump: function () {
        return Object.keys(files).map(function (k) {
          var f = files[k], r = resource(f);
          r.revisions = f.revs.map(function (x) { return { id: x.id, size: x.bytes.length, md5: x.md5 }; });
          r.head = f.revs.length ? f.revs[f.revs.length - 1].bytes : null;
          return r;
        });
      },
      bytes: function (id) { var f = files[id]; return f && f.revs.length ? f.revs[f.revs.length - 1].bytes : null; },
      revisionBytes: function (id) { var f = files[id]; return f ? f.revs.map(function (r) { return r.bytes; }) : []; },
    };
  }
  root.HyMockDrive = { create: create };
})(typeof self !== "undefined" ? self : globalThis);
