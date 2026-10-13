// Tiny assert runner for the drive tests: test(name, fn), run() prints counts.
"use strict";
var tests = [];
var current = "";
var checks = 0;

function test(name, fn) { tests.push({ name: name, fn: fn }); }

function ok(cond, msg) {
  checks++;
  if (!cond) throw new Error("assert: " + (msg || "failed"));
}
function eq(a, b, msg) {
  checks++;
  var x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error("expected " + y + " got " + x + (msg ? " — " + msg : ""));
}
async function rejects(fn, code, msg) {
  checks++;
  var err = null;
  try { await fn(); } catch (e) { err = e; }
  if (!err) throw new Error("expected rejection" + (code ? " " + code : "") + (msg ? " — " + msg : ""));
  if (code && err.code !== code) throw new Error("expected code " + code + " got " + err.code + " (" + err.message + ")");
  return err;
}

async function run(label) {
  var pass = 0, fail = 0, failures = [];
  for (var i = 0; i < tests.length; i++) {
    current = tests[i].name;
    try { await tests[i].fn(); pass++; process.stdout.write("  ✓ " + current + "\n"); }
    catch (e) { fail++; failures.push(current + ": " + (e && e.stack || e)); process.stdout.write("  ✗ " + current + "\n      " + (e && e.message) + "\n"); }
  }
  process.stdout.write((label || "tests") + ": " + pass + " passed, " + fail + " failed (" + checks + " assertions)\n");
  return { pass: pass, fail: fail, checks: checks, failures: failures };
}

module.exports = { test: test, ok: ok, eq: eq, rejects: rejects, run: run };
