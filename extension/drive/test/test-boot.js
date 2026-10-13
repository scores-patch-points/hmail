"use strict";
var L = require("./load.js");
var Seal = L.drive("seal.js");
var Sweep = L.drive("sweep.js");
var Boot = L.drive("boot.js");
var C = L.ext("crypto.js");
var T = require("./harness.js");
var M = L.here("mock-drive.js");
var nc = require("node:crypto");

function rb(n) { return new Uint8Array(nc.randomBytes(n)); }
function same(a, b) { return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0; }
function sealedOnDrive(d, id) { return Seal.isSealed(d.content(id)); }
function mutating(d) { return d.log.filter(function (l) { return l.method !== "GET"; }); }
function mediaReads(d) { return d.log.filter(function (l) { return /alt=media/.test(l.url); }); }

function world(o) {
  o = o || {};
  var d = o.drive || new M.MockDrive();
  var circle = o.circle || C.newCircle("drive");
  var storage = o.storage || Sweep.memoryStorage();
  var state = { token: o.noToken ? null : d.token, tokenCalls: [] };
  var circles = {}; circles[circle.kid] = circle;
  var runner = Boot.runner({
    getToken: function (a) { state.tokenCalls.push(a); if (!state.token) return Promise.reject(new Error("no token")); return Promise.resolve(state.token); },
    getCircles: function () { return Promise.resolve(o.circles || circles); },
    storage: storage, fetch: d.fetch.bind(d), sleep: function () { return Promise.resolve(); }, accountKey: "acct",
  });
  return { d: d, circle: circle, storage: storage, state: state, runner: runner, circles: circles };
}

T.test("auto is off by default: no token fetched, no request made", async function () {
  var w = world();
  w.d.addFile({ name: "a", bytes: rb(100) });
  var r = await w.runner.auto();
  T.eq(r, { ran: false, skipped: "disabled" });
  T.eq(w.d.log.length, 0);
  T.eq(w.state.tokenCalls.length, 0);
});

T.test("no circle, ambiguous circles, and no token each skip cleanly without touching Drive", async function () {
  var w1 = world({ circles: {} });
  await w1.runner.setSettings({ enabled: true });
  T.eq((await w1.runner.auto()).skipped, "no-circle");
  var a = C.newCircle("a"), b = C.newCircle("b"), two = {}; two[a.kid] = a; two[b.kid] = b;
  var w2 = world({ circles: two });
  await w2.runner.setSettings({ enabled: true });
  T.eq((await w2.runner.auto()).skipped, "no-circle", "two circles and no choice made");
  await w2.runner.setSettings({ circleKid: b.kid });
  w2.d.addFile({ name: "x", bytes: rb(10) });
  T.eq((await w2.runner.auto()).ran, true);
  T.eq(w2.d.files[Object.keys(w2.d.files).filter(function (k) { return w2.d.files[k].name !== "My Drive" && w2.d.files[k].properties.hykid; })[0]].properties.hykid, b.kid);
  var w3 = world({ noToken: true });
  await w3.runner.setSettings({ enabled: true });
  T.eq((await w3.runner.auto()).skipped, "no-token");
  T.eq(w3.d.log.length, 0);
  T.ok(w3.state.tokenCalls.every(function (c) { return c.interactive === false; }), "startup never prompts");
});

T.test("fresh boot: first run is a full sweep, later boots use the changes feed and touch only what is new", async function () {
  var w = world();
  var old = [w.d.addFile({ name: "old1", bytes: rb(500) }), w.d.addFile({ name: "old2", bytes: rb(900) })];
  await w.runner.setSettings({ enabled: true });
  var r1 = await w.runner.auto();
  T.eq(r1.via, "full"); T.eq(r1.report.sealed, 2);
  old.forEach(function (id) { T.ok(sealedOnDrive(w.d, id)); });

  // a fresh process: new runner, same storage and Drive. Meanwhile the user uploaded two files.
  var fresh = w.d.addFile({ name: "new1", bytes: rb(700) });
  var fresh2 = w.d.addFile({ name: "new2", bytes: rb(100) });
  var w2 = world({ drive: w.d, circle: w.circle, storage: w.storage });
  var before = mediaReads(w.d).length;
  var r2 = await w2.runner.auto();
  T.eq(r2.via, "changes");
  T.eq(r2.report.sealed, 2);
  T.ok(sealedOnDrive(w.d, fresh) && sealedOnDrive(w.d, fresh2));
  // old files were never re-read: only the two new files (download + read-back each) and the index
  var reads = mediaReads(w.d).slice(before);
  T.ok(reads.every(function (l) { return old.every(function (id) { return l.url.indexOf("/files/" + id + "?") === -1; }); }), "untouched files not re-read");
  // our own writes show up in the next feed and are skipped for free
  var r3 = await w2.runner.auto();
  T.eq(r3.via, "changes"); T.eq(r3.report.sealed, 0);
  var st = await w2.runner.status();
  T.eq(st.lastRun.via, "changes");
  T.ok(st.ledger.verified >= 4);
});

T.test("auto dry run: no mutating request, ledger and tokens unchanged, plan returned", async function () {
  var w = world();
  w.d.addFile({ name: "doc.pdf", bytes: rb(3000) });
  w.d.addFile({ name: "pic.jpg", bytes: rb(1000) });
  // settings.enabled is false and dry run is still allowed: it only reads
  var snapshot = JSON.stringify(await w.storage.get("hyphae.drive.v1.acct"));
  var r = await w.runner.auto({ dryRun: true });
  T.eq(r.ran, true); T.eq(r.report.dryRun, true);
  T.eq(r.report.plan.length, 2);
  T.eq(mutating(w.d).length, 0, "nothing written to Drive");
  T.eq(JSON.stringify(await w.storage.get("hyphae.drive.v1.acct")), snapshot, "ledger untouched");
  var st = await w.runner.status();
  T.eq(st.lastFullAt, null);
});

T.test("a stale changes token falls back to a full sweep", async function () {
  var w = world();
  await w.runner.setSettings({ enabled: true });
  w.d.addFile({ name: "a", bytes: rb(50) });
  await w.runner.auto();
  var L = await w.storage.get("hyphae.drive.v1.acct");
  L.meta.changesToken = "99999";
  await w.storage.set("hyphae.drive.v1.acct", L);
  var late = w.d.addFile({ name: "late", bytes: rb(60) });
  var r = await w.runner.auto();
  T.eq(r.via, "full");
  T.ok(sealedOnDrive(w.d, late));
});

T.test("weekly full sweep is due even when the changes token is fine", async function () {
  var w = world();
  await w.runner.setSettings({ enabled: true, fullEveryDays: 7 });
  w.d.addFile({ name: "a", bytes: rb(50) });
  await w.runner.auto();
  var L = await w.storage.get("hyphae.drive.v1.acct");
  L.meta.lastFullAt = Date.now() - 8 * 86400000;
  await w.storage.set("hyphae.drive.v1.acct", L);
  var r = await w.runner.auto();
  T.eq(r.via, "full");
});

T.test("folder-scoped auto ignores changes elsewhere", async function () {
  var w = world();
  var f = w.d.addFolder("Private", [w.d.root.id]);
  var sub = w.d.addFolder("Sub", [f]);
  await w.runner.setSettings({ enabled: true, folderId: f });
  await w.runner.auto();
  var inside = w.d.addFile({ name: "in", bytes: rb(40), parents: [sub] });
  var outside = w.d.addFile({ name: "out", bytes: rb(40), parents: [w.d.root.id] });
  var r = await w.runner.auto();
  T.eq(r.via, "changes");
  T.ok(sealedOnDrive(w.d, inside)); T.ok(!sealedOnDrive(w.d, outside));
});

T.test("a failed file is retried on the next boot via the changes path, up to the attempt limit", async function () {
  var w = world();
  await w.runner.setSettings({ enabled: true });
  await w.runner.auto();
  var id = w.d.addFile({ name: "flaky", bytes: rb(4000) });
  var corrupt = true;
  w.d.mutateMedia = function (f, rev, bytes) { if (corrupt && f.id === id && !Seal.isSealed(bytes)) { var c = new Uint8Array(bytes); c[3] ^= 1; return c; } };
  var r1 = await w.runner.auto();
  T.eq(r1.report.failed.length, 1);
  T.ok(!sealedOnDrive(w.d, id));
  corrupt = false;
  var r2 = await w.runner.auto();
  T.eq(r2.report.sealed, 1);
  T.ok(sealedOnDrive(w.d, id));
});

T.test("settings: purge applies in auto; names and mode are honoured", async function () {
  var w = world();
  await w.runner.setSettings({ enabled: true, purge: true, names: "suffix" });
  var id = w.d.addFile({ name: "p.txt", bytes: rb(2000) });
  var r = await w.runner.auto();
  T.eq(r.report.purged, 1);
  T.eq(w.d.files[id].revisions.length, 1);
  T.eq(w.d.files[id].name, "p.txt.hyd");
});

T.test("runs are exclusive: a second call during a run reports busy", async function () {
  var w = world();
  await w.runner.setSettings({ enabled: true });
  w.d.addFile({ name: "a", bytes: rb(1000) });
  var p1 = w.runner.auto();
  var r2 = await w.runner.auto();
  T.eq(r2.skipped, "busy");
  var r1 = await p1;
  T.eq(r1.ran, true);
});

T.test("route: only extension pages may drive it; content scripts are refused; unknown ops answer an error", async function () {
  var w = world();
  var fromPage = await Boot.route(w.runner, { hyphae: "drive", op: "status" }, { tab: { id: 3 }, id: "ext" }, "ext");
  T.ok(/refused/.test(fromPage.error));
  var otherExt = await Boot.route(w.runner, { hyphae: "drive", op: "status" }, { id: "evil" }, "ext");
  T.ok(/refused/.test(otherExt.error));
  var st = await Boot.route(w.runner, { hyphae: "drive", op: "status" }, { id: "ext" }, "ext");
  T.ok(st.settings && st.settings.enabled === false);
  T.eq((await Boot.route(w.runner, { hyphae: "drive", op: "nope" }, { id: "ext" }, "ext")).error, "unknown drive op");
  T.eq(Boot.route(w.runner, { hyphae: "seal" }, { id: "ext" }, "ext"), null, "not a drive message");
  var read = await Boot.route(w.runner, { hyphae: "drive", op: "read", args: { id: "x" } }, { tab: { id: 1 } }, "ext");
  T.ok(/refused/.test(read.error), "opened plaintext never goes to a page");
});

T.test("arm: registers a startup listener and a periodic alarm that call auto", async function () {
  var calls = 0, startup = [], alarms = [], created = null;
  var chromeApi = {
    runtime: { onStartup: { addListener: function (f) { startup.push(f); } } },
    alarms: { create: function (n, i) { created = { n: n, i: i }; }, onAlarm: { addListener: function (f) { alarms.push(f); } } },
  };
  Boot.arm(chromeApi, { auto: function () { calls++; return Promise.resolve({}); } }, { startupDelayMs: 0 });
  T.eq(created.n, Boot.ALARM); T.eq(created.i.periodInMinutes, 180);
  startup[0]();
  await new Promise(function (r) { setTimeout(r, 10); });
  T.eq(calls, 1);
  alarms[0]({ name: "something-else" });
  T.eq(calls, 1);
  alarms[0]({ name: Boot.ALARM });
  T.eq(calls, 2);
});

T.test("rebuildIndex and unsealAll through the runner", async function () {
  var w = world();
  var id = w.d.addFile({ name: "Résumé.pdf", mimeType: "application/pdf", bytes: rb(1500) });
  await w.runner.sweep();
  var rb2 = await w.runner.rebuildIndex();
  T.eq(rb2.entries, 1);
  var rd = await w.runner.read(id);
  T.eq(rd.meta.name, "Résumé.pdf");
  var un = await w.runner.unsealAll();
  T.eq(un.report.unsealed, 1);
  T.ok(!sealedOnDrive(w.d, id));
});

T.test("token helpers: getAuthToken with refresh evicts the cached token; web auth flow parses the fragment and is silent at startup", async function () {
  var removed = [], n = 0, last = { lastError: null };
  var chromeApi = {
    runtime: last,
    identity: {
      getAuthToken: function (o, cb) { n++; cb("tok-" + n); },
      removeCachedAuthToken: function (o, cb) { removed.push(o.token); cb(); },
    },
  };
  var get = Boot.chromeIdentityToken(chromeApi);
  T.eq(await get({ interactive: false }), "tok-1");
  T.eq(await get({ refresh: true }), "tok-2");
  T.eq(removed, ["tok-1"]);
  chromeApi.runtime.lastError = { message: "not signed in" };
  var e = await T.rejects(function () { return get({}); });
  T.ok(/not signed in/.test(e.message));

  var urls = [];
  var web = {
    runtime: { lastError: null },
    identity: {
      getRedirectURL: function () { return "https://abc.chromiumapp.org/"; },
      launchWebAuthFlow: function (o, cb) { urls.push(o); cb("https://abc.chromiumapp.org/#access_token=ya29.x&expires_in=3599&token_type=Bearer"); },
    },
  };
  var wt = Boot.webAuthFlowToken(web, { clientId: "cid.apps.googleusercontent.com" });
  T.eq(await wt({ interactive: false }), "ya29.x");
  T.ok(/prompt=none/.test(urls[0].url) && urls[0].interactive === false, "startup flow is silent");
  T.ok(/scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive/.test(urls[0].url));
  T.eq(await wt({ interactive: false }), "ya29.x");
  T.eq(urls.length, 1, "cached until near expiry");
  await wt({ refresh: true, interactive: true });
  T.eq(urls.length, 2);
  T.ok(!/prompt=none/.test(urls[1].url));
});

T.test("worker-style load: the six scripts in importScripts order, no module, no require, only globals", async function () {
  var vm = require("node:vm"), fs = require("node:fs");
  var ctx = vm.createContext({
    TextEncoder: TextEncoder, TextDecoder: TextDecoder, atob: atob, btoa: btoa, URLSearchParams: URLSearchParams,
    ReadableStream: ReadableStream, Response: Response, Uint8Array: Uint8Array, Uint32Array: Uint32Array, Promise: Promise,
    crypto: nc.webcrypto, setTimeout: setTimeout, JSON: JSON, Math: Math, Date: Date,
  });
  ctx.self = ctx;
  ["hash.js", "seal.js", "client.js", "sweep.js", "catalog.js", "boot.js"].forEach(function (f) {
    vm.runInContext(fs.readFileSync(L.DRIVE + "/" + f, "utf8"), ctx, { filename: f });
  });
  ["HyHash", "HyDriveSeal", "HyDriveClient", "HyDriveSweep", "HyDriveCatalog", "HyDriveBoot"].forEach(function (g) {
    T.ok(ctx[g] && typeof ctx[g] === "object", g + " global");
  });
  // and it works: seal and open through the worker-global API
  var circle = C.newCircle("w"), m = {}; m[circle.kid] = circle;
  var src = new Uint8Array(5000);
  var sealed = await ctx.HyDriveSeal.sealBytes(circle, src, { name: "w" });
  var r = await ctx.HyDriveSeal.openBytes(m, sealed);
  T.eq(r.bytes.length, 5000);
});

T.test("mock-drive.js is a classic script: no module, no require; seed, list, bytes and fetch drive the real client and sweep", async function () {
  var vm = require("node:vm"), fs = require("node:fs");
  var ctx = vm.createContext({
    TextEncoder: TextEncoder, TextDecoder: TextDecoder, atob: atob, btoa: btoa, URLSearchParams: URLSearchParams, URL: URL,
    ReadableStream: ReadableStream, Response: Response, Uint8Array: Uint8Array, Uint32Array: Uint32Array, Promise: Promise,
    crypto: nc.webcrypto, setTimeout: setTimeout, JSON: JSON, Math: Math, Date: Date, Object: Object, Array: Array,
  });
  ctx.self = ctx;
  ["hash.js", "seal.js", "client.js", "sweep.js", "catalog.js", "mock-drive.js"].forEach(function (f) {
    var dir = f === "mock-drive.js" ? __dirname : L.DRIVE;
    vm.runInContext(fs.readFileSync(dir + "/" + f, "utf8"), ctx, { filename: f });
  });
  T.ok(ctx.HyMockDrive && typeof ctx.HyMockDrive.create === "function");
  var drive = ctx.HyMockDrive.create();
  var id = drive.seed({ name: "Report.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1, 2, 3, 4, 5]), ownedByMe: true, shared: false, properties: { tag: "x" } });
  var sharedId = drive.seed({ name: "Shared.txt", bytes: new Uint8Array([9]), shared: true });
  var rows = drive.list();
  T.eq(rows.length, 2);
  T.eq(rows.filter(function (r) { return r.id === id; })[0].properties.tag, "x");
  T.eq(Array.prototype.slice.call(drive.bytes(id)), [1, 2, 3, 4, 5]);
  var client = ctx.HyDriveClient.create({ token: drive.token, fetch: drive.fetch, qps: 0 });
  var circle = C.newCircle("demo"); // crypto.js loaded from the real extension, passed as plain data
  var engine = ctx.HyDriveSweep.create({ client: client, circle: { kid: circle.kid, name: "demo", key: circle.key }, accountKey: "demo" });
  var rep = await engine.sweep({ chunkSize: 64 * 1024 });
  T.eq(rep.sealed, 1); T.eq(rep.skipped.shared, 1);
  var after = drive.list().filter(function (r) { return r.id === id; })[0];
  T.eq(after.revisions, 2);
  T.ok(/^hy-[a-z2-7]{24}\.hyd$/.test(after.name));
  T.ok(ctx.HyDriveSeal.isSealed(drive.bytes(id)));
  T.eq(Array.prototype.slice.call(drive.bytes(id, 0)), [1, 2, 3, 4, 5], "oldest revision still the plaintext");
  T.ok(sharedId);
});

module.exports = T;
if (require.main === module) T.run("boot").then(function (r) { process.exit(r.fail ? 1 : 0); });
