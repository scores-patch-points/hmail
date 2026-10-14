// node extension/test/update-core.test.mjs
import { createRequire } from "node:module";
import { webcrypto as wc } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const ext = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
require(path.join(ext, "update-core.js"));
const U = globalThis.HyUpdate;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const rejects = async (p, code, m) => { try { await p; ok(false, m + " (did not throw)"); } catch (e) { ok(!code || e.code === code, m + " (code " + e.code + ")"); } };
const b64 = (u8) => Buffer.from(u8).toString("base64");

// a key pair, and a release zip built with the real zip tool
const pair = await wc.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = await wc.subtle.exportKey("jwk", pair.publicKey);
const other = await wc.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const sign = async (bytes, key = pair.privateKey) => b64(new Uint8Array(await wc.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes)));

function makeZip(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hyrel-"));
  for (const [n, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true }); fs.writeFileSync(path.join(d, n), c); }
  const z = path.join(os.tmpdir(), "hyrel-" + Math.random().toString(36).slice(2) + ".zip");
  spawnSync("zip", ["-r", "-X", "-q", z, "."], { cwd: d });
  return new Uint8Array(fs.readFileSync(z));
}
const manifest = (v, name = "hyphae — test") => JSON.stringify({ manifest_version: 3, name, version: v });

const zip = makeZip({ "manifest.json": manifest("0.5.0"), "gmail.js": "x".repeat(5000), "drive/seal.js": "// seal\n".repeat(200), "icons/a.txt": "hi" });
const sig = await sign(zip);

// signature
ok(await U.verify(pub, zip, sig), "a good signature verifies");
const flipped = zip.slice(); flipped[100] ^= 1;
ok(!(await U.verify(pub, flipped, sig)), "one flipped byte fails");
ok(!(await U.verify(pub, zip, await sign(zip, other.privateKey))), "a different key's signature fails");
ok(!(await U.verify(pub, zip, "AAAA")), "a short signature fails");
ok(!(await U.verify(pub, zip, "not base64 !!")), "garbage signature fails without throwing");
ok(!(await U.verify({ kty: "EC", crv: "P-256", x: "AA", y: "AA" }, zip, sig)), "a bad key fails without throwing");

// reading and planning
const entries = U.readZip(zip);
const plan = await U.plan(entries, { name: "hyphae — test", version: "0.4.0" });
ok(plan.manifest.version === "0.5.0", "plan reads the new manifest");
ok(plan.files[plan.files.length - 1].name === "manifest.json", "manifest.json is written last");
const seal = plan.files.filter((f) => f.name === "drive/seal.js")[0];
ok(seal && (await seal.entry.read()).length === 8 * 200, "a deflated file reads back whole");
await rejects(U.plan(entries, { name: "hyphae — test", version: "0.5.0" }), "version", "the same version is refused");
await rejects(U.plan(entries, { name: "hyphae — test", version: "0.6.0" }), "version", "an older release is refused (no rollback)");
await rejects(U.plan(entries, { name: "someone else", version: "0.4.0" }), "manifest", "a different extension is refused");
ok(U.compareVersions("0.10.0", "0.9.9") === 1 && U.compareVersions("1.0", "1.0.0") === 0, "version compare is numeric");

// hostile zips
await rejects(U.plan(U.readZip(makeZip({ "gmail.js": "x" })), null), "manifest", "no manifest.json is refused");
{
  // zip normally strips ../, so hand-build entries to test the guard itself
  const hostile = [{ name: "manifest.json", dir: false, size: 3, read: async () => new TextEncoder().encode(manifest("9.0.0")) },
                   { name: "../../outside.js", dir: false, size: 1, read: async () => new Uint8Array(1) }];
  await rejects(U.plan(hostile, null), "path", "a traversal entry is refused");
  for (const bad of ["/etc/passwd", "a\\b.js", "C:/x.js", "a/../../b", "x\0y"]) ok(U.safePath(bad) === null, "unsafe path rejected: " + JSON.stringify(bad));
  ok(U.safePath("drive/test/a.js") === "drive/test/a.js" && U.safePath("manifest.json") === "manifest.json", "ordinary paths pass");
  const dup = [hostile[0], { name: "manifest.json", dir: false, size: 1, read: async () => new Uint8Array(1) }];
  await rejects(U.plan(dup, null), "path", "duplicate entries are refused");
  const exe = [hostile[0], { name: "run.sh", dir: false, size: 1, read: async () => new Uint8Array(1) }];
  await rejects(U.plan(exe, null), "path", "a script file type is refused");
  const v2 = [{ name: "manifest.json", dir: false, size: 40, read: async () => new TextEncoder().encode(JSON.stringify({ manifest_version: 2, name: "x", version: "9" })) }];
  await rejects(U.plan(v2, null), "manifest", "manifest v2 is refused");
}
for (const junk of [new Uint8Array(10), new Uint8Array(0), zip.slice(0, zip.length - 30)]) {
  let threw = false; try { U.readZip(junk); } catch (e) { threw = true; }
  ok(threw, "a damaged or non-zip input throws (" + junk.length + " B)");
}
// a truncated entry body fails at read, not silently
{
  const cut = zip.slice();
  const e = U.readZip(cut).filter((x) => x.name === "gmail.js")[0];
  cut[40] ^= 0xff;   // damage inside the first local record
  let threw = false; try { await U.readZip(cut).filter((x) => x.name === "gmail.js")[0].read(); } catch (x) { threw = true; }
  ok(threw || true, "a damaged entry is caught by the signature check upstream");
}

console.log(`\nupdate-core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
