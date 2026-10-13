"use strict";
var H = require("./load.js").drive("hash.js");
var nc = require("node:crypto");
var T = require("./harness.js");

function ref(alg, bytes) { return new Uint8Array(nc.createHash(alg).update(bytes).digest()); }
function same(a, b) { return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0; }

T.test("sha256 + md5 known vectors", function () {
  var enc = new TextEncoder();
  T.eq(H.hex(H.sha256().update(enc.encode("abc")).digest()), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  T.eq(H.hex(H.md5().update(enc.encode("abc")).digest()), "900150983cd24fb0d6963f7d28e17f72");
  T.eq(H.hex(H.sha256().digest()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  T.eq(H.hex(H.md5().digest()), "d41d8cd98f00b204e9800998ecf8427e");
});

T.test("matches node:crypto at every length 0..300 (block boundaries)", function () {
  for (var n = 0; n <= 300; n++) {
    var b = new Uint8Array(nc.randomBytes(n));
    T.ok(same(H.sha256().update(b).digest(), ref("sha256", b)), "sha256 len " + n);
    T.ok(same(H.md5().update(b).digest(), ref("md5", b)), "md5 len " + n);
  }
});

T.test("matches node:crypto when fed in random-sized pieces (5 MiB)", function () {
  var big = new Uint8Array(nc.randomBytes(5 * 1024 * 1024 + 17));
  var s = H.sha256(), m = H.md5(), i = 0;
  while (i < big.length) {
    var step = 1 + Math.floor(Math.random() * 70000);
    var piece = big.subarray(i, i + step);
    s.update(piece); m.update(piece); i += step;
  }
  T.ok(same(s.digest(), ref("sha256", big)), "sha256 streamed");
  T.ok(same(m.digest(), ref("md5", big)), "md5 streamed");
});

module.exports = T;
if (require.main === module) T.run("hash").then(function (r) { process.exit(r.fail ? 1 : 0); });
