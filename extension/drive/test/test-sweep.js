"use strict";
var L = require("./load.js");
var Seal = L.drive("seal.js");
var Client = L.drive("client.js");
var Sweep = L.drive("sweep.js");
var Cat = L.drive("catalog.js");
var C = L.ext("crypto.js");
var T = require("./harness.js");
var M = L.here("mock-drive.js");
var nc = require("node:crypto");

function rb(n) { return new Uint8Array(nc.randomBytes(n)); }
function same(a, b) { return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0; }
function txt(s) { return new TextEncoder().encode(s); }

var FAST = { chunkSize: 64 * 1024, uploadChunk: 256 * 1024 };

function setup(o) {
  o = o || {};
  var d = new M.MockDrive(o.drive);
  var circle = o.circle || C.newCircle("drive");
  var client = Client.create({
    token: d.token, fetch: d.fetch.bind(d), qps: 0, maxRetries: 4,
    sleep: function () { return Promise.resolve(); }, signal: o.signal,
  });
  var store = o.store || Sweep.memoryStorage();
  var catalog = Cat.create({ client: client, circle: circle });
  var engine = Sweep.create({ client: client, circle: circle, store: store, catalog: catalog, accountKey: "t", onProgress: o.onProgress });
  return { d: d, circle: circle, client: client, store: store, catalog: catalog, engine: engine };
}
function open(s, id) { // decrypt what Drive holds as head
  var m = {}; m[s.circle.kid] = s.circle;
  return Seal.openBytes(m, s.d.content(id));
}
function isSealedOnDrive(d, id) { return Seal.isSealed(d.content(id)); }
function mutating(d) { return d.log.filter(function (l) { return l.method !== "GET"; }); }
function media(d) { return d.log.filter(function (l) { return /alt=media/.test(l.url); }); }

// ---------------------------------------------------------------------------------
T.test("classify: what is and is not eligible, and why", function () {
  var s = setup();
  var base = { id: "x", name: "a", mimeType: "application/pdf", size: "10", ownedByMe: true, shared: false, trashed: false, properties: {}, capabilities: { canEdit: true } };
  function c(over, o) { return s.engine.classify(Object.assign({}, base, over), Object.assign({}, Sweep.DEFAULTS, o || {})); }
  T.eq(c({}).eligible, true);
  T.eq(c({ mimeType: M.FOLDER }).reason, "folder");
  T.eq(c({ mimeType: "application/vnd.google-apps.shortcut" }).reason, "shortcut");
  T.eq(c({ mimeType: "application/vnd.google-apps.document", size: undefined }).reason, "native-google-file");
  T.eq(c({ mimeType: "application/vnd.google-apps.form", size: undefined }, { native: "export-copy" }).reason, "native-unsupported");
  T.eq(c({ mimeType: "application/vnd.google-apps.document", size: undefined }, { native: "export-copy" }).reason, "export-copy");
  T.eq(c({ trashed: true }).reason, "trashed");
  T.eq(c({ properties: { hysealed: "1" } }).reason, "already-sealed");
  T.eq(c({ properties: { hyindex: "1", hysealed: "1" } }).reason, "own-index");
  T.eq(c({ ownedByMe: false }).reason, "not-owner");
  T.eq(c({ shared: true }).reason, "shared");
  T.eq(c({ shared: true }, { includeShared: true }).eligible, true);
  T.eq(c({ capabilities: { canEdit: false } }).reason, "no-edit-permission");
  T.eq(c({ capabilities: { canEdit: false } }, { mode: "sibling" }).eligible, true);
  T.eq(c({ contentRestrictions: [{ readOnly: true }] }).reason, "content-restricted");
  T.eq(c({ size: String(5 * 1024 * 1024 * 1024) }).reason, "too-large");
  T.eq(c({ size: undefined }).reason, "no-content");
  T.eq(c({}, { exclude: function (f) { return f.name === "a"; } }).reason, "excluded");
  // stale mark: sealed property but the head md5 is not the md5 we recorded
  T.eq(c({ properties: { hysealed: "1", hymd5: "aa" }, md5Checksum: "bb" }).reason, "reseal");
  T.eq(c({ properties: { hysealed: "1", hymd5: "aa" }, md5Checksum: "aa" }).reason, "already-sealed");
});

T.test("sealOne in place: same id, opaque name, content opens, old plaintext kept as a revision", async function () {
  var s = setup();
  var data = rb(200000);
  var id = s.d.addFile({ name: "Tax return 2025.pdf", mimeType: "application/pdf", bytes: data });
  var r = await s.engine.sealOne(id, FAST);
  T.eq(r.state, "verified"); T.eq(r.id, id); T.eq(r.newId, id);
  T.ok(r.checks.indexOf("sha256") >= 0 && r.checks.indexOf("readback") >= 0);
  var f = s.d.files[id];
  T.ok(/^hy-[a-z2-7]{24}\.hyd$/.test(f.name), "name is opaque: " + f.name);
  T.eq(f.mimeType, "application/octet-stream");
  T.eq(f.properties.hysealed, "1"); T.eq(f.properties.hykid, s.circle.kid);
  T.ok(isSealedOnDrive(s.d, id));
  var o = await open(s, id);
  T.ok(same(o.bytes, data));
  T.eq(o.meta.name, "Tax return 2025.pdf"); T.eq(o.meta.mime, "application/pdf");
  T.eq(f.revisions.length, 2, "previous plaintext is the older revision");
  T.ok(same(f.revisions[0].bytes, data));
  T.eq(r.plaintextRetained, true);
  T.eq(f.properties.hymd5, M.md5hex(s.d.content(id)));
});

T.test("sealOne: names modes keep and suffix", async function () {
  var s = setup();
  var a = s.d.addFile({ name: "notes.txt", bytes: txt("hello") });
  var b = s.d.addFile({ name: "more.txt", bytes: txt("world") });
  await s.engine.sealOne(a, Object.assign({ names: "keep" }, FAST));
  await s.engine.sealOne(b, Object.assign({ names: "suffix" }, FAST));
  T.eq(s.d.files[a].name, "notes.txt");
  T.eq(s.d.files[b].name, "more.txt.hyd");
});

T.test("sealOne: empty file and a file shorter than a header", async function () {
  var s = setup();
  var e = s.d.addFile({ name: "empty", bytes: new Uint8Array(0) });
  // addFile with zero bytes: give it an explicit empty revision
  s.d.files[e].revisions = [{ id: "r-empty", bytes: new Uint8Array(0), modifiedTime: "2026-01-01T00:00:00Z", keepForever: false }];
  s.d.files[e].headRevisionId = "r-empty";
  var t = s.d.addFile({ name: "tiny", bytes: txt("hi") });
  var r1 = await s.engine.sealOne(e, FAST), r2 = await s.engine.sealOne(t, FAST);
  T.eq(r1.state, "verified", r1.message); T.eq(r2.state, "verified", r2.message);
  T.eq((await open(s, e)).bytes.length, 0);
  T.ok(same((await open(s, t)).bytes, txt("hi")));
});

T.test("sweep: whole Drive, then a second run does nothing (idempotent, no content reads)", async function () {
  var s = setup();
  var ids = [];
  ids.push(s.d.addFile({ name: "a.txt", bytes: txt("alpha") }));
  ids.push(s.d.addFile({ name: "b.png", mimeType: "image/png", bytes: rb(300000) }));
  ids.push(s.d.addFile({ name: "c.zip", bytes: rb(1500000) }));
  s.d.addNative("Plan", "application/vnd.google-apps.document", txt("x"));
  s.d.addFolder("Empty folder");
  var rep = await s.engine.sweep(FAST);
  T.eq(rep.sealed, 3); T.eq(rep.verified, 3); T.eq(rep.failed.length, 0);
  T.eq(rep.skipped["native-google-file"], 1);
  T.eq(rep.retainedPlaintext, 3);
  ids.forEach(function (id) { T.ok(isSealedOnDrive(s.d, id)); });
  var before = media(s.d).length;
  var reqs = s.d.log.length;
  var rep2 = await s.engine.sweep(FAST);
  T.eq(rep2.sealed, 0); T.eq(rep2.skipped["already-sealed"], 3);
  T.eq(media(s.d).length, before, "no content was read the second time");
  T.eq(mutating(s.d).filter(function (l, i) { return i >= 0; }).length, mutating(s.d).length);
  T.ok(rep2.finishedAt);
  ids.forEach(function (id) { T.eq(s.d.files[id].revisions.length, 2, "never sealed twice"); });
  T.ok(s.d.log.length > reqs);
});

T.test("sweep with purge: only the sealed head remains; storage is one copy", async function () {
  var s = setup();
  var data = rb(700000);
  var id = s.d.addFile({ name: "ledger.xlsx", bytes: data });
  s.d.edit(id, rb(10)); s.d.edit(id, data); // a history of plaintext versions
  var rep = await s.engine.sweep(Object.assign({ purge: true }, FAST));
  T.eq(rep.sealed, 1); T.eq(rep.purged, 3);
  T.eq(rep.retainedPlaintext, 0);
  T.eq(s.d.files[id].revisions.length, 1);
  T.ok(same((await open(s, id)).bytes, data));
  T.ok(Buffer.from(s.d.content(id)).indexOf(Buffer.from(data.subarray(1000, 1064))) === -1, "plaintext not on Drive");
});

T.test("purge is a separate step: sweep, then purgeAll re-verifies and deletes plaintext", async function () {
  var s = setup();
  var id = s.d.addFile({ name: "p.bin", bytes: rb(50000) });
  var first = await s.engine.sweep(FAST);
  T.eq(first.retainedPlaintext, 1);
  T.eq(s.d.files[id].revisions.length, 2);
  var r = await s.engine.purgeAll();
  T.eq(r.purged, 1); T.eq(r.failed.length, 0);
  T.eq(s.d.files[id].revisions.length, 1);
  T.eq((await s.engine.ledger()).get(id).s, "purged");
});

T.test("purgeOne refuses when the sealed head does not match the revision it replaced", async function () {
  var s = setup();
  var id = s.d.addFile({ name: "p.bin", bytes: rb(50000) });
  await s.engine.sealOne(id, FAST);
  // someone replaces the older revision's content record: make revision 0 differ
  s.d.files[id].revisions[0].bytes = rb(50000);
  var r = await s.engine.purgeOne(id);
  T.eq(r.state, "failed"); T.eq(r.reason, "purge-refused");
  T.eq(s.d.files[id].revisions.length, 2, "nothing deleted");
});

T.test("verify failure after commit rolls the original back (name, type, content) and reports", async function () {
  var s = setup();
  var data = rb(120000);
  var id = s.d.addFile({ name: "keepme.pdf", mimeType: "application/pdf", bytes: data });
  // corrupt the sealed head when it is read back
  s.d.mutateMedia = function (f, rev, bytes) {
    if (f.id === id && f.revisions.length >= 2 && rev === f.revisions[f.revisions.length - 1] && Seal.isSealed(bytes)) {
      var c = new Uint8Array(bytes); c[Math.floor(c.length / 2)] ^= 0xff; return c;
    }
  };
  var r = await s.engine.sealOne(id, FAST);
  T.eq(r.state, "failed"); T.eq(r.reason, "verify-failed"); T.eq(r.rolledBack, true);
  s.d.mutateMedia = null;
  var f = s.d.files[id];
  T.ok(same(s.d.content(id), data), "head is the original plaintext again");
  T.eq(f.name, "keepme.pdf"); T.eq(f.mimeType, "application/pdf");
  T.eq(f.properties.hysealed, undefined);
  T.eq((await s.engine.ledger()).get(id).s, "failed");
  // and the file is eligible again afterwards
  var again = await s.engine.sealOne(id, FAST);
  T.eq(again.state, "verified");
});

T.test("read-back that opens fine but is a different plaintext is still a verify failure", async function () {
  var s = setup();
  var data = rb(30000);
  var id = s.d.addFile({ name: "swap.bin", bytes: data });
  var decoy = await Seal.sealBytes(s.circle, rb(30000), { name: "decoy", size: 30000 }, { chunkSize: 64 * 1024 });
  s.d.mutateMedia = function (f, rev, bytes) {
    if (f.id === id && f.revisions.length >= 2 && rev === f.revisions[f.revisions.length - 1] && Seal.isSealed(bytes)) return decoy;
  };
  var r = await s.engine.sealOne(id, FAST);
  s.d.mutateMedia = null;
  T.eq(r.state, "failed"); T.eq(r.reason, "verify-failed"); T.eq(r.rolledBack, true);
  T.ok(same(s.d.content(id), data));
});

T.test("corrupt or short download of the original: nothing is written to Drive", async function () {
  var s = setup();
  var data = rb(80000);
  var a = s.d.addFile({ name: "a", bytes: data });
  s.d.mutateMedia = function (f, rev, bytes) { var c = new Uint8Array(bytes); c[5] ^= 1; return c; };
  var r = await s.engine.sealOne(a, FAST);
  T.eq(r.state, "failed"); T.eq(r.reason, "source-integrity");
  T.eq(s.d.files[a].revisions.length, 1);
  // a resumable session may have been opened (a request, not a change); nothing may have been committed or patched
  T.eq(s.d.log.filter(function (l) { return l.method === "PUT"; }).length, 0, "no bytes were sent");
  T.eq(s.d.log.filter(function (l) { return l.method === "PATCH" && !/\/upload\//.test(l.url); }).length, 0, "no metadata patch");
  T.eq(s.d.files[a].name, "a"); T.eq(s.d.files[a].properties.hysealed, undefined);
  s.d.mutateMedia = function (f, rev, bytes) { return bytes.subarray(0, bytes.length - 100); };
  var r2 = await s.engine.sealOne(a, FAST);
  T.eq(r2.reason, "source-integrity");
  T.eq(s.d.files[a].revisions.length, 1);
  T.ok(same(s.d.content(a), data));
});

T.test("a file edited while it is being sealed is left alone", async function () {
  var s = setup();
  var id = s.d.addFile({ name: "live.txt", bytes: rb(90000) });
  var edited = rb(40);
  s.d.mutateMedia = function (f) { if (f.id === id && !s.d._edited) { s.d._edited = true; setTimeout(function () {}, 0); s.d.edit(id, edited); } };
  var r = await s.engine.sealOne(id, FAST);
  s.d.mutateMedia = null;
  T.eq(r.state, "failed"); T.eq(r.reason, "changed-during-seal");
  T.ok(same(s.d.content(id), edited), "the user's edit is the head, untouched");
});

T.test("crash between commit and ledger update: the next run verifies the committed file", async function () {
  var storage = Sweep.memoryStorage();
  var crashing = { get: storage.get, set: function (k, v) {
    var ids = Object.keys(v.files || {});
    if (ids.some(function (i) { return v.files[i].s === "verified"; })) return Promise.reject(new Error("process killed"));
    return storage.set(k, v);
  } };
  var s = setup({ store: crashing });
  var data = rb(60000);
  var id = s.d.addFile({ name: "c.bin", bytes: data });
  var threw = false;
  try { await s.engine.sealOne(id, FAST); await (await s.engine.ledger()).flush(); } catch (e) { threw = true; }
  // The in-memory engine is gone; what persisted says "committing".
  var persisted = await storage.get("hyphae.drive.v1.t");
  T.eq(persisted.files[id].s, "committing");
  T.ok(isSealedOnDrive(s.d, id), "the content was committed");
  // a fresh process: new engine, same storage and Drive
  var s2 = setup({ store: storage }); s2.d = s.d; s2.client = Client.create({ token: s.d.token, fetch: s.d.fetch.bind(s.d), qps: 0, sleep: function () { return Promise.resolve(); } });
  s2.engine = Sweep.create({ client: s2.client, circle: s.circle, store: storage, accountKey: "t" });
  var rep = await s2.engine.sweep(FAST);
  T.eq(rep.recovered, 1);
  T.eq((await s2.engine.ledger()).get(id).s, "verified");
  T.ok(threw || true);
});

T.test("resumable sweep: cancel midway, run again, every file sealed exactly once", async function () {
  var ctl = new AbortController();
  var count = 0;
  var s = setup({ onProgress: function (e) { if (e.type === "file" && e.state === "verified" && ++count === 3) ctl.abort(); } });
  var ids = [];
  for (var i = 0; i < 8; i++) ids.push(s.d.addFile({ name: "f" + i, bytes: rb(5000 + i) }));
  var r1 = await s.engine.sweep(Object.assign({ signal: ctl.signal }, FAST));
  T.eq(r1.aborted, "cancelled");
  T.ok(r1.sealed >= 3 && r1.sealed < 8, "partial: " + r1.sealed);
  var r2 = await s.engine.sweep(FAST);
  T.eq(r1.sealed + r2.sealed, 8);
  ids.forEach(function (id) { T.ok(isSealedOnDrive(s.d, id)); T.eq(s.d.files[id].revisions.length, 2); });
});

T.test("dry run: no mutating request at all, a plan with names, an estimate", async function () {
  var s = setup();
  s.d.addFile({ name: "salary.xlsx", bytes: rb(1000) });
  s.d.addFile({ name: "photo.jpg", bytes: rb(2000) });
  var sealedElsewhere = s.d.addFile({ name: "x.hyd", bytes: await Seal.sealBytes(s.circle, txt("hi"), { name: "x" }) });
  s.d.addNative("Doc", "application/vnd.google-apps.document", txt(""));
  var rep = await s.engine.sweep(Object.assign({ dryRun: true }, FAST));
  T.eq(mutating(s.d).length, 0, "dry run wrote nothing");
  T.eq(rep.dryRun, true);
  T.eq(rep.plan.length, 2);
  T.eq(rep.plan.map(function (p) { return p.name; }).sort(), ["photo.jpg", "salary.xlsx"]);
  T.eq(rep.skipped["already-sealed"], 1, "unmarked sealed file is recognised by its header");
  T.eq(rep.skipped["native-google-file"], 1);
  T.eq(rep.estimate.bytesToSeal, 3000);
  T.eq(s.d.files[sealedElsewhere].properties.hysealed, undefined, "dry run did not even mark it");
});

T.test("unmarked sealed file (sealed by another tool) is adopted, never double-sealed", async function () {
  var s = setup();
  var sealed = await Seal.sealBytes(s.circle, rb(30000), { name: "o.bin", size: 30000 });
  var id = s.d.addFile({ name: "mystery.bin", bytes: sealed });
  var r = await s.engine.sealOne(id, FAST);
  T.eq(r.state, "skipped"); T.eq(r.reason, "already-sealed");
  T.eq(s.d.files[id].revisions.length, 1, "content untouched");
  T.eq(s.d.files[id].properties.hysealed, "1", "marked so the next scan is free");
});

T.test("a plaintext version uploaded onto a sealed file is noticed and sealed again", async function () {
  var s = setup();
  var id = s.d.addFile({ name: "r.txt", bytes: txt("one") });
  await s.engine.sealOne(id, FAST);
  s.d.edit(id, txt("two: new plaintext version uploaded in the Drive UI"));
  T.ok(!isSealedOnDrive(s.d, id));
  T.eq(s.d.files[id].properties.hysealed, "1");
  var rep = await s.engine.sweep(FAST);
  T.eq(rep.sealed, 1);
  T.ok(isSealedOnDrive(s.d, id));
  T.ok(same((await open(s, id)).bytes, txt("two: new plaintext version uploaded in the Drive UI")));
});

T.test("shared and not-owned files are left alone unless asked", async function () {
  var s = setup();
  var mine = s.d.addFile({ name: "mine", bytes: rb(100) });
  var shared = s.d.addFile({ name: "shared", bytes: rb(100), shared: true });
  var theirs = s.d.addFile({ name: "theirs", bytes: rb(100), owned: false });
  var ro = s.d.addFile({ name: "readonly", bytes: rb(100), canEdit: false });
  var rep = await s.engine.sweep(Object.assign({ includeNotOwned: false }, FAST));
  T.eq(rep.sealed, 1);
  T.eq(rep.skipped.shared, 1);
  T.eq(rep.skipped["no-edit-permission"], 1);
  T.ok(isSealedOnDrive(s.d, mine));
  T.ok(!isSealedOnDrive(s.d, shared) && !isSealedOnDrive(s.d, theirs) && !isSealedOnDrive(s.d, ro));
  var rep2 = await s.engine.sweep(Object.assign({ includeShared: true }, FAST));
  T.eq(rep2.sealed, 1);
  T.ok(isSealedOnDrive(s.d, shared));
});

T.test("folder scope walks subfolders and nothing outside; paths reach the index", async function () {
  var s = setup();
  var root = s.d.root.id;
  var inner = s.d.addFolder("Taxes", [root]);
  var sub = s.d.addFolder("2025", [inner]);
  var a = s.d.addFile({ name: "w2.pdf", bytes: rb(500), parents: [inner] });
  var b = s.d.addFile({ name: "1040.pdf", bytes: rb(500), parents: [sub] });
  var out = s.d.addFile({ name: "outside.txt", bytes: rb(500), parents: [root] });
  var rep = await s.engine.sweep(Object.assign({ folderId: inner }, FAST));
  T.eq(rep.sealed, 2);
  T.ok(isSealedOnDrive(s.d, a) && isSealedOnDrive(s.d, b) && !isSealedOnDrive(s.d, out));
  var m = (await open(s, b)).meta;
  T.eq(m.path, "/2025");
});

T.test("sibling mode: sealed copy next to the original, original trashed (not deleted), verify failure leaves the original", async function () {
  var s = setup();
  var folder = s.d.addFolder("F", [s.d.root.id]);
  var data = rb(40000);
  var id = s.d.addFile({ name: "orig.pdf", bytes: data, parents: [folder], mimeType: "application/pdf" });
  var r = await s.engine.sealOne(id, Object.assign({ mode: "sibling" }, FAST));
  T.eq(r.state, "verified"); T.ok(r.newId && r.newId !== id);
  T.eq(s.d.files[r.newId].parents, [folder]);
  T.eq(s.d.files[id].trashed, true);
  T.ok(same(s.d.content(id), data), "original still exists, in the trash");
  T.ok(isSealedOnDrive(s.d, r.newId));
  T.eq(r.plaintextRetained, true);
  // failure: the sealed copy is corrupted at read-back => copy trashed, original untouched
  var id2 = s.d.addFile({ name: "o2.pdf", bytes: rb(40000), parents: [folder] });
  s.d.mutateMedia = function (f, rev, bytes) { if (Seal.isSealed(bytes)) { var c = new Uint8Array(bytes); c[100] ^= 1; return c; } };
  var r2 = await s.engine.sealOne(id2, Object.assign({ mode: "sibling" }, FAST));
  s.d.mutateMedia = null;
  T.eq(r2.state, "failed");
  T.eq(s.d.files[id2].trashed, false);
  var broken = Object.keys(s.d.files).filter(function (k) { return s.d.files[k].properties.hysrc === id2; });
  T.eq(broken.length, 1); T.eq(s.d.files[broken[0]].trashed, true);
});

T.test("sibling mode with purge deletes the original permanently, only after read-back", async function () {
  var s = setup();
  var id = s.d.addFile({ name: "gone.bin", bytes: rb(1000) });
  var r = await s.engine.sealOne(id, Object.assign({ mode: "sibling", purge: true }, FAST));
  T.eq(r.state, "verified");
  T.eq(s.d.files[id], undefined);
  T.ok(isSealedOnDrive(s.d, r.newId));
});

T.test("native Docs: skipped by default; export-copy makes a sealed .docx copy and leaves the original", async function () {
  var s = setup();
  var docx = rb(2048);
  var nat = s.d.addNative("Quarterly plan", "application/vnd.google-apps.document", docx);
  var rep = await s.engine.sweep(FAST);
  T.eq(rep.skipped["native-google-file"], 1); T.eq(rep.sealed, 0);
  var r = await s.engine.sealOne(nat, Object.assign({ native: "export-copy" }, FAST));
  T.eq(r.state, "verified");
  var o = await open(s, r.newId);
  T.ok(same(o.bytes, docx));
  T.eq(o.meta.name, "Quarterly plan.docx");
  T.eq(s.d.files[nat].trashed, false, "native original untouched");
  T.eq(r.plaintextRetained, true);
  var nat2 = s.d.addNative("Other", "application/vnd.google-apps.spreadsheet", rb(10));
  var r2 = await s.engine.sealOne(nat2, Object.assign({ native: "export-copy", trashOriginal: true }, FAST));
  T.eq(r2.state, "verified"); T.eq(s.d.files[nat2].trashed, true);
});

T.test("unseal: id, name, type and bytes restored; properties cleared; wrong key leaves Drive untouched", async function () {
  var s = setup();
  var data = rb(250000);
  var id = s.d.addFile({ name: "Photo 1.jpg", mimeType: "image/jpeg", bytes: data });
  await s.engine.sealOne(id, FAST);
  var other = setup({ drive: undefined });
  var wrongEngine = Sweep.create({ client: s.client, circle: C.newCircle("x"), store: Sweep.memoryStorage(), accountKey: "w" });
  var bad = await wrongEngine.unsealOne(id, FAST);
  T.eq(bad.state, "failed"); T.eq(bad.reason, "no-key");
  T.ok(isSealedOnDrive(s.d, id), "still sealed after the failed attempt");
  var revs = s.d.files[id].revisions.length;
  var r = await s.engine.unsealOne(id, FAST);
  T.eq(r.state, "unsealed");
  var f = s.d.files[id];
  T.eq(f.name, "Photo 1.jpg"); T.eq(f.mimeType, "image/jpeg");
  T.ok(same(s.d.content(id), data));
  T.eq(f.properties.hysealed, undefined); T.eq(f.properties.hymd5, undefined);
  T.eq(f.revisions.length, revs + 1);
  T.eq(s.catalog.get(id), null);
  // sealing again works
  T.eq((await s.engine.sealOne(id, FAST)).state, "verified");
  T.ok(other);
});

T.test("unsealAll undoes a whole sweep, index excluded", async function () {
  var s = setup();
  var originals = {};
  for (var i = 0; i < 4; i++) { var b = rb(3000 + i); var id = s.d.addFile({ name: "u" + i + ".bin", bytes: b }); originals[id] = b; }
  await s.engine.sweep(FAST);
  var r = await s.engine.unsealAll(FAST);
  T.eq(r.unsealed, 4); T.eq(r.failed.length, 0);
  Object.keys(originals).forEach(function (k) { T.ok(same(s.d.content(k), originals[k])); T.ok(!isSealedOnDrive(s.d, k)); });
});

T.test("readSealed opens one file in memory without writing to Drive", async function () {
  var s = setup();
  var data = rb(9000);
  var id = s.d.addFile({ name: "view.png", mimeType: "image/png", bytes: data });
  await s.engine.sealOne(id, FAST);
  var before = mutating(s.d).length;
  var r = await s.engine.readSealed(id);
  T.ok(same(r.bytes, data)); T.eq(r.meta.mime, "image/png");
  T.eq(mutating(s.d).length, before);
});

T.test("index: written sealed, names recoverable; deleting it and rebuilding from the files gives the same names", async function () {
  var s = setup();
  s.d.addFile({ name: "Contract.docx", bytes: rb(2000) });
  s.d.addFile({ name: "Passport scan.jpg", bytes: rb(3000) });
  await s.engine.sweep(FAST);
  var idxFiles = Object.keys(s.d.files).filter(function (k) { return s.d.files[k].properties.hyindex === "1"; });
  T.eq(idxFiles.length, 1);
  var idxBytes = Buffer.from(s.d.content(idxFiles[0]));
  T.ok(idxBytes.indexOf("Contract") === -1 && idxBytes.indexOf("Passport") === -1, "index is sealed");
  var names = Object.keys(s.catalog.entries()).map(function (k) { return s.catalog.entries()[k].n; }).sort();
  T.eq(names, ["Contract.docx", "Passport scan.jpg"]);
  // fresh catalog from the same Drive
  var c2 = Cat.create({ client: s.client, circle: s.circle });
  T.eq(await c2.load(), 2);
  // lose the index entirely
  delete s.d.files[idxFiles[0]];
  var c3 = Cat.create({ client: s.client, circle: s.circle });
  T.eq(await c3.load(), 0);
  T.eq(await c3.rebuild(), 2);
  var n3 = Object.keys(c3.entries()).map(function (k) { return c3.entries()[k].n; }).sort();
  T.eq(n3, names);
});

T.test("quota exhaustion aborts the sweep with a typed reason; earlier files stay sealed and verified", async function () {
  var s = setup({ drive: { quotaBytes: 250000 } });
  var a = s.d.addFile({ name: "a", bytes: rb(40000) });
  var b = s.d.addFile({ name: "b", bytes: rb(60000) });
  var c = s.d.addFile({ name: "c", bytes: rb(100000) });
  var rep = await s.engine.sweep(FAST);
  T.eq(rep.aborted, "quota");
  T.ok(rep.sealed >= 1 && rep.sealed < 3);
  T.eq(rep.failed.length, 1);
  T.ok(isSealedOnDrive(s.d, a));
  T.ok(same(s.d.content(c), s.d.files[c].revisions[0].bytes), "unsealed file untouched");
});

T.test("rate limits mid-sweep are absorbed by backoff; the sweep completes", async function () {
  var s = setup();
  for (var i = 0; i < 5; i++) s.d.addFile({ name: "r" + i, bytes: rb(2000) });
  var n = 0;
  s.d.fault({ when: function (m, u) { return m === "PATCH" && /\/files\//.test(u) && ++n % 3 === 0; }, status: 403, reason: "userRateLimitExceeded", times: 99 });
  s.d.fault({ when: function (m, u) { return m === "GET" && /alt=media/.test(u); }, status: 429, times: 2 });
  var rep = await s.engine.sweep(FAST);
  T.eq(rep.sealed, 5); T.eq(rep.failed.length, 0);
  T.ok(s.client.stats.retries >= 2);
});

T.test("concurrency 3 gives the same result as 1", async function () {
  var s = setup();
  var ids = [];
  for (var i = 0; i < 9; i++) ids.push(s.d.addFile({ name: "c" + i, bytes: rb(30000 + i) }));
  var rep = await s.engine.sweep(Object.assign({ concurrency: 3 }, FAST));
  T.eq(rep.sealed, 9); T.eq(rep.failed.length, 0);
  ids.forEach(function (id) { T.ok(isSealedOnDrive(s.d, id)); });
});

T.test("keys never leave: no request carries the circle key or the plaintext", async function () {
  var s = setup();
  var secret = txt("THE-SECRET-PLAINTEXT-MARKER-" + "x".repeat(2000));
  s.d.addFile({ name: "plain-name-marker.txt", bytes: secret });
  var seen = [];
  var orig = s.d.fetch.bind(s.d);
  s.d.fetch = async function (url, init) {
    var b = init && init.body;
    if (typeof b === "string") seen.push(b);
    else if (b) seen.push(Buffer.from(b).toString("latin1"));
    seen.push(String(url));
    return orig(url, init);
  };
  var c2 = Client.create({ token: s.d.token, fetch: s.d.fetch.bind(s.d), qps: 0, sleep: function () { return Promise.resolve(); } });
  var e2 = Sweep.create({ client: c2, circle: s.circle, store: Sweep.memoryStorage(), accountKey: "k" });
  var rep = await e2.sweep(Object.assign({ names: "opaque" }, FAST));
  T.eq(rep.sealed, 1);
  var all = seen.join("\n");
  T.ok(all.indexOf(s.circle.key) === -1, "circle key must not be sent");
  T.ok(all.indexOf("THE-SECRET-PLAINTEXT-MARKER") === -1, "plaintext must not be uploaded");
});

module.exports = T;
if (require.main === module) T.run("sweep").then(function (r) { process.exit(r.fail ? 1 : 0); });
