#!/usr/bin/env node
/*
 * hyphae — launch the demos, the app and the tests from a terminal, and install the
 * extension. Node built-ins only; nothing here talks to the network except the local
 * server it starts, which listens on 127.0.0.1.
 *
 *   hyphae demo [flow|drive|lens] [--port N] [--no-open]   the demo pages, served locally
 *   hyphae app  [--port N] [--dev] [--no-open]             the web app (built, or vite dev)
 *   hyphae extension [--zip [file]]                        how to install it, or a zip of it
 *   hyphae test [--quick]                                  every test suite that can run here
 *   hyphae doctor                                          check the install is complete
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extDir = path.join(root, "extension");
const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("-") ? args[0] : "help";
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] && !args[i + 1].startsWith("-") ? args[i + 1] : d; };

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".md": "text/plain; charset=utf-8", ".map": "application/json", ".txt": "text/plain",
};

function say(s = "") { process.stdout.write(s + "\n"); }
function die(s) { process.stderr.write("hyphae: " + s + "\n"); process.exit(1); }

function openUrl(url) {
  const c = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { spawn(c[0], c[1], { stdio: "ignore", detached: true }).unref(); } catch { /* the URL is printed anyway */ }
}

/** A tiny static file server, rooted at `dir`, listening on loopback only. */
function serve(dir, port, openPath, { open = true, fallback = null } = {}) {
  const base = path.resolve(dir);
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400).end(); return; }
    let f = path.resolve(base, "." + p);
    if (f !== base && !f.startsWith(base + path.sep)) { res.writeHead(403).end("forbidden"); return; }
    try { if (fs.statSync(f).isDirectory()) f = path.join(f, "index.html"); } catch { /* handled below */ }
    if (!fs.existsSync(f) && fallback) f = path.join(base, fallback);
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
      res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(buf);
    });
  });
  server.on("error", (e) => die(e.code === "EADDRINUSE" ? `port ${port} is in use (try --port ${port + 1})` : e.message));
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}${openPath}`;
    say(`serving ${path.relative(process.cwd(), base) || "."} at ${url}`);
    say("press Ctrl+C to stop");
    if (open) openUrl(url);
  });
}

function help() {
  say(`hyphae — seal what you write, on any site

  hyphae demo [flow|drive|lens]   run a demo page locally   (default: flow)
      flow   the invite flow: two stand-in Gmail windows, the real extension code
      drive  sealing a stand-in Google Drive with the real drive code
      lens   what a site sees versus what you see
  hyphae app [--dev]              the web app (needs "npm run build" once, or --dev for vite)
  hyphae extension [--zip [f]]    how to load the extension, or write a zip of it
  hyphae test [--quick]           run every test suite that can run here
  hyphae doctor                   check that the extension files all exist

  options: --port N   --no-open`);
}

// ---- demo --------------------------------------------------------------------------------
function demo() {
  const which = args[1] && !args[1].startsWith("-") ? args[1] : "flow";
  const pages = { flow: "/demo/flow.html", drive: "/demo/drive.html", lens: "/demo/index.html" };
  if (!pages[which]) die(`unknown demo "${which}" (flow, drive or lens)`);
  serve(extDir, Number(opt("--port", 8937)), pages[which], { open: !flag("--no-open") });
}

// ---- app ---------------------------------------------------------------------------------
function app() {
  const port = Number(opt("--port", 4173));
  if (flag("--dev")) {
    say("starting vite (dev)…");
    const p = spawn("npx", ["vite", "--port", String(port), ...(flag("--no-open") ? [] : ["--open"])], { cwd: root, stdio: "inherit" });
    p.on("exit", (c) => process.exit(c ?? 0));
    return;
  }
  const dist = path.join(root, "dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) die('no build found. Run "npm install && npm run build" first, or use "hyphae app --dev".');
  serve(dist, port, "/", { open: !flag("--no-open"), fallback: "index.html" });
}

// ---- extension ---------------------------------------------------------------------------
const ZIP_EXCLUDE = ["demo/*", "test/*", "*/test/*", "*.md", "*.test.mjs", "*.test.html", "*/fixtures/*", "invite/sim.mjs", "invite/attacks.test.mjs"];

function extension() {
  if (flag("--zip")) {
    const out = path.resolve(opt("--zip", "hyphae-extension.zip"));
    if (fs.existsSync(out)) fs.rmSync(out);
    const r = spawnSync("zip", ["-r", "-q", out, ".", "-x", ...ZIP_EXCLUDE], { cwd: extDir, stdio: "inherit" });
    if (r.error || r.status !== 0) die('could not run "zip". Load the folder unpacked instead (hyphae extension).');
    say(`wrote ${out}`);
    return;
  }
  const m = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  say(`${m.name}  v${m.version}\n`);
  say("Install (Chrome, Brave, Edge):");
  say("  1. open  chrome://extensions   (brave://extensions, edge://extensions)");
  say("  2. turn on Developer mode");
  say("  3. Load unpacked, and choose:");
  say(`       ${extDir}`);
  say("  4. click the hyphae toolbar icon, open “Circles & keys”, and create a circle");
  say("  5. on mail.google.com or drive.google.com, click the toolbar icon once; the HYPHAE button appears");
  say("\nTo hand it to someone: hyphae extension --zip   (then they unzip it and Load unpacked)");
}

// ---- doctor ------------------------------------------------------------------------------
function doctor() {
  let bad = 0;
  const need = (rel, why) => { if (!fs.existsSync(path.join(extDir, rel))) { say(`  missing  ${rel}  (${why})`); bad++; } };
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  need(manifest.background?.service_worker, "service worker");
  need(manifest.action?.default_popup, "popup");
  const bg = fs.readFileSync(path.join(extDir, "background.js"), "utf8");
  const imp = /importScripts\(([^)]*)\)/.exec(bg);
  (imp ? imp[1].match(/"([^"]+)"/g) || [] : []).forEach((s) => need(s.replace(/"/g, ""), "imported by the worker"));
  for (const m of bg.matchAll(/files: \[([^\]]+)\]/g)) (m[1].match(/"([^"]+)"/g) || []).forEach((s) => need(s.replace(/"/g, ""), "injected into pages"));
  say(`node ${process.version}`);
  say(bad ? `${bad} problem(s)` : "extension files: all present");
  process.exit(bad ? 1 : 0);
}

// ---- test --------------------------------------------------------------------------------
function run(label, file, argv = [], env = {}, cwd = root) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file, ...argv], { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 600000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const tail = out.trim().split("\n").filter(Boolean).slice(-1)[0] || "";
  const ok = r.status === 0;
  say(`${ok ? "ok  " : "FAIL"} ${label.padEnd(26)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${tail.slice(0, 90)}`);
  if (!ok) say(out.split("\n").slice(-12).join("\n"));
  return ok;
}
function test() {
  const quick = flag("--quick");
  const results = [];
  results.push(run("invite bridge", path.join(extDir, "invite-bridge.test.mjs")));
  results.push(run("contacts core", path.join(extDir, "contacts/core.test.mjs")));
  results.push(run("contacts google import", path.join(extDir, "contacts/google.test.mjs")));
  results.push(run("drive (seal, client, sweep)", "run-all.js", [], {}, path.join(extDir, "drive/test")));
  results.push(run("invite attacks" + (quick ? " (quick)" : ""), path.join(extDir, "invite/attacks.test.mjs"), [], quick ? { QUICK: "1" } : {}));
  const jsdomDir = fs.existsSync(path.join(root, "node_modules/jsdom")) ? path.join(root, "node_modules") : process.env.JSDOM_DIR;
  if (jsdomDir) results.push(run("gmail adapter flow (jsdom)", path.join(extDir, "test/gmail.flow.test.mjs"), [], { JSDOM_DIR: jsdomDir }));
  else say("skip gmail adapter flow: needs jsdom (npm i -D jsdom, or set JSDOM_DIR)");
  if (fs.existsSync(path.join(root, "tests"))) results.push(run("app (matrix, capabilities)", "--test", ["tests/*.test.mjs"]));
  const failed = results.filter((x) => !x).length;
  say(failed ? `\n${failed} suite(s) failed` : "\nall suites passed");
  process.exit(failed ? 1 : 0);
}

const table = { demo, app, extension, test, doctor, help, "--help": help, "-h": help };
(table[cmd] || (() => { help(); process.exit(2); }))();
