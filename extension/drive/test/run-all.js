"use strict";
// Runs every test file in one process and prints pass/fail counts.
var T = require("./harness.js");
["./test-hash.js", "./test-seal.js", "./test-client.js", "./test-sweep.js", "./test-boot.js"].forEach(function (f) { require(f); });
T.run("hyphae drive").then(function (r) {
  if (r.fail) { r.failures.forEach(function (f) { process.stdout.write("\nFAIL " + f + "\n"); }); }
  process.exit(r.fail ? 1 : 0);
});
