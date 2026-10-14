#!/usr/bin/env node
/*
 * Build a signed extension release: a zip whose manifest carries the release version,
 * and a detached signature over exactly those bytes (ECDSA P-256 / SHA-256, raw r||s,
 * base64), which is what extension/update-core.js verifies.
 *
 *   HYPHAE_RELEASE_KEY='<private JWK>' node scripts/release-extension.mjs <version> <outdir>
 *
 * The version is stamped only into the zip; the checkout's manifest is left as it is.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const extDir = path.join(root, "extension");
const ZIP_EXCLUDE = ["demo/*", "test/*", "*/test/*", "*.md", "*.test.mjs", "*.test.html", "*/fixtures/*", "invite/sim.mjs", "invite/attacks.test.mjs"];
const ASSET = "hyphae-extension.zip";

function die(s) { console.error("release: " + s); process.exit(1); }

const [version, outArg] = process.argv.slice(2);
if (!/^\d+(\.\d+){0,3}$/.test(version || "")) die("usage: release-extension.mjs <version> <outdir>");
const jwk = process.env.HYPHAE_RELEASE_KEY;
if (!jwk) die("HYPHAE_RELEASE_KEY is not set");
const outDir = path.resolve(outArg || "release");
fs.mkdirSync(outDir, { recursive: true });

// Copy the extension, stamp the version, zip the copy.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "hyphae-ext-"));
fs.cpSync(extDir, stage, { recursive: true });
const mfPath = path.join(stage, "manifest.json");
const mf = JSON.parse(fs.readFileSync(mfPath, "utf8"));
mf.version = version;
fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2) + "\n");

const zip = path.join(outDir, ASSET);
if (fs.existsSync(zip)) fs.rmSync(zip);
const r = spawnSync("zip", ["-r", "-q", "-X", zip, ".", "-x", ...ZIP_EXCLUDE], { cwd: stage, stdio: "inherit" });
if (r.error || r.status !== 0) die("zip failed");

const priv = JSON.parse(jwk);
const key = await webcrypto.subtle.importKey("jwk", priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
const bytes = fs.readFileSync(zip);
const sig = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes)).toString("base64");

// Refuse to publish a signature the extension's own key would reject.
const keySrc = fs.readFileSync(path.join(extDir, "release-key.js"), "utf8");
const shipped = JSON.parse(keySrc.slice(keySrc.indexOf("{"), keySrc.lastIndexOf("}") + 1)).pub;
const vkey = await webcrypto.subtle.importKey("jwk", shipped, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
if (!(await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, vkey, Buffer.from(sig, "base64"), bytes))) {
  die("the signing key does not match extension/release-key.js");
}
fs.writeFileSync(zip + ".sig", sig + "\n");
fs.rmSync(stage, { recursive: true, force: true });
console.log(`release: ${zip} (v${version}, ${bytes.length} bytes, signature verified)`);
