/*
 * The update page: check GitHub for a newer signed release, verify it, write it into the
 * extension's own folder (a folder you grant once), and reload.
 *
 * Trust: the only thing that makes a release acceptable is a valid signature, by the key
 * in release-key.js, over the exact zip bytes. The release's version must also be newer
 * than the running one and must match what the release tag claimed. Files are written
 * with manifest.json last, so an interrupted update is not mistaken for a finished one.
 */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var KEY = self.HyReleaseKey, U = self.HyUpdate;
  var cur = chrome.runtime.getManifest();
  var ORIGINS = ["https://api.github.com/*", "https://github.com/*", "https://*.githubusercontent.com/*"];
  var latest = null;   // { version, zipUrl, sigUrl }

  function say(s, bad) { var l = $("log"); l.textContent = s; l.className = bad ? "bad" : ""; }
  function add(s) { $("log").textContent += "\n" + s; }

  // ---- the folder handle, kept in IndexedDB --------------------------------------------
  function db() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open("hyphae-update", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  async function kvGet(k) {
    var d = await db();
    return new Promise(function (res, rej) { var q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = function () { res(q.result); }; q.onerror = function () { rej(q.error); }; });
  }
  async function kvSet(k, v) {
    var d = await db();
    return new Promise(function (res, rej) { var t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = res; t.onerror = function () { rej(t.error); }; });
  }

  async function readJson(dir, name) {
    var f = await (await dir.getFileHandle(name)).getFile();
    return JSON.parse(await f.text());
  }

  async function chooseFolder() {
    var h = await window.showDirectoryPicker({ id: "hyphae-extension", mode: "readwrite" });
    var m;
    try { m = await readJson(h, "manifest.json"); } catch (e) { throw new Error("that folder has no manifest.json"); }
    if (m.name !== cur.name) throw new Error("that folder is not the hyphae extension");
    if (m.version !== cur.version) throw new Error("that folder is version " + m.version + ", but the running copy is " + cur.version + ". Choose the folder you loaded it from.");
    await kvSet("dir", h);
    $("folder").textContent = h.name + "  (version " + m.version + ")";
    say("Folder saved.");
  }

  // ---- check ------------------------------------------------------------------------------
  async function check() {
    var ok = await chrome.permissions.request({ origins: ORIGINS });
    if (!ok) throw new Error("Access to GitHub's release hosts wasn't granted.");
    var r = await fetch("https://api.github.com/repos/" + KEY.repo + "/releases/latest", { headers: { Accept: "application/vnd.github+json" }, credentials: "omit", cache: "no-store" });
    if (r.status === 404) throw new Error("No release has been published yet.");
    if (!r.ok) throw new Error("GitHub answered " + r.status + ".");
    var rel = await r.json();
    var version = String(rel.tag_name || "").replace(/^v/, "");
    if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new Error("The latest release has no usable version (" + rel.tag_name + ").");
    var zip = (rel.assets || []).filter(function (a) { return a.name === KEY.asset; })[0];
    var sig = (rel.assets || []).filter(function (a) { return a.name === KEY.asset + ".sig"; })[0];
    if (!zip || !sig) throw new Error("The latest release is missing its zip or its signature, so it can't be installed.");
    latest = { version: version, zipUrl: zip.browser_download_url, sigUrl: sig.browser_download_url };
    var newer = U.compareVersions(version, cur.version) > 0;
    $("latest").textContent = "v" + version + (newer ? "  (newer)" : "  (you are up to date)");
    $("install").disabled = !newer;
    say(newer ? "A newer signed release is available." : "Nothing to install.");
  }

  // ---- install ----------------------------------------------------------------------------
  async function writeFile(root, rel, bytes) {
    var parts = rel.split("/"), dir = root;
    for (var i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i], { create: true });
    var fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    var w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  }

  async function install() {
    if (!latest) throw new Error("Check for updates first.");
    var h = await kvGet("dir");
    if (!h) throw new Error("Choose the extension folder first.");
    if ((await h.requestPermission({ mode: "readwrite" })) !== "granted") throw new Error("Write access to the folder wasn't granted.");

    say("Downloading v" + latest.version + "…");
    var zr = await fetch(latest.zipUrl, { credentials: "omit", cache: "no-store" });
    var sr = await fetch(latest.sigUrl, { credentials: "omit", cache: "no-store" });
    if (!zr.ok || !sr.ok) throw new Error("Download failed (" + zr.status + "/" + sr.status + ").");
    var bytes = new Uint8Array(await zr.arrayBuffer());
    var sig = (await sr.text()).trim();

    add("Checking the signature…");
    if (!(await U.verify(KEY.pub, bytes, sig))) throw new Error("The signature does not match this extension's release key. Nothing was installed.");

    var plan = await U.plan(U.readZip(bytes), { name: cur.name, version: cur.version });
    if (plan.manifest.version !== latest.version) throw new Error("The release's own version (" + plan.manifest.version + ") is not the one its tag announced (" + latest.version + "). Nothing was installed.");

    add("Signature verified. Writing " + plan.files.length + " files…");
    for (var i = 0; i < plan.files.length; i++) {
      await writeFile(h, plan.files[i].name, await plan.files[i].entry.read());
    }
    add("Done. Reloading hyphae…");
    setTimeout(function () { chrome.runtime.reload(); }, 600);
  }

  function guard(fn) {
    return function () {
      fn().catch(function (e) { say(String(e && e.message ? e.message : e), true); });
    };
  }

  $("have").textContent = "v" + cur.version;
  $("repo").textContent = KEY.repo;
  $("choose").addEventListener("click", guard(chooseFolder));
  $("check").addEventListener("click", guard(check));
  $("install").addEventListener("click", guard(install));
  kvGet("dir").then(function (h) { if (h) $("folder").textContent = h.name + "  (saved)"; }, function () { /* none */ });
})();
