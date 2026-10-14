#!/usr/bin/env node
/*
 * hyphae-release — make a signed release the extension can install by itself.
 *
 *   node bin/hyphae-release.mjs keygen [--force]   make the release key (kept in ~/.hyphae, never in the repo)
 *   node bin/hyphae-release.mjs build              zip the extension, sign it, verify the signature
 *   node bin/hyphae-release.mjs publish            build, then create the GitHub release (asks nothing: you ran it)
 *
 * The private key stays on this computer (mode 600). The public half is written to
 * extension/release-key.js, which ships inside the extension and is what an installed
 * copy checks every update against. Lose the private key and installed copies refuse
 * your next release until they are reinstalled with a new public key, so back it up.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { webcrypto as wc } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extDir = path.join(root, "extension");
const keyDir = path.join(os.homedir(), ".hyphae");
const keyFile = path.join(keyDir, "release-key.json");
const outDir = path.join(root, "release");
const REPO = "scores-patch-points/hyphae";
const ZIP = "hyphae-extension.zip";
const args = process.argv.slice(2);
const cmd = args[0] || "help";

const die = (s) => { process.stderr.write("hyphae-release: " + s + "\n"); process.exit(1); };
const say = (s = "") => process.stdout.write(s + "\n");
const b64 = (u8) => Buffer.from(u8).toString("base64");

async function keygen() {
  if (fs.existsSync(keyFile) && !args.includes("--force")) die(`a release key already exists at ${keyFile}. --force replaces it (installed copies will then refuse updates).`);
  const pair = await wc.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const priv = await wc.subtle.exportKey("jwk", pair.privateKey);
  const pub = await wc.subtle.exportKey("jwk", pair.publicKey);
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, JSON.stringify(priv), { mode: 0o600 });
  const pubClean = { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y };
  fs.writeFileSync(path.join(extDir, "release-key.js"),
    `/* The public half of the release key. An installed copy checks every update against it. */\n` +
    `self.HyReleaseKey = ${JSON.stringify({ pub: pubClean, repo: REPO, asset: ZIP }, null, 2)};\n`);
  say(`private key: ${keyFile}  (mode 600; back it up, and never commit it)`);
  say("public key: extension/release-key.js  (commit this)");
}

async function loadPrivate() {
  if (!fs.existsSync(keyFile)) die('no release key. Run "keygen" first.');
  return wc.subtle.importKey("jwk", JSON.parse(fs.readFileSync(keyFile, "utf8")), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

const EXCLUDE = ["demo/*", "test/*", "*/test/*", "*.md", "*.test.mjs", "*.test.html", "*/fixtures/*", "invite/sim.mjs", "invite/attacks.test.mjs"];

async function build() {
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  if (!fs.existsSync(path.join(extDir, "release-key.js"))) die('extension/release-key.js is missing. Run "keygen" first.');
  fs.mkdirSync(outDir, { recursive: true });
  const zip = path.join(outDir, ZIP);
  if (fs.existsSync(zip)) fs.rmSync(zip);
  const r = spawnSync("zip", ["-r", "-X", "-q", zip, ".", "-x", ...EXCLUDE], { cwd: extDir, stdio: "inherit" });
  if (r.error || r.status !== 0) die('could not run "zip".');
  const bytes = new Uint8Array(fs.readFileSync(zip));
  const sig = new Uint8Array(await wc.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await loadPrivate(), bytes));
  fs.writeFileSync(zip + ".sig", b64(sig) + "\n");
  // check what we just made the way the extension will
  const pubJs = fs.readFileSync(path.join(extDir, "release-key.js"), "utf8");
  const pub = JSON.parse(pubJs.slice(pubJs.indexOf("{"), pubJs.lastIndexOf("}") + 1)).pub;
  const key = await wc.subtle.importKey("jwk", pub, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!(await wc.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, bytes))) die("the signature does not verify against extension/release-key.js (is the key file the one this extension was built with?)");
  say(`built ${path.relative(root, zip)}  (${bytes.length} B)  v${manifest.version}`);
  say(`signed ${path.relative(root, zip)}.sig  and verified it against the public key in the extension`);
  return { zip, sig: zip + ".sig", version: manifest.version };
}

async function publish() {
  const { zip, sig, version } = await build();
  const tag = "v" + version;
  const r = spawnSync("gh", ["release", "create", tag, zip, sig, "--repo", REPO, "--title", `hyphae ${version}`,
    "--notes", `hyphae ${version}. Installed copies update themselves from this release after checking its signature.`], { stdio: "inherit" });
  if (r.status !== 0) die("gh release create failed (does the tag already exist? bump the version in extension/manifest.json).");
  say(`published ${tag}`);
}

const table = {
  keygen, build, publish,
  help: () => say("usage: hyphae-release.mjs keygen [--force] | build | publish"),
};
(table[cmd] || table.help)().catch((e) => die(e.message));
