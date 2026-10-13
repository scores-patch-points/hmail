"use strict";
var L = require("./load.js");
var S = L.drive("seal.js");
var C = L.ext("crypto.js");
var nc = require("node:crypto");
var T = require("./harness.js");

var circle = C.newCircle("drive");
var other = C.newCircle("other");
var circles = {}; circles[circle.kid] = circle;
var META = { name: "Tax return 2025.pdf", mime: "application/pdf", size: 0, mtime: "2026-01-02T03:04:05.000Z", id: "1abc" };

function rb(n) { return new Uint8Array(nc.randomBytes(n)); }
function same(a, b) { return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0; }
function cat(list) { return S.concat(list); }

// Open, treating "write didn't throw but end() did" as a refusal too. Returns {ok, code}.
async function tryOpen(c, bytes, piece) {
  var o = S.createOpener(c), plain = [];
  try {
    if (piece) { for (var i = 0; i < bytes.length; i += piece) plain = plain.concat(await o.write(bytes.subarray(i, i + piece))); }
    else plain = await o.write(bytes);
    await o.end();
    return { ok: true, plain: cat(plain) };
  } catch (e) { return { ok: false, code: e.code, msg: e.message }; }
}
// Parse a sealed file into [header, record, record, ...] frames.
function frames(sealed) {
  var out = [sealed.subarray(0, S.HEADER_LEN)], o = S.HEADER_LEN;
  while (o < sealed.length) {
    var w = ((sealed[o] << 24) | (sealed[o + 1] << 16) | (sealed[o + 2] << 8) | sealed[o + 3]) >>> 0;
    var len = (w & 0x7fffffff);
    out.push(sealed.subarray(o, o + 4 + len));
    o += 4 + len;
  }
  return out;
}

T.test("round trip: empty, 1 byte, chunk-1, chunk, chunk+1, several chunks", async function () {
  var cs = 4096;
  var sizes = [0, 1, cs - 1, cs, cs + 1, 3 * cs, 3 * cs + 7, 100000];
  for (var i = 0; i < sizes.length; i++) {
    var data = rb(sizes[i]);
    var sealed = await S.sealBytes(circle, data, META, { chunkSize: cs });
    var metaLen = S.encodeMeta(META).length;
    T.eq(sealed.length, S.sealedSize(sizes[i], metaLen, cs), "sealedSize at " + sizes[i]);
    var r = await S.openBytes(circles, sealed);
    T.ok(same(r.bytes, data), "plaintext at " + sizes[i]);
    T.eq(r.meta.name, META.name);
    T.eq(r.manifest.size, sizes[i]);
    T.eq(r.manifest.kid, circle.kid);
  }
});

T.test("header carries the circle id and magic; ciphertext shows nothing of the plaintext", async function () {
  var data = new TextEncoder().encode("Dear Dr. Smith, my diagnosis is".repeat(500));
  var sealed = await S.sealBytes(circle, data, META);
  var h = S.parseHeader(sealed);
  T.eq(h.kid, circle.kid);
  T.eq(new TextDecoder().decode(sealed.subarray(0, 4)), "HYD1");
  T.ok(Buffer.from(sealed).indexOf("diagnosis") === -1, "plaintext must not appear");
  T.ok(Buffer.from(sealed).indexOf("Tax return") === -1, "name must not appear");
  T.ok(S.isSealed(sealed) && !S.isSealed(data));
});

T.test("two seals of the same file differ (fresh salt and nonce)", async function () {
  var data = rb(5000);
  var a = await S.sealBytes(circle, data, META), b = await S.sealBytes(circle, data, META);
  T.ok(!same(a, b));
  T.ok(!same(a.subarray(18, 62), b.subarray(18, 62)));
});

T.test("streaming: opener and sealer accept arbitrary piece sizes, byte at a time included", async function () {
  var data = rb(40000), cs = 4096;
  var s = await S.createSealer(circle, META, { chunkSize: cs });
  var out = [], i = 0;
  var steps = [1, 7, 4095, 4096, 4097, 1, 12345, 3];
  var k = 0;
  while (i < data.length) {
    var n = Math.min(steps[k++ % steps.length], data.length - i);
    out = out.concat(await s.write(data.subarray(i, i + n)));
    i += n;
  }
  out = out.concat(await s.end());
  var sealed = cat(out);
  T.eq(sealed.length, S.sealedSize(data.length, s.metaBytes.length, cs));
  T.eq(s.manifest.size, data.length);
  // open in 1-byte, 5-byte and 100000-byte pieces
  var small = sealed.subarray(0, 9000);
  var r1 = await tryOpen(circles, sealed, 1000);
  T.ok(r1.ok && same(r1.plain, data), "1000-byte pieces");
  var r2 = await tryOpen(circles, sealed, 5);
  T.ok(r2.ok && same(r2.plain, data), "5-byte pieces");
  var r3 = await tryOpen(circles, sealed, 1 << 20);
  T.ok(r3.ok && same(r3.plain, data), "one piece");
  T.ok(small.length === 9000);
});

T.test("web streams: sealStream | openStream round trip", async function () {
  var data = rb(300000);
  var src = new ReadableStream({
    start: function (c) { for (var i = 0; i < data.length; i += 777) c.enqueue(data.subarray(i, i + 777)); c.close(); },
  });
  var sealedStream = S.sealStream(circle, src, META, { chunkSize: 8192 });
  var openedStream = S.openStream(circles, sealedStream);
  var rd = openedStream.getReader(), parts = [];
  for (;;) { var r = await rd.read(); if (r.done) break; parts.push(r.value); }
  T.ok(same(cat(parts), data));
});

T.test("wrong key: same circle id, different key is refused as 'auth'", async function () {
  var sealed = await S.sealBytes(circle, rb(9000), META, { chunkSize: 4096 });
  var impostor = { kid: circle.kid, name: "x", key: other.key };
  var m = {}; m[circle.kid] = impostor;
  var r = await tryOpen(m, sealed);
  T.ok(!r.ok); T.eq(r.code, "auth");
});

T.test("circle not held: refused as 'no-key'", async function () {
  var sealed = await S.sealBytes(circle, rb(100), META);
  var m = {}; m[other.kid] = other;
  var r = await tryOpen(m, sealed);
  T.ok(!r.ok); T.eq(r.code, "no-key");
  r = await tryOpen({}, sealed);
  T.eq(r.code, "no-key");
});

T.test("re-label: header rewritten to another circle's id is refused", async function () {
  var sealed = new Uint8Array(await S.sealBytes(circle, rb(9000), META, { chunkSize: 4096 }));
  var h = S.parseHeader(sealed);
  var otherKid = Buffer.from(other.kid.replace(/-/g, "+").replace(/_/g, "/") + "=", "base64");
  var forged = new Uint8Array(sealed);
  forged.set(otherKid.subarray(0, 8), 6);
  var m = {}; m[other.kid] = other;
  var r = await tryOpen(m, forged);
  T.ok(!r.ok, "relabelled file must not open under the new circle");
  T.eq(r.code, "auth");
  T.ok(h.kid === circle.kid);
});

T.test("tamper: flipping ANY single byte of a sealed file is refused", async function () {
  var data = rb(9000);
  var sealed = await S.sealBytes(circle, data, META, { chunkSize: 4096 });
  var accepted = [];
  for (var i = 0; i < sealed.length; i++) {
    var bad = new Uint8Array(sealed);
    bad[i] ^= 0x01;
    var r = await tryOpen(circles, bad);
    if (r.ok) accepted.push(i);
  }
  T.eq(accepted, [], "bytes whose flip was accepted");
});

T.test("truncation: every proper prefix is refused, including at record boundaries", async function () {
  var sealed = await S.sealBytes(circle, rb(9000), META, { chunkSize: 4096 });
  var accepted = [];
  for (var n = 0; n < sealed.length; n++) {
    var r = await tryOpen(circles, sealed.subarray(0, n));
    if (r.ok) accepted.push(n);
  }
  T.eq(accepted, []);
  // and specifically: cut exactly before the FINAL record, leaving only whole records
  var fr = frames(sealed);
  var noFinal = cat(fr.slice(0, fr.length - 1));
  var r2 = await tryOpen(circles, noFinal);
  T.ok(!r2.ok); T.eq(r2.code, "truncated");
});

T.test("extension: trailing byte, and a whole extra valid-looking record, are refused", async function () {
  var sealed = await S.sealBytes(circle, rb(9000), META, { chunkSize: 4096 });
  var r = await tryOpen(circles, cat([sealed, new Uint8Array([0])]));
  T.ok(!r.ok); T.eq(r.code, "trailing-data");
  var fr = frames(sealed);
  // append a copy of the first data record after FINAL
  r = await tryOpen(circles, cat([sealed, fr[2]]));
  T.ok(!r.ok);
  // insert an extra data record BEFORE final
  r = await tryOpen(circles, cat([fr[0], fr[1], fr[2], fr[2], fr[3], fr[4]]));
  T.ok(!r.ok);
});

T.test("reorder: swapped, repeated, and dropped chunks are refused", async function () {
  var sealed = await S.sealBytes(circle, rb(4096 * 4 + 10), META, { chunkSize: 4096 });
  var fr = frames(sealed); // [hdr, meta, d1, d2, d3, d4, d5(short), final]
  T.eq(fr.length, 8);
  var cases = {
    swap: [fr[0], fr[1], fr[3], fr[2], fr[4], fr[5], fr[6], fr[7]],
    repeat: [fr[0], fr[1], fr[2], fr[2], fr[4], fr[5], fr[6], fr[7]],
    dropMiddle: [fr[0], fr[1], fr[2], fr[4], fr[5], fr[6], fr[7]],
    dropFirst: [fr[0], fr[1], fr[3], fr[4], fr[5], fr[6], fr[7]],
    metaMoved: [fr[0], fr[2], fr[1], fr[3], fr[4], fr[5], fr[6], fr[7]],
    shortBeforeFull: [fr[0], fr[1], fr[2], fr[3], fr[4], fr[6], fr[5], fr[7]],
  };
  var names = Object.keys(cases);
  for (var i = 0; i < names.length; i++) {
    var r = await tryOpen(circles, cat(cases[names[i]]));
    T.ok(!r.ok, names[i] + " must be refused");
  }
  T.eq((await tryOpen(circles, cat(fr))).ok, true);
});

T.test("splice: a chunk from another file under the same circle is refused", async function () {
  var a = await S.sealBytes(circle, rb(4096 * 3), META, { chunkSize: 4096 });
  var b = await S.sealBytes(circle, rb(4096 * 3), META, { chunkSize: 4096 });
  var fa = frames(a), fb = frames(b);
  var r = await tryOpen(circles, cat([fa[0], fa[1], fa[2], fb[3], fa[4], fa[5]]));
  T.ok(!r.ok); T.eq(r.code, "tampered");
  // a's records under b's header
  r = await tryOpen(circles, cat([fb[0]].concat(fa.slice(1))));
  T.ok(!r.ok);
});

T.test("a header-only rewrite of chunkSize is refused (header is authenticated)", async function () {
  var sealed = new Uint8Array(await S.sealBytes(circle, rb(8192), META, { chunkSize: 4096 }));
  var forged = new Uint8Array(sealed);
  forged[16] = 0x20; // chunkSize 4096 -> 8192 (0x2000): still in range, wrong AAD
  var r = await tryOpen(circles, forged);
  T.ok(!r.ok);
});

T.test("chunk size in the header is authenticated even where no other check would notice it", async function () {
  // one short chunk: a chunkSize rewrite from 4096 to 8192 leaves the file structurally valid
  var sealed = new Uint8Array(await S.sealBytes(circle, rb(100), META, { chunkSize: 4096 }));
  var forged = new Uint8Array(sealed);
  forged[16] = 0x20; // 0x00001000 -> 0x00002000
  var r = await tryOpen(circles, forged);
  T.ok(!r.ok, "header rewrite accepted");
  T.eq(r.code, "auth");
});

T.test("a writer bug that records a wrong plaintext hash in the manifest is refused on open", async function () {
  var fs = require("node:fs");
  var realHash = L.drive("hash.js"), lie = false;
  var fake = { md5: realHash.md5, hex: realHash.hex, sha256: function () {
    var h = realHash.sha256(), d = h.digest.bind(h);
    h.digest = function () { var out = d(); if (lie) out[0] ^= 1; return out; };
    return h;
  } };
  var mod = { exports: {} };
  new Function("module", "exports", "require", fs.readFileSync(L.DRIVE + "/seal.js", "utf8"))(mod, mod.exports, function (id) { return id === "./hash.js" ? fake : require(id); });
  lie = true;
  var bad = await mod.exports.sealBytes(circle, rb(5000), META, { chunkSize: 4096 });
  lie = false;
  var r = await tryOpen(circles, bad);
  T.ok(!r.ok); T.eq(r.code, "manifest");
});

T.test("bounded buffering: a header that asks for a 4 GiB chunk, or a frame claiming 2 GiB, is refused before reading it", async function () {
  var sealed = new Uint8Array(await S.sealBytes(circle, rb(100), META, { chunkSize: 4096 }));
  var f = new Uint8Array(sealed);
  f[14] = 0xff; f[15] = 0xff; f[16] = 0xff; f[17] = 0xff;
  var r = await tryOpen(circles, f);
  T.ok(!r.ok); T.eq(r.code, "bad-header");
  var g = new Uint8Array(sealed);
  var o = S.HEADER_LEN; // first record length word
  g[o] = 0x7f; g[o + 1] = 0xff; g[o + 2] = 0xff; g[o + 3] = 0xff;
  r = await tryOpen(circles, g.subarray(0, o + 4 + 100));
  T.ok(!r.ok); T.eq(r.code, "bad-frame");
});

T.test("not a sealed file: plain bytes are 'bad-header' (or truncated when shorter than a header)", async function () {
  var r = await tryOpen(circles, rb(500));
  T.ok(!r.ok); T.eq(r.code, "bad-header");
  r = await tryOpen(circles, new TextEncoder().encode("hello"));
  T.ok(!r.ok); T.eq(r.code, "truncated");
});

T.test("the file key is a subkey, not the circle key (a text token key can't open a file record)", async function () {
  var sealed = await S.sealBytes(circle, rb(100), META, { chunkSize: 4096 });
  var fr = frames(sealed);
  var raw = Buffer.from(circle.key.replace(/-/g, "+").replace(/_/g, "/") + "=", "base64");
  var key = await nc.webcrypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
  var hdr = fr[0], ct = fr[1].subarray(4);
  var nonce = new Uint8Array(hdr.subarray(50, 62));
  var aad = new Uint8Array(S.HEADER_LEN + 5); aad.set(hdr, 0); aad[S.HEADER_LEN] = 0x4d;
  var threw = false;
  try { await nc.webcrypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, ct); } catch (e) { threw = true; }
  T.ok(threw, "circle key itself must not decrypt a file record");
});

T.test("throughput: 48 MiB streamed through seal then open at 64 KiB pieces", async function () {
  var total = 48 * 1048576, piece = rb(65536);
  var s = await S.createSealer(circle, META);
  var sealedParts = [], t0 = Date.now(), written = 0;
  while (written < total) { sealedParts = sealedParts.concat(await s.write(piece)); written += piece.length; }
  sealedParts = sealedParts.concat(await s.end());
  var t1 = Date.now();
  var o = S.createOpener(circles), got = 0;
  for (var i = 0; i < sealedParts.length; i++) {
    var out = await o.write(sealedParts[i]);
    for (var j = 0; j < out.length; j++) got += out[j].length;
  }
  var m = await o.end();
  var t2 = Date.now();
  T.eq(got, total); T.eq(m.size, total);
  process.stdout.write("      seal " + Math.round(48000 / (t1 - t0)) + " MB/s, open " + Math.round(48000 / (t2 - t1)) + " MB/s\n");
});

module.exports = T;
if (require.main === module) T.run("seal").then(function (r) { process.exit(r.fail ? 1 : 0); });
