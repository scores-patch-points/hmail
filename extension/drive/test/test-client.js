"use strict";
var L = require("./load.js");
var Client = L.drive("client.js");
var T = require("./harness.js");
var M = L.here("mock-drive.js");
var nc = require("node:crypto");

function rb(n) { return new Uint8Array(nc.randomBytes(n)); }
function same(a, b) { return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0; }

function make(mock, o) {
  var clock = { t: 1000000, sleeps: [] };
  var c = Client.create(Object.assign({
    token: mock.token, fetch: mock.fetch.bind(mock),
    sleep: function (ms) { clock.sleeps.push(ms); clock.t += ms; return Promise.resolve(); },
    now: function () { return clock.t; }, qps: 0,
  }, o || {}));
  c.clock = clock;
  return c;
}

T.test("list pages through every file; get and patch (property delete) work", async function () {
  var d = new M.MockDrive();
  for (var i = 0; i < 7; i++) d.addFile({ name: "f" + i, bytes: rb(10) });
  var c = make(d);
  var seen = [], pages = 0, token = null;
  do {
    var p = await c.list({ pageSize: 3, pageToken: token, q: "trashed = false" });
    pages++; seen = seen.concat(p.files.map(function (f) { return f.name; }));
    token = p.nextPageToken || null;
  } while (token);
  T.eq(pages, 3); T.eq(seen.length, 7);
  var n = await c.listAll({ q: "trashed = false" }, function () {});
  T.eq(n, 7);
  var f = await c.get(d.addFile({ name: "g", bytes: rb(5), properties: { a: "1", b: "2" } }));
  T.eq(f.properties.a, "1");
  var f2 = await c.patch(f.id, { name: "g2", properties: { a: null } });
  T.eq(f2.name, "g2"); T.eq(f2.properties.a, undefined); T.eq(f2.properties.b, "2");
});

T.test("query escaping: names with quotes and backslashes", async function () {
  var d = new M.MockDrive();
  d.addFile({ name: "it's", bytes: rb(3), properties: { k: "it's \\ ok" } });
  var c = make(d);
  var r = await c.findByProperty("k", "it's \\ ok");
  T.eq(r.length, 1);
});

T.test("retries 429, 503 and rate-limit 403 with backoff; honours Retry-After", async function () {
  var d = new M.MockDrive(); var id = d.addFile({ name: "a", bytes: rb(4) });
  var c = make(d);
  d.fault({ when: function (m, u) { return /\/files\/[^?]+\?/.test(u) && m === "GET"; }, status: 429, headers: { "retry-after": "7" }, times: 1 });
  d.fault({ when: function (m, u) { return /\/files\/[^?]+\?/.test(u) && m === "GET"; }, status: 503, times: 1 });
  d.fault({ when: function (m, u) { return /\/files\/[^?]+\?/.test(u) && m === "GET"; }, status: 403, reason: "userRateLimitExceeded", times: 1 });
  var f = await c.get(id);
  T.eq(f.id, id);
  T.eq(c.stats.retries, 3);
  T.eq(c.clock.sleeps[0], 7000, "Retry-After seconds");
  T.ok(c.clock.sleeps[1] >= 2000 && c.clock.sleeps[1] < 3000, "second backoff doubles: " + c.clock.sleeps[1]);
});

T.test("gives up after maxRetries with a typed error", async function () {
  var d = new M.MockDrive(); var id = d.addFile({ name: "a", bytes: rb(4) });
  var c = make(d, { maxRetries: 2 });
  d.fault({ when: function () { return true; }, status: 500, times: 99 });
  var e = await T.rejects(function () { return c.get(id); });
  T.eq(e.status, 500);
  T.eq(d.log.length, 3);
});

T.test("401 refreshes the token once; a wrong token fails with code 'auth'", async function () {
  var d = new M.MockDrive(); var id = d.addFile({ name: "a", bytes: rb(4) });
  var calls = [];
  var c = make(d, { token: function (o) { calls.push(!!(o && o.refresh)); return Promise.resolve(o && o.refresh ? d.token : "stale"); } });
  var f = await c.get(id);
  T.eq(f.id, id);
  T.eq(calls, [false, true]);
  var bad = make(d, { token: "nope" });
  await T.rejects(function () { return bad.get(id); }, "auth");
});

T.test("404 and quota errors are typed and not retried", async function () {
  var d = new M.MockDrive();
  var c = make(d);
  var before = d.log.length;
  await T.rejects(function () { return c.get("missing"); }, "not-found");
  T.eq(d.log.length - before, 1);
  d.fault({ when: function (m, u) { return m === "GET"; }, status: 403, reason: "storageQuotaExceeded", times: 1 });
  await T.rejects(function () { return c.about(); }, "quota");
});

T.test("request spacing gate: qps 4 spaces 8 calls by at least 250ms each", async function () {
  var d = new M.MockDrive();
  var c = make(d, { qps: 4 });
  for (var i = 0; i < 8; i++) await c.about();
  var total = c.clock.sleeps.reduce(function (a, b) { return a + b; }, 0);
  T.ok(total >= 7 * 250 - 5, "slept " + total);
});

T.test("download: whole file, Range, and resume after a mid-stream break", async function () {
  var d = new M.MockDrive(); var data = rb(300000); var id = d.addFile({ name: "a", bytes: data });
  var c = make(d);
  var parts = [];
  var n = await c.downloadTo(id, function (u8) { parts.push(u8); });
  T.eq(n, 300000);
  T.ok(same(Buffer.concat(parts), data));
  var r = await c.download(id, { range: "bytes=10-19" });
  T.eq(r.status, 206);
  T.ok(same(new Uint8Array(await r.arrayBuffer()), data.subarray(10, 20)));
  // break the stream after 100000 bytes, once: the client resumes with Range
  d.fault({ when: function (m, u) { return m === "GET" && /alt=media/.test(u); }, breakAfter: 100000, times: 1 });
  parts = [];
  n = await c.downloadTo(id, function (u8) { parts.push(u8); });
  T.eq(n, 300000);
  T.ok(same(Buffer.concat(parts), data), "resumed bytes line up");
  var ranges = d.reqs(/alt=media/);
  T.ok(ranges.length >= 2);
});

T.test("resumable upload: create, multi-chunk, commits only on finish, hash matches", async function () {
  var d = new M.MockDrive(); var c = make(d);
  var data = rb(256 * 1024 * 2 + 12345);
  var up = await c.startUpload({ metadata: { name: "new.bin", properties: { a: "b" } }, parents: [d.root.id], totalSize: data.length, chunkSize: 256 * 1024 });
  for (var i = 0; i < data.length; i += 50000) await up.write(data.subarray(i, i + 50000));
  var created = Object.keys(d.files).filter(function (k) { return d.files[k].name === "new.bin"; });
  T.eq(created.length, 0, "nothing committed before finish()");
  var f = await up.finish();
  T.eq(f.name, "new.bin"); T.eq(f.size, String(data.length));
  T.eq(f.properties.a, "b");
  T.ok(same(d.content(f.id), data));
  T.eq(up.sha256(), M.sha256hex(data));
  T.eq(f.sha256Checksum, up.sha256());
  T.eq(f.md5Checksum, up.md5());
});

T.test("resumable upload: exact multiple of the chunk size still waits for finish()", async function () {
  var d = new M.MockDrive(); var c = make(d);
  var id = d.addFile({ name: "t", bytes: rb(10) });
  var data = rb(256 * 1024 * 2);
  var up = await c.startUpload({ fileId: id, totalSize: data.length, chunkSize: 256 * 1024 });
  await up.write(data);
  T.eq(d.files[id].revisions.length, 1, "head unchanged until finish");
  await up.finish();
  T.eq(d.files[id].revisions.length, 2);
  T.ok(same(d.content(id), data));
});

T.test("resumable upload: in-place update keeps the file id and adds a revision", async function () {
  var d = new M.MockDrive(); var c = make(d);
  var old = rb(1000), neu = rb(5000);
  var id = d.addFile({ name: "doc.pdf", bytes: old });
  var up = await c.startUpload({ fileId: id, metadata: { name: "hy-x.hyd", mimeType: "application/octet-stream", properties: { hysealed: "1" } }, totalSize: neu.length });
  await up.write(neu);
  var f = await up.finish();
  T.eq(f.id, id); T.eq(f.name, "hy-x.hyd"); T.eq(f.properties.hysealed, "1");
  T.eq(d.files[id].revisions.length, 2);
  T.ok(same(d.files[id].revisions[0].bytes, old), "old content survives as a revision");
});

T.test("resumable upload survives a network drop and a 503 mid-way (status query, resume)", async function () {
  var d = new M.MockDrive(); var c = make(d);
  var data = rb(256 * 1024 * 4 + 999);
  var up = await c.startUpload({ metadata: { name: "big.bin" }, parents: [d.root.id], totalSize: data.length, chunkSize: 256 * 1024 });
  function nPut() { return d.log.filter(function (l) { return l.method === "PUT"; }).length; }
  d.fault({ when: function (m) { return m === "PUT" && nPut() === 2; }, network: true, times: 1 });
  d.fault({ when: function (m) { return m === "PUT" && nPut() >= 4; }, status: 503, times: 1 });
  await up.write(data);
  var f = await up.finish();
  T.ok(same(d.content(f.id), data));
  T.ok(c.stats.retries >= 2);
});

T.test("upload: a size mismatch refuses to commit", async function () {
  var d = new M.MockDrive(); var c = make(d);
  var up = await c.startUpload({ metadata: { name: "x" }, parents: [d.root.id], totalSize: 1000 });
  await up.write(rb(900));
  await T.rejects(function () { return up.finish(); }, "upload-size");
  T.eq(Object.keys(d.files).filter(function (k) { return d.files[k].name === "x"; }).length, 0);
});

T.test("upload: an expired session is a typed, non-retried error", async function () {
  var d = new M.MockDrive(); var c = make(d);
  var up = await c.startUpload({ metadata: { name: "x" }, parents: [d.root.id], totalSize: 300 * 1024, chunkSize: 256 * 1024 });
  d.sessions = {};
  await T.rejects(async function () { await up.write(rb(300 * 1024)); }, "upload-expired");
});

T.test("revisions, trash, changes and export endpoints", async function () {
  var d = new M.MockDrive(); var c = make(d);
  var id = d.addFile({ name: "a", bytes: rb(10) });
  d.edit(id, rb(20));
  var revs = await c.revisions(id);
  T.eq(revs.length, 2);
  await c.deleteRevision(id, revs[0].id);
  T.eq((await c.revisions(id)).length, 1);
  await T.rejects(function () { return c.deleteRevision(id, revs[1].id); }, "forbidden");
  var tok = await c.startPageToken();
  d.edit(id, rb(5));
  var ch = await c.changes(tok);
  T.eq(ch.changes.length, 1); T.eq(ch.changes[0].fileId, id);
  T.ok(ch.newStartPageToken);
  var t = await c.trash(id);
  T.eq(t.trashed, true);
  var nat = d.addNative("Doc", "application/vnd.google-apps.document", new Uint8Array([1, 2, 3]));
  var ex = await c.exportFile(nat, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  T.eq(new Uint8Array(await ex.arrayBuffer()).length, 3);
});

module.exports = T;
if (require.main === module) T.run("client").then(function (r) { process.exit(r.fail ? 1 : 0); });
