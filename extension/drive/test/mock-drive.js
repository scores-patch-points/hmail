/*
 * hyphae drive — a mock Google Drive for tests and demos.
 *
 * An in-process fake of the Drive v3 endpoints client.js uses: files.list/get/
 * create/update, resumable upload (initiate, 308 + Range, status query, final
 * 200), alt=media with Range, revisions, export, trash/delete, changes. It is
 * NOT Google: it is the documented behaviour, written to exercise the real
 * client and sweep code end to end.
 *
 * Classic-script friendly (UMD, no module syntax, nothing required at load in a
 * browser; needs hash.js loaded first for HyHash). Exposes global HyMockDrive:
 *
 *   var drive = HyMockDrive.create();                 // an empty Drive with My Drive as root
 *   var id = drive.seed({ name, mimeType, bytes, ownedByMe, shared, properties, parents });
 *   var client = HyDriveClient.create({ token: drive.token, fetch: drive.fetch, qps: 0 });
 *   drive.list()                                      // rows: id, name, size, revisions, properties, trashed...
 *   drive.bytes(id)                                   // raw head bytes (Uint8Array); bytes(id, 0) = oldest revision
 *
 * Test hooks: drive.fault({ when(method, url), status | network | breakAfter, times }),
 * drive.mutateMedia = function (file, revision, bytes, headers) -> bytes | undefined, drive.log.
 */
(function (root, factory) {
  var hash = root.HyHash;
  if (!hash && typeof require === "function") hash = require("../hash.js");
  var api = factory(hash);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HyMockDrive = api;
})(typeof self !== "undefined" ? self : globalThis, function (HyHash) {
"use strict";

var FOLDER = "application/vnd.google-apps.folder";

function MockDrive(opts) {
  opts = opts || {};
  this.token = opts.token || "tok-1";
  this.validTokens = [this.token];
  this.files = {};
  this.seq = 0;            // id + clock counter
  this.changeSeq = 0;
  this.changes = [];       // { seq, fileId, removed, snapshot }
  this.sessions = {};
  this.faults = [];        // { when(method,url), status, times, body, headers, breakAfter }
  this.log = [];           // { method, url, status }
  this.quotaBytes = opts.quotaBytes || Infinity;
  this.user = { permissionId: "perm-1", emailAddress: "me@example.com", displayName: "Me" };
  this.fetch = MockDrive.prototype.fetch.bind(this);   // pass straight to HyDriveClient.create({ fetch })
  this.root = this._add({ name: "My Drive", mimeType: FOLDER, parents: [], root: true });
}

MockDrive.prototype._now = function () { return new Date(Date.UTC(2026, 0, 1) + (++this.seq) * 1000).toISOString(); };
MockDrive.prototype._id = function () { return "f" + (++this.seq).toString(36) + rhex(3); };

function md5hex(b) { return HyHash.hex(HyHash.md5().update(b).digest()); }
function sha256hex(b) { return HyHash.hex(HyHash.sha256().update(b).digest()); }
function rhex(n) {
  var a = new Uint8Array(n), s = "";
  (typeof crypto !== "undefined" ? crypto : require("node:crypto").webcrypto).getRandomValues(a);
  for (var i = 0; i < n; i++) s += (a[i] < 16 ? "0" : "") + a[i].toString(16);
  return s;
}
// hashes cached per revision, recomputed when a revision's bytes are replaced
function revHash(r, kind) {
  if (r._hashed !== r.bytes) { r._hashed = r.bytes; r._md5 = md5hex(r.bytes); r._sha = sha256hex(r.bytes); }
  return kind === "md5" ? r._md5 : r._sha;
}

MockDrive.prototype._add = function (o) {
  var id = o.id || this._id();
  var f = {
    id: id, name: o.name, mimeType: o.mimeType || "application/octet-stream",
    parents: o.parents || [this.root ? this.root.id : undefined].filter(Boolean),
    ownedByMe: (o.ownedByMe !== undefined ? o.ownedByMe : o.owned) !== false, shared: !!o.shared, trashed: false,
    properties: Object.assign({}, o.properties || {}),
    canEdit: o.canEdit !== false, readOnlyContent: !!o.readOnlyContent,
    revisions: [], version: 1, modifiedTime: o.modifiedTime || this._now(),
    native: !!o.native, exportBytes: o.exportBytes || null, isRoot: !!o.root,
  };
  if (o.bytes) this._pushRevision(f, new Uint8Array(o.bytes));
  this.files[id] = f;
  this._record(f, false);
  return f;
};
MockDrive.prototype._pushRevision = function (f, bytes) {
  var rid = "r" + (++this.seq);
  f.revisions.push({ id: rid, bytes: new Uint8Array(bytes), modifiedTime: this._now(), keepForever: false });
  f.headRevisionId = rid;
};
MockDrive.prototype._head = function (f) { return f.revisions.length ? f.revisions[f.revisions.length - 1] : null; };
MockDrive.prototype._record = function (f, removed) {
  this.changes.push({ seq: ++this.changeSeq, fileId: f.id, removed: removed, snapshot: removed ? null : this._resource(f) });
};

MockDrive.prototype._resource = function (f) {
  var head = this._head(f);
  var r = {
    id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents.slice(), ownedByMe: f.ownedByMe,
    shared: f.shared, trashed: f.trashed, properties: Object.assign({}, f.properties),
    modifiedTime: f.modifiedTime, version: String(f.version),
    capabilities: { canEdit: f.canEdit, canTrash: f.canEdit, canDelete: f.ownedByMe, canAddChildren: f.canEdit },
  };
  if (f.readOnlyContent) r.contentRestrictions = [{ readOnly: true }];
  if (head && !f.native) {
    r.size = String(head.bytes.length);
    r.md5Checksum = revHash(head, "md5");
    if (!this.noSha256) r.sha256Checksum = revHash(head, "sha");
    r.headRevisionId = f.headRevisionId;
  }
  return r;
};

// ---- test helpers -----------------------------------------------------------------
MockDrive.prototype.addFile = function (o) { return this._add(o).id; };
/**
 * Seed one file: { name, mimeType?, bytes (Uint8Array), ownedByMe?, shared?, canEdit?,
 * properties?, parents? (default: My Drive), modifiedTime? }. Returns its id.
 * Native Google files: seed({ name, mimeType: "application/vnd.google-apps.document", native: true, exportBytes }).
 */
MockDrive.prototype.seed = function (o) { return this._add(o).id; };
MockDrive.prototype.seedFolder = function (name, parents) { return this.addFolder(name, parents); };
/** Everything held, as plain rows (no bytes): what a Drive UI would list. */
MockDrive.prototype.list = function () {
  var self = this;
  return Object.keys(this.files).map(function (k) {
    var f = self.files[k], h = self._head(f);
    return {
      id: f.id, name: f.name, mimeType: f.mimeType, size: h ? h.bytes.length : null, ownedByMe: f.ownedByMe, shared: f.shared,
      trashed: f.trashed, parents: f.parents.slice(), properties: Object.assign({}, f.properties), revisions: f.revisions.length,
      modifiedTime: f.modifiedTime, native: f.native, isRoot: f.isRoot,
    };
  }).filter(function (r) { return !r.isRoot; });
};
/** Raw bytes of a file's head content (or of revision number `rev`, 0 = oldest), exactly as stored. */
MockDrive.prototype.bytes = function (id, rev) {
  var f = this.files[id];
  if (!f || !f.revisions.length) return null;
  return rev === undefined ? this._head(f).bytes : (f.revisions[rev] ? f.revisions[rev].bytes : null);
};
MockDrive.prototype.addFolder = function (name, parents) { return this._add({ name: name, mimeType: FOLDER, parents: parents }).id; };
MockDrive.prototype.addNative = function (name, mimeType, exportBytes, parents) {
  return this._add({ name: name, mimeType: mimeType, native: true, exportBytes: exportBytes, parents: parents }).id;
};
MockDrive.prototype.content = function (id) { var h = this._head(this.files[id]); return h ? h.bytes : null; };
MockDrive.prototype.revs = function (id) { return this.files[id].revisions.map(function (r) { return r.id; }); };
MockDrive.prototype.storageUsed = function () {
  var n = 0, self = this;
  Object.keys(this.files).forEach(function (k) { self.files[k].revisions.forEach(function (r) { n += r.bytes.length; }); });
  return n;
};
MockDrive.prototype.edit = function (id, bytes) { // simulate a user edit outside hyphae
  var f = this.files[id];
  this._pushRevision(f, new Uint8Array(bytes));
  f.version++; f.modifiedTime = this._now();
  this._record(f, false);
};
MockDrive.prototype.fault = function (f) { f.times = f.times === undefined ? 1 : f.times; this.faults.push(f); };
MockDrive.prototype.reqs = function (re) { return this.log.filter(function (l) { return re.test(l.method + " " + l.url); }); };

// ---- q parser -------------------------------------------------------------------
function matchQuery(f, q, self) {
  if (!q) return true;
  var re = /properties has \{ key='((?:\\.|[^'])*)' and value='((?:\\.|[^'])*)' \}|'((?:\\.|[^'])*)' in (parents|owners)|(trashed|mimeType|name|modifiedTime) (=|!=|>|<|contains) ('((?:\\.|[^'])*)'|true|false)/g;
  var m, ok = true, any = false;
  function un(s) { return s === undefined ? s : s.replace(/\\(.)/g, "$1"); }
  while ((m = re.exec(q)) !== null) {
    any = true;
    if (m[1] !== undefined) { ok = ok && f.properties[un(m[1])] === un(m[2]); }
    else if (m[3] !== undefined) {
      if (m[4] === "parents") ok = ok && f.parents.indexOf(un(m[3])) >= 0;
      else ok = ok && (un(m[3]) === "me" ? f.ownedByMe : !f.ownedByMe);
    } else {
      var field = m[5], op = m[6], raw = m[7];
      var val = raw === "true" ? true : raw === "false" ? false : un(m[8]);
      var cur = field === "trashed" ? f.trashed : field === "mimeType" ? f.mimeType : field === "name" ? f.name : f.modifiedTime;
      if (op === "=") ok = ok && cur === val;
      else if (op === "!=") ok = ok && cur !== val;
      else if (op === ">") ok = ok && cur > val;
      else if (op === "<") ok = ok && cur < val;
      else if (op === "contains") ok = ok && String(cur).indexOf(val) >= 0;
    }
  }
  return ok;
}

// ---- the fetch -----------------------------------------------------------------
function jsonResp(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ "content-type": "application/json" }, headers || {}) });
}
function errResp(status, reason, message) {
  return jsonResp({ error: { code: status, message: message || reason, errors: [{ reason: reason, message: message || reason }], status: reason } }, status);
}

MockDrive.prototype.fetch = async function (url, init) {
  var self = this;
  init = init || {};
  var method = (init.method || "GET").toUpperCase();
  var u = new URL(url);
  var rec = { method: method, url: u.pathname + u.search, status: 0 };
  this.log.push(rec);

  var fault = null;
  for (var i = 0; i < this.faults.length; i++) {
    var ft = this.faults[i];
    if (ft.times > 0 && ft.when(method, rec.url)) { ft.times--; fault = ft; break; }
  }
  if (fault && fault.network) { rec.status = -1; throw new TypeError("fetch failed (injected)"); }
  if (fault && fault.status) {
    rec.status = fault.status;
    var h = fault.headers || {};
    return fault.reason ? (function () { var r = errResp(fault.status, fault.reason); return new Response(r.body, { status: fault.status, headers: Object.assign({ "content-type": "application/json" }, h) }); })()
      : new Response("", { status: fault.status, headers: h });
  }

  var headers = {};
  var ih = init.headers || {};
  Object.keys(ih).forEach(function (k) { headers[k.toLowerCase()] = ih[k]; });

  var resp;
  try { resp = await this._route(method, u, headers, init.body, fault); }
  catch (e) { if (e instanceof TypeError) throw e; throw e; }
  rec.status = resp.status;
  return resp;
};

MockDrive.prototype._route = async function (method, u, headers, body, fault) {
  var self = this, p = u.pathname, q = u.searchParams, m;

  // upload sessions: no bearer needed
  if ((m = /^\/session\/(.+)$/.exec(p)) && method === "PUT") return this._uploadChunk(m[1], headers, body);
  if (headers.authorization !== "Bearer " + this.token) return errResp(401, "authError", "Invalid Credentials");

  if (p === "/drive/v3/about") return jsonResp({ user: this.user, storageQuota: { limit: "100", usage: String(this.storageUsed()) } });

  if (p === "/drive/v3/files" && method === "GET") {
    var all = Object.keys(this.files).map(function (k) { return self.files[k]; }).filter(function (f) {
      return !f.isRoot && matchQuery(f, q.get("q"), self);
    });
    var size = parseInt(q.get("pageSize") || "100", 10), off = parseInt(q.get("pageToken") || "0", 10);
    var page = all.slice(off, off + size).map(function (f) { return self._resource(f); });
    var out = { files: page };
    if (off + size < all.length) out.nextPageToken = String(off + size);
    return jsonResp(out);
  }
  if (p === "/drive/v3/files" && method === "POST") {
    var meta = JSON.parse(body || "{}");
    var nf = this._add({ name: meta.name, mimeType: meta.mimeType, parents: meta.parents, properties: meta.properties });
    return jsonResp(this._resource(nf));
  }

  if ((m = /^\/drive\/v3\/files\/([^/]+)\/revisions\/([^/]+)$/.exec(p))) {
    var rf = this.files[decodeURIComponent(m[1])];
    if (!rf) return errResp(404, "notFound");
    var ri = rf.revisions.map(function (r) { return r.id; }).indexOf(decodeURIComponent(m[2]));
    if (ri < 0) return errResp(404, "revisionNotFound");
    if (method === "GET" && q.get("alt") === "media") return this._media(rf.revisions[ri].bytes, headers, fault, rf, rf.revisions[ri]);
    if (method === "DELETE") {
      if (ri === rf.revisions.length - 1) return errResp(403, "cannotDeleteHeadRevision", "cannot delete the head revision");
      rf.revisions.splice(ri, 1);
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH") { rf.revisions[ri].keepForever = !!JSON.parse(body).keepForever; return jsonResp({ id: rf.revisions[ri].id, keepForever: rf.revisions[ri].keepForever }); }
  }
  if ((m = /^\/drive\/v3\/files\/([^/]+)\/revisions$/.exec(p)) && method === "GET") {
    var f2 = this.files[decodeURIComponent(m[1])];
    if (!f2) return errResp(404, "notFound");
    return jsonResp({ revisions: f2.revisions.map(function (r) {
      return { id: r.id, modifiedTime: r.modifiedTime, size: String(r.bytes.length), md5Checksum: revHash(r, "md5"), keepForever: r.keepForever };
    }) });
  }
  if ((m = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(p)) && method === "GET") {
    var ef = this.files[decodeURIComponent(m[1])];
    if (!ef) return errResp(404, "notFound");
    if (!ef.native) return errResp(403, "fileNotExportable");
    return new Response(ef.exportBytes, { status: 200 });
  }

  if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p))) {
    var fid = decodeURIComponent(m[1]), f = this.files[fid];
    if (!f) return errResp(404, "notFound", "File not found: " + fid);
    if (method === "GET" && q.get("alt") === "media") {
      if (f.native) return errResp(403, "fileNotDownloadable", "Only files with binary content can be downloaded");
      return this._media(this._head(f).bytes, headers, fault, f, this._head(f));
    }
    if (method === "GET") return jsonResp(this._resource(f));
    if (method === "PATCH") {
      var patch = JSON.parse(body || "{}");
      this._applyMeta(f, patch);
      if (q.get("addParents")) f.parents = f.parents.concat(q.get("addParents").split(","));
      if (q.get("removeParents")) f.parents = f.parents.filter(function (x) { return q.get("removeParents").split(",").indexOf(x) < 0; });
      f.modifiedTime = this._now(); f.version++;
      this._record(f, false);
      return jsonResp(this._resource(f));
    }
    if (method === "DELETE") {
      delete this.files[fid];
      this._record(f, true);
      return new Response(null, { status: 204 });
    }
  }

  if (p === "/drive/v3/changes/startPageToken") return jsonResp({ startPageToken: String(this.changeSeq) });
  if (p === "/drive/v3/changes" && method === "GET") {
    var tok = parseInt(q.get("pageToken"), 10);
    if (isNaN(tok) || tok > this.changeSeq) return errResp(400, "invalid", "Invalid Value");
    var ps = parseInt(q.get("pageSize") || "100", 10);
    var pending = this.changes.filter(function (c) { return c.seq > tok; });
    var chunk = pending.slice(0, ps);
    var res = { changes: chunk.map(function (c) { return { fileId: c.fileId, removed: c.removed, file: c.snapshot || undefined }; }) };
    if (pending.length > ps) res.nextPageToken = String(chunk[chunk.length - 1].seq);
    else res.newStartPageToken = String(this.changeSeq);
    return jsonResp(res);
  }

  // resumable upload initiation
  if ((m = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(p)) && (method === "POST" || method === "PATCH") && q.get("uploadType") === "resumable") {
    var target = m[1] ? decodeURIComponent(m[1]) : null;
    if (target && !this.files[target]) return errResp(404, "notFound");
    if (target && !this.files[target].canEdit) return errResp(403, "insufficientFilePermissions");
    var sid = "s" + (++this.seq) + rhex(4);
    this.sessions[sid] = {
      target: target, meta: JSON.parse(body || "{}"), total: parseInt(headers["x-upload-content-length"] || "-1", 10),
      type: headers["x-upload-content-type"], chunks: [], got: 0, done: false, file: null,
    };
    return new Response("", { status: 200, headers: { location: "https://upload.mock/session/" + sid } });
  }
  return errResp(404, "mockNoRoute", method + " " + p);
};

MockDrive.prototype._applyMeta = function (f, meta) {
  if (typeof meta.name === "string") f.name = meta.name;
  if (typeof meta.mimeType === "string") f.mimeType = meta.mimeType;
  if (typeof meta.trashed === "boolean") f.trashed = meta.trashed;
  if (meta.properties) {
    Object.keys(meta.properties).forEach(function (k) {
      if (meta.properties[k] === null) delete f.properties[k]; else f.properties[k] = String(meta.properties[k]);
    });
  }
};

MockDrive.prototype._media = function (bytes, headers, fault, f, rev) {
  if (this.mutateMedia && f) { var mb = this.mutateMedia(f, rev, bytes, headers); if (mb) bytes = mb; }
  var status = 200, out = bytes, extra = { "content-type": "application/octet-stream" };
  var r = headers.range && /^bytes=(\d+)-(\d*)$/.exec(headers.range);
  if (r) {
    var a = parseInt(r[1], 10), b = r[2] === "" ? bytes.length - 1 : Math.min(parseInt(r[2], 10), bytes.length - 1);
    if (a >= bytes.length) return new Response("", { status: 416 });
    out = bytes.subarray(a, b + 1);
    status = 206;
    extra["content-range"] = "bytes " + a + "-" + b + "/" + bytes.length;
  }
  if (fault && fault.breakAfter !== undefined) {
    var cut = out.subarray(0, fault.breakAfter), sent = false;
    var stream = new ReadableStream({
      pull: function (c) {
        if (!sent) { sent = true; c.enqueue(cut); return; }
        c.error(new TypeError("terminated (injected)"));
      },
    });
    return new Response(stream, { status: status, headers: extra });
  }
  // deliver in 64 KiB pieces so streaming paths are real
  var pos = 0, view = out;
  var s2 = new ReadableStream({
    pull: function (c) {
      if (pos >= view.length) { c.close(); return; }
      c.enqueue(view.subarray(pos, pos + 65536)); pos += 65536;
    },
  });
  return new Response(s2, { status: status, headers: extra });
};

MockDrive.prototype._uploadChunk = async function (sid, headers, body) {
  var s = this.sessions[sid];
  if (!s) return errResp(404, "notFound", "upload session");
  var cr = headers["content-range"] || "";
  var m = /^bytes (?:\*|(\d+)-(\d+))\/(\d+|\*)$/.exec(cr);
  if (!m) return errResp(400, "badRequest", "Content-Range " + cr);
  if (s.done) return jsonResp(this._resource(s.file), 200);
  if (m[1] === undefined) { // status query
    return s.got > 0 ? new Response("", { status: 308, headers: { range: "bytes=0-" + (s.got - 1) } }) : new Response("", { status: 308 });
  }
  var start = parseInt(m[1], 10), end = parseInt(m[2], 10), total = parseInt(m[3], 10);
  var bytes = body ? new Uint8Array(await new Response(body).arrayBuffer()) : new Uint8Array(0);
  if (bytes.length !== end - start + 1) return errResp(400, "badRequest", "length " + bytes.length + " != range");
  if (start > s.got) return errResp(400, "badRequest", "gap: have " + s.got + ", chunk starts " + start);
  if (start + bytes.length <= s.got) return s.got > 0 ? new Response("", { status: 308, headers: { range: "bytes=0-" + (s.got - 1) } }) : new Response("", { status: 308 });
  var fresh = bytes.subarray(s.got - start);
  s.chunks.push(fresh); s.got += fresh.length;
  if (s.got < total) {
    if (end + 1 !== s.got) return errResp(400, "badRequest", "size");
    if (end + 1 < total && (bytes.length % (256 * 1024)) !== 0) return errResp(400, "badRequest", "chunk not a multiple of 256 KiB");
    return new Response("", { status: 308, headers: { range: "bytes=0-" + (s.got - 1) } });
  }
  // complete
  var all = new Uint8Array(s.got), o = 0;
  s.chunks.forEach(function (c) { all.set(c, o); o += c.length; });
  var f;
  var after = this.storageUsed() + all.length;
  if (after > this.quotaBytes) return errResp(403, "storageQuotaExceeded", "The user's Drive storage quota has been exceeded.");
  if (s.target) {
    f = this.files[s.target];
    this._pushRevision(f, all);
    f.version++; f.modifiedTime = this._now();
    this._applyMeta(f, s.meta);
  } else {
    f = this._add({ name: s.meta.name || "Untitled", mimeType: s.meta.mimeType || s.type, parents: s.meta.parents, properties: s.meta.properties, bytes: all });
  }
  this._record(f, false);
  s.done = true; s.file = f;
  return jsonResp(this._resource(f), 200);
};

function create(opts) { return new MockDrive(opts); }

  return { MockDrive: MockDrive, create: create, FOLDER: FOLDER, md5hex: md5hex, sha256hex: sha256hex };
});
