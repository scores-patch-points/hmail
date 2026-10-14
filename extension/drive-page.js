/*
 * hyphae on drive.google.com — a button, a confirmation, and a seal on the way in.
 *
 * While it is on, every file you pick or drop into Drive (a new upload, or a new
 * version of one) is stopped before Drive's own page code sees it. You are asked to
 * confirm; the file is then sealed on this device under your circle key, with an
 * animation showing the name and bytes turn into ciphertext; only then does Drive
 * receive it, as sealed bytes under an opaque name. With hyphae on, sealed files
 * you uploaded show their real names in the Drive list; with it off they show as
 * Google stores them.
 *
 * Google Docs, Sheets and Slides cannot be sealed (Google edits them on its servers),
 * and files already in your Drive are not touched here: the Drive sweep does those.
 * The circle key opens a sealed file and goes to people by another channel; Drive's
 * Share dialog only shares the sealed bytes. This script never puts a key in Drive.
 *
 * Loaded after crypto.js, drive/hash.js and drive/seal.js. Closed shadow roots, DOM
 * calls only (Drive enforces Trusted Types).
 */
(function () {
  "use strict";
  if (location.hostname !== "drive.google.com" && !window.__hyphaeDriveAllow) return;
  if (window.__hyphaeDrive) return;
  var Seal = window.HyDriveSeal;
  if (!Seal) return;

  var FONT = "'Helvetica Neue','SF Pro Display',ui-sans-serif,system-ui,sans-serif";
  var NAME_RE = /^hy-[a-z2-7]{24}\.hyd$/;
  var BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
  var on = false, signedIn = false, circle = null, askFirst = true, log = [], dock = null;
  var names = {};                       // opaque name -> real name, kept in extension storage when there is one
  var swapped = new Map();              // text node -> the text Drive had there
  var sealedFiles = (typeof WeakSet === "function") ? new WeakSet() : null;
  var reduced = false;
  try { reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { /* ignore */ }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function opaqueName() {
    var b = new Uint8Array(24);
    crypto.getRandomValues(b);
    var s = "hy-";
    for (var i = 0; i < b.length; i++) s += BASE32[b[i] & 31];
    return s + ".hyd";
  }
  function alreadySealed(f) { return (sealedFiles && sealedFiles.has(f)) || NAME_RE.test(f.name); }
  function say(msg) { log.unshift({ t: Date.now(), msg: msg }); if (log.length > 8) log.pop(); paint(true); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function human(n) { return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB"; }

  // ---- names ------------------------------------------------------------------------------
  function saveNames() {
    try { if (chrome && chrome.storage && chrome.storage.local) chrome.storage.local.set({ driveNames: names }); } catch (e) { /* memory only */ }
  }
  function remember(opaque, real) { names[opaque] = real; saveNames(); swapNow(); }

  /** One file in, one sealed File out. The real name travels inside the sealed bytes. */
  async function sealFile(file, keepName) {
    var bytes = new Uint8Array(await file.arrayBuffer());
    var sealed = await Seal.sealBytes(circle, bytes, {
      name: file.name, mime: file.type || "application/octet-stream", size: bytes.length,
      mtime: file.lastModified || Date.now(), id: "upload", path: null,
    });
    var out = new File([sealed], keepName || opaqueName(), { type: "application/octet-stream", lastModified: Date.now() });
    if (sealedFiles) sealedFiles.add(out);
    remember(out.name, file.name);
    say(file.name + "  →  " + out.name + "  (" + bytes.length + " B in, " + sealed.length + " B sealed)");
    return { out: out, inSize: bytes.length, sealedSize: sealed.length, head: sealed.subarray(0, 16) };
  }

  // ---- readable vs encrypted names in Drive's own list ------------------------------------
  function eachNameNode(fn) {
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = w.nextNode())) {
      var v = n.nodeValue;
      if (!v || v.length < 27 || v.length > 40) continue;
      if (n.parentNode && n.parentNode.closest && n.parentNode.closest("[data-hyphae-ui]")) continue;
      fn(n, v.trim());
    }
  }
  function swapNow() {
    if (on) {
      eachNameNode(function (n, v) {
        if (NAME_RE.test(v) && !swapped.has(n)) {
          swapped.set(n, n.nodeValue);
          n.nodeValue = "hyphae  ·  " + (names[v] || "sealed file " + v.slice(3, 9));
        }
      });
    } else {
      swapped.forEach(function (orig, n) { if (n.isConnected) n.nodeValue = orig; });
      swapped.clear();
    }
  }
  var swapTimer = null;
  function scheduleSwap() { if (swapTimer) return; swapTimer = setTimeout(function () { swapTimer = null; swapNow(); }, 250); }
  try { new MutationObserver(scheduleSwap).observe(document.body, { childList: true, subtree: true, characterData: true }); } catch (e) { /* no live swap */ }

  // ---- the overlay: confirm, then the encryption animation ------------------------------------
  var OV_CSS =
    ":host{all:initial}*{box-sizing:border-box}" +
    ".veil{position:fixed;inset:0;background:rgba(15,16,24,.66);display:flex;align-items:center;justify-content:center;" +
    "z-index:2147483647;font:300 13px/1.5 " + FONT + ";color:#b1a6d4;animation:fade .18s ease-out}" +
    "@keyframes fade{from{opacity:0}to{opacity:1}}" +
    ".card{width:520px;max-width:92vw;background:#1b1d28;border:1px solid #313140;border-radius:16px;padding:18px 20px;" +
    "box-shadow:0 18px 60px rgba(0,0,0,.5)}" +
    ".word{font:300 10px/1 " + FONT + ";letter-spacing:.32em;text-transform:uppercase;color:#b1a6d4}" +
    "h2{margin:12px 0 4px;font:400 17px/1.3 " + FONT + ";color:#cfc8ec}" +
    ".sub{color:#8a8a9c;font-size:12px}" +
    ".files{margin:12px 0 4px;max-height:140px;overflow:auto;border-top:1px solid #313140}" +
    ".f{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid #313140;color:#cfc8ec;font-size:12.5px}" +
    ".f span:last-child{color:#8a8a9c;white-space:nowrap}" +
    ".row{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;align-items:center}" +
    ".grow{flex:1}" +
    "button{font:inherit;font-size:12px;border:1px solid #938bb2;background:transparent;color:#b1a6d4;border-radius:999px;padding:6px 15px;cursor:pointer}" +
    "button:hover{background:rgba(147,139,178,.16)}button.p{background:#938bb2;color:#1b1d28}" +
    "label.chk{display:flex;gap:6px;align-items:center;font-size:11.5px;color:#8a8a9c}" +
    ".stage{margin-top:10px;border:1px solid #313140;border-radius:12px;background:#171925;padding:10px 12px}" +
    "svg{display:block;width:100%;height:110px}" +
    ".mono{font:12px/1.5 ui-monospace,Menlo,monospace}" +
    ".nm{display:flex;align-items:center;gap:10px;margin-top:8px}" +
    ".nm .a{color:#cfc8ec}.nm .arr{color:#7d6bb8}.nm .b{color:#938bb2;word-break:break-all}" +
    ".bar{height:4px;border-radius:2px;background:#313140;margin-top:10px;overflow:hidden}" +
    ".bar i{display:block;height:100%;width:0;background:#938bb2;transition:width .12s linear}" +
    ".ok{color:#cfc8ec}.dim{color:#8a8a9c}.cipher{color:#9d93c8;word-break:break-all}" +
    ".toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#1b1d28;color:#b1a6d4;border:1px solid #313140;" +
    "border-radius:999px;padding:8px 16px;font:300 12.5px/1.3 " + FONT + ";z-index:2147483647;box-shadow:0 8px 28px rgba(0,0,0,.4);animation:fade .15s}";

  var overlay = null;
  function overlayRoot() {
    if (overlay && overlay.host.isConnected) return overlay;
    var host = document.createElement("div");
    host.setAttribute("data-hyphae-ui", "1");
    host.style.cssText = "all:initial;";
    var shadow = host.attachShadow({ mode: "closed" });
    var st = document.createElement("style"); st.textContent = OV_CSS; shadow.appendChild(st);
    var slot = document.createElement("div"); shadow.appendChild(slot);
    ["keydown", "keyup", "mousedown", "click"].forEach(function (t) { host.addEventListener(t, function (e) { e.stopPropagation(); }); });
    (document.body || document.documentElement).appendChild(host);
    overlay = { host: host, slot: slot };
    return overlay;
  }
  function clearOverlay() { if (overlay) { while (overlay.slot.firstChild) overlay.slot.removeChild(overlay.slot.firstChild); } }
  function closeOverlay() { if (overlay) { overlay.host.remove(); overlay = null; } }
  function toast(msg, ms) {
    var o = overlayRoot();
    var t = el("div", "toast", msg);
    o.slot.appendChild(t);
    setTimeout(function () { t.remove(); if (overlay && !overlay.slot.firstChild) closeOverlay(); }, ms || 2600);
  }

  /** The three-node network from the Hyphae look, drifting; `flow` runs a packet along its edges. */
  var NS = "http://www.w3.org/2000/svg";
  function s(name, attrs) { var e = document.createElementNS(NS, name); Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, String(attrs[k])); }); return e; }
  function networkSvg(flowing) {
    var svg = s("svg", { viewBox: "0 0 400 110" });
    var pts = [[60, 55], [200, 30], [340, 62]];
    var edges = [[0, 1], [1, 2], [0, 2]];
    edges.forEach(function (e, i) {
      var a = pts[e[0]], b = pts[e[1]];
      var ln = s("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: "#4d4a6e", "stroke-width": 1.2, "stroke-dasharray": "4 6" });
      if (flowing && !reduced) ln.appendChild(s("animate", { attributeName: "stroke-dashoffset", from: 0, to: -20, dur: "0.9s", repeatCount: "indefinite" }));
      svg.appendChild(ln);
    });
    pts.forEach(function (p, i) {
      var g = s("g", { transform: "translate(" + p[0] + "," + p[1] + ")" });
      if (!reduced) {
        var d = 4 + i;
        g.appendChild(s("animateTransform", { attributeName: "transform", type: "translate", dur: (9 + i * 3) + "s", repeatCount: "indefinite",
          values: [[p[0], p[1]], [p[0] + d, p[1] - d], [p[0], p[1] + d], [p[0] - d, p[1] - d], [p[0], p[1]]].map(function (q) { return q.join(","); }).join(";") }));
      }
      g.appendChild(s("circle", { r: 20, fill: "none", stroke: "#938bb2", "stroke-width": 1.4, opacity: 0.85 }));
      g.appendChild(s("circle", { r: 32, fill: "none", stroke: "#938bb2", "stroke-width": 1, opacity: 0.45 }));
      g.appendChild(s("circle", { r: 7, fill: "#b1a6d4" }));
      var orb = s("g", {});
      if (!reduced) orb.appendChild(s("animateTransform", { attributeName: "transform", type: "rotate", from: i * 120, to: i * 120 + (i % 2 ? -360 : 360), dur: (6 + i * 2) + "s", repeatCount: "indefinite" }));
      orb.appendChild(s("circle", { cx: 20, cy: 0, r: 3.2, fill: "#938bb2" }));
      orb.appendChild(s("circle", { cx: -32, cy: 0, r: 2.6, fill: "#7d6bb8" }));
      g.appendChild(orb);
      svg.appendChild(g);
    });
    if (flowing && !reduced) {
      [0, 1].forEach(function (k) {
        var c = s("circle", { r: 3.4, fill: "#e8e4fb" });
        var path = "M" + pts[0][0] + "," + pts[0][1] + " L" + pts[1][0] + "," + pts[1][1] + " L" + pts[2][0] + "," + pts[2][1];
        var m = s("animateMotion", { dur: "1.6s", repeatCount: "indefinite", path: path, begin: (k * 0.8) + "s" });
        c.appendChild(m);
        svg.appendChild(c);
      });
    }
    return svg;
  }

  /** "Seal N files?" -> "seal" | "plain" | "cancel" */
  function confirmSeal(files) {
    return new Promise(function (resolve) {
      var o = overlayRoot(); clearOverlay();
      var veil = el("div", "veil"), card = el("div", "card");
      card.appendChild(el("div", "word", "hyphae"));
      card.appendChild(el("h2", "", files.length === 1 ? "Would you like to encrypt this with hyphae?" : "Would you like to encrypt these " + files.length + " files with hyphae?"));
      card.appendChild(el("div", "sub", "It is sealed on this device first. Drive stores only ciphertext under a hyphae name, and only you can open it."));
      var list = el("div", "files");
      files.slice(0, 20).forEach(function (f) {
        var r = el("div", "f"); r.appendChild(el("span", "", f.name)); r.appendChild(el("span", "", human(f.size)));
        list.appendChild(r);
      });
      if (files.length > 20) list.appendChild(el("div", "f", "and " + (files.length - 20) + " more"));
      card.appendChild(list);
      var row = el("div", "row");
      var lab = el("label", "chk"); var cb = el("input"); cb.type = "checkbox";
      lab.appendChild(cb); lab.appendChild(document.createTextNode("Don't ask again on this page"));
      row.appendChild(lab); row.appendChild(el("span", "grow"));
      function done(v) { document.removeEventListener("keydown", onKey, true); if (cb.checked && v === "seal") askFirst = false; resolve(v); }
      var no = el("button", "", "Cancel"), plain = el("button", "", "Upload as is"), yes = el("button", "p", "Encrypt with hyphae");
      no.addEventListener("click", function () { done("cancel"); });
      plain.addEventListener("click", function () { done("plain"); });
      yes.addEventListener("click", function () { done("seal"); });
      row.appendChild(no); row.appendChild(plain); row.appendChild(yes);
      card.appendChild(row);
      veil.appendChild(card); o.slot.appendChild(veil);
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done("cancel"); }
        else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done("seal"); }
      }
      document.addEventListener("keydown", onKey, true);
      setTimeout(function () { try { yes.focus(); } catch (e) { /* ignore */ } }, 0);
    });
  }

  /** The animation: each file's name turns into its opaque name while the bytes are sealed. */
  function scramble(from, to, ms, setText, onDone) {
    var start = Date.now(), len = Math.max(from.length, to.length);
    var alpha = "abcdefghijklmnopqrstuvwxyz234567";
    var timer = setInterval(function () {
      var t = Math.min(1, (Date.now() - start) / ms), cut = Math.floor(t * len), out = "";
      for (var i = 0; i < len; i++) {
        if (i < cut) out += i < to.length ? to[i] : "";
        else out += (from[i] !== undefined && t < 0.18) ? from[i] : alpha[Math.floor(Math.random() * 32)];
      }
      setText(out);
      if (t >= 1) { clearInterval(timer); setText(to); onDone && onDone(); }
    }, 45);
  }

  async function sealWithAnimation(files) {
    var o = overlayRoot(); clearOverlay();
    var veil = el("div", "veil"), card = el("div", "card");
    card.appendChild(el("div", "word", "hyphae"));
    var title = el("h2", "", "Sealing…");
    var sub = el("div", "sub", "Encrypting on this device. Drive hasn't seen the file.");
    card.appendChild(title); card.appendChild(sub);
    var stage = el("div", "stage");
    stage.appendChild(networkSvg(true));
    var nm = el("div", "nm mono");
    var a = el("span", "a", ""), arr = el("span", "arr", "→"), b = el("span", "b", "");
    nm.appendChild(a); nm.appendChild(arr); nm.appendChild(b);
    stage.appendChild(nm);
    var bytes = el("div", "mono cipher", "");
    bytes.style.marginTop = "8px";
    stage.appendChild(bytes);
    var bar = el("div", "bar"), fill = el("i"); bar.appendChild(fill); stage.appendChild(bar);
    card.appendChild(stage);
    veil.appendChild(card); o.slot.appendChild(veil);

    var outs = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (alreadySealed(f)) { outs.push(f); continue; }
      title.textContent = files.length > 1 ? "Sealing " + (i + 1) + " of " + files.length + "…" : "Sealing…";
      a.textContent = f.name;
      fill.style.width = Math.round((i / files.length) * 100) + "%";
      var res = null;
      var sealP = sealFile(f).then(function (r) { res = r; });
      var target = opaqueName();   // only for the look; the real opaque name is the sealed file's
      await Promise.all([sealP, wait(reduced ? 200 : 1250)]);
      await new Promise(function (resolve) {
        scramble(f.name, res.out.name, reduced ? 1 : 900, function (t) { b.textContent = t; }, resolve);
      });
      // a taste of what Drive will actually receive: the first bytes of the sealed file
      var h = ""; for (var k = 0; k < res.head.length; k++) { var c = res.head[k]; h += (c >= 32 && c < 127) ? String.fromCharCode(c) : "·"; }
      bytes.textContent = "Drive receives:  " + h + "…  (" + human(res.sealedSize) + ")";
      fill.style.width = Math.round(((i + 1) / files.length) * 100) + "%";
      outs.push(res.out);
      if (i < files.length - 1) await wait(reduced ? 0 : 350);
    }
    title.textContent = files.length > 1 ? "Sealed " + files.length + " files" : "Sealed";
    sub.textContent = "Uploading the encrypted file now. Only you can open it.";
    await wait(reduced ? 200 : 1100);
    closeOverlay();
    return outs;
  }


  /** Sealing and opening need the Matrix sign-in; this says so and offers the way there. */
  function needSignIn() {
    var o = overlayRoot(); clearOverlay();
    var veil = el("div", "veil"), card = el("div", "card");
    card.appendChild(el("div", "word", "hyphae"));
    card.appendChild(el("h2", "", "Sign in to hyphae first"));
    card.appendChild(el("div", "sub", "hyphae seals and opens files only while you are signed in with your Matrix account. Sign in, then come back here."));
    var row = el("div", "row"); row.appendChild(el("span", "grow"));
    var no = el("button", "", "Not now"), go = el("button", "p", "Open hyphae");
    no.addEventListener("click", closeOverlay);
    go.addEventListener("click", function () { window.open("https://mail.hyphae.social/app/", "_blank", "noopener"); closeOverlay(); });
    row.appendChild(no); row.appendChild(go); card.appendChild(row);
    veil.appendChild(card); o.slot.appendChild(veil);
  }

  /** The decision for one batch: files to hand to Drive, or null to hand nothing. */
  async function process(files) {
    var todo = files.filter(function (f) { return !alreadySealed(f); });
    if (!todo.length) return files;
    if (!on) { toast("hyphae is off — uploading without sealing"); return files; }
    if (!circle) {
      var o = overlayRoot(); clearOverlay();
      var veil = el("div", "veil"), card = el("div", "card");
      card.appendChild(el("div", "word", "hyphae"));
      card.appendChild(el("h2", "", "No circle yet"));
      card.appendChild(el("div", "sub", "Add a circle in hyphae, or switch hyphae off to upload as usual. Nothing was uploaded."));
      var row = el("div", "row"); row.appendChild(el("span", "grow"));
      var ok = el("button", "p", "OK"); row.appendChild(ok); card.appendChild(row);
      veil.appendChild(card); o.slot.appendChild(veil);
      await new Promise(function (r) { ok.addEventListener("click", r); });
      closeOverlay();
      return null;
    }
    var choice = askFirst ? await confirmSeal(todo) : "seal";
    if (choice === "cancel") { closeOverlay(); return null; }
    if (choice === "plain") { closeOverlay(); toast("Uploading without sealing"); return files; }
    try { return await sealWithAnimation(files); }
    catch (err) { closeOverlay(); say("Not uploaded: " + (err && err.message ? err.message : err)); toast("Not uploaded: sealing failed"); return null; }
  }

  // ---- interception -------------------------------------------------------------------------
  // The picker fires "change" on an <input type=file>; a drop fires "drop". Both are caught
  // first (capture, at the document), held while hyphae asks and seals, and then re-sent with
  // the sealed files so Drive's own code carries on as if those were what you picked.

  document.addEventListener("change", function (e) {
    var t = e.target;
    if (!t || t.tagName !== "INPUT" || t.type !== "file" || !t.files || !t.files.length) return;
    if (Array.prototype.every.call(t.files, alreadySealed)) return;
    if (!on) { toast("hyphae is off — uploading without sealing"); return; }
    e.stopImmediatePropagation();
    var picked = Array.prototype.slice.call(t.files);
    process(picked).then(function (outs) {
      if (!outs) { try { t.value = ""; } catch (x) { /* ignore */ } return; }
      var dt = new DataTransfer();
      outs.forEach(function (f) { dt.items.add(f); });
      t.files = dt.files;
      t.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }, true);

  document.addEventListener("drop", function (e) {
    var dt0 = e.dataTransfer;
    if (e.__hyphae || !dt0 || !dt0.files || !dt0.files.length) return;
    var files = Array.prototype.slice.call(dt0.files);
    if (files.every(alreadySealed)) return;
    if (!on) { toast("hyphae is off — uploading without sealing"); return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    var target = e.target, cx = e.clientX, cy = e.clientY;
    process(files).then(function (outs) {
      if (!outs) return;
      var dt = new DataTransfer();
      outs.forEach(function (f) { dt.items.add(f); });
      var ev;
      try { ev = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }); }
      catch (x) { ev = new Event("drop", { bubbles: true, cancelable: true }); ev.dataTransfer = dt; }
      ev.__hyphae = true;
      target.dispatchEvent(ev);
    });
  }, true);


  // ---- open a sealed file: decrypt it here, edit it, seal the edit back ------------------------
  // Double-click (or Enter on) a sealed row while hyphae is on. The bytes are fetched with
  // your own Drive session, opened on this device with the circle key, and shown in hyphae's
  // viewer; text can be edited and saved. A save is sealed under the same Drive name and
  // handed to Drive's own uploader, which asks Replace or Keep both: Replace is a new version.
  var TEXT_RE = /^(text\/|application\/(json|xml|javascript|x-sh|x-yaml|yaml|csv))|\+(json|xml)$/;
  var TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|sh|yml|yaml|toml|ini|log|sql|tex)$/i;
  var MAX_OPEN = 32 * 1048576;

  function b64ToBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function saveBlob(bytes, name, type) {
    var url = URL.createObjectURL(new Blob([bytes], { type: type || "application/octet-stream" }));
    var a = document.createElement("a"); a.href = url; a.download = name;
    (document.body || document.documentElement).appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function isTextFile(meta) { return TEXT_RE.test(meta.mime || "") || TEXT_EXT.test(meta.name || ""); }

  /** The Drive file id and opaque name of the sealed row an event came from, or null. */
  function sealedRowOf(target) {
    var row = target && target.closest ? target.closest("[data-id]") : null;
    if (!row) return null;
    var id = row.getAttribute("data-id");
    if (!/^[\w-]{10,80}$/.test(id || "")) return null;
    var found = null, w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null), n;
    while ((n = w.nextNode())) {
      var v = (swapped.has(n) ? swapped.get(n) : n.nodeValue || "").trim();
      if (NAME_RE.test(v)) { found = v; break; }
    }
    return found ? { id: id, opaque: found } : null;
  }

  function fetchSealed(id) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage({ hyphae: "drive-fetch", id: id }, function (r) {
          if (chrome.runtime.lastError || !r) return reject(new Error("could not reach hyphae to download the file"));
          if (!r.ok) return reject(new Error(r.message || "Drive did not return the file"));
          resolve(b64ToBytes(r.b64));
        });
      } catch (e) { reject(e); }
    });
  }

  async function openSealed(hit) {
    var o = overlayRoot(); clearOverlay();
    var veil = el("div", "veil"), card = el("div", "card");
    card.style.width = "720px";
    card.appendChild(el("div", "word", "hyphae"));
    var title = el("h2", "", names[hit.opaque] || "Opening…");
    var sub = el("div", "sub", "Downloading the sealed file and opening it on this device.");
    card.appendChild(title); card.appendChild(sub);
    var body = el("div", "stage"); body.style.maxHeight = "60vh"; body.style.overflow = "auto";
    card.appendChild(body);
    var row = el("div", "row"); card.appendChild(row);
    veil.appendChild(card); o.slot.appendChild(veil);
    function close() { document.removeEventListener("keydown", onKey, true); closeOverlay(); }
    function onKey(e) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }
    document.addEventListener("keydown", onKey, true);
    function button(label, cls, fn) { var b = el("button", cls || "", label); b.addEventListener("click", fn); row.appendChild(b); return b; }
    function fail(msg) {
      title.textContent = "Could not open this file"; sub.textContent = msg;
      row.appendChild(el("span", "grow")); button("Close", "p", close);
    }
    if (!circle) return fail("Add a circle in hyphae first.");
    try {
      var sealed = await fetchSealed(hit.id);
      if (sealed.length > MAX_OPEN) return fail("This file is larger than hyphae opens in the page (32 MB).");
      var opened = await Seal.openBytes([circle], sealed);
      var meta = opened.meta || {}, plain = opened.data || opened.bytes;
      if (!plain) throw new Error("the sealed file has no content");
      remember(hit.opaque, meta.name || hit.opaque);
      title.textContent = meta.name || "Sealed file";
      sub.textContent = human(plain.length) + "  ·  decrypted on this device; Drive holds only the sealed bytes";
      var mime = meta.mime || "application/octet-stream";
      var area = null, url = null;
      if (isTextFile(meta) && plain.length < 4 * 1048576) {
        area = document.createElement("textarea");
        area.value = new TextDecoder().decode(plain);
        area.style.cssText = "width:100%;height:46vh;box-sizing:border-box;background:#171925;color:#cfc8ec;border:0;outline:0;resize:none;font:12.5px/1.5 ui-monospace,Menlo,monospace";
        ["keydown", "keyup", "keypress"].forEach(function (t) { area.addEventListener(t, function (e) { if (e.key !== "Escape") e.stopPropagation(); }); });
        body.appendChild(area);
      } else if (/^image\//.test(mime) && mime !== "image/svg+xml") {
        url = URL.createObjectURL(new Blob([plain], { type: mime }));
        var im = document.createElement("img"); im.src = url; im.style.cssText = "max-width:100%;display:block;margin:0 auto";
        body.appendChild(im);
      } else {
        body.appendChild(el("div", "dim", "hyphae can't preview this type here. Download the decrypted file to open it."));
      }
      row.appendChild(el("span", "grow"));
      button("Download decrypted", "", function () { saveBlob(area ? new TextEncoder().encode(area.value) : plain, meta.name || "file", mime); });
      if (area) {
        var save = button("Save (re-seal)", "p", async function () {
          save.disabled = true;
          try {
            var edited = new File([area.value], meta.name || "file.txt", { type: mime, lastModified: Date.now() });
            var res = await sealFile(edited, hit.opaque);
            if (url) URL.revokeObjectURL(url);
            close();
            handToDrive(res.out);
          } catch (err) { save.disabled = false; sub.textContent = "Not saved: " + (err && err.message ? err.message : err); }
        });
      }
      button("Close", "", function () { if (url) URL.revokeObjectURL(url); close(); });
    } catch (err) { fail(err && err.message ? err.message : String(err)); }
  }

  /** Give a sealed File to Drive's own uploader, as if it had been dropped on the file list. */
  function handToDrive(file) {
    var dt = new DataTransfer(); dt.items.add(file);
    var target = document.querySelector('[role="main"]') || document.body;
    var ev;
    try { ev = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }); }
    catch (x) { ev = new Event("drop", { bubbles: true, cancelable: true }); ev.dataTransfer = dt; }
    ev.__hyphae = true;
    target.dispatchEvent(ev);
    toast("Saved sealed. If Drive asks, choose Replace — that makes it a new version.", 6000);
  }

  function intercept(e) {
    if (!on) return;
    if (e.type === "keydown" && e.key !== "Enter") return;
    if (e.target && e.target.closest && e.target.closest("[data-hyphae-ui]")) return;
    var hit = sealedRowOf(e.target);
    if (!hit && e.type === "keydown") hit = sealedRowOf(document.activeElement);
    if (!hit) return;
    e.preventDefault(); e.stopImmediatePropagation();
    openSealed(hit);
  }
  document.addEventListener("dblclick", intercept, true);
  document.addEventListener("keydown", intercept, true);

  // ---- the header button and its menu -----------------------------------------------------------
  var CSS =
    ":host{all:initial}*{box-sizing:border-box}" +
    ".btn{height:32px;border-radius:16px;border:1px solid #d9d3ef;background:#efecf8;padding:0 14px;cursor:pointer;" +
    "font:400 11px/1 " + FONT + ";letter-spacing:.2em;text-transform:uppercase;color:#4d4f66;display:flex;align-items:center;gap:8px}" +
    ".btn:hover{background:#e3def4}.btn.on{color:#5a46a8;font-weight:500;border-color:#7d6bb8}" +
    ".dot{width:7px;height:7px;border-radius:50%;background:#9aa0a6}.on .dot{background:#5a46a8}" +
    ".menu{position:fixed;width:340px;display:none;font:300 12px/1.45 " + FONT + ";color:#b1a6d4;background:#1b1d28;" +
    "border:1px solid #313140;border-radius:14px;box-shadow:0 10px 34px rgba(0,0,0,.4);padding:14px;z-index:2147483647}" +
    ".menu.open{display:block}.hd{display:flex;align-items:center;justify-content:space-between}" +
    ".word{font:300 10px/1 " + FONT + ";letter-spacing:.32em;text-transform:uppercase;color:#b1a6d4}" +
    ".sw{position:relative;width:38px;height:22px;border-radius:11px;background:#4d4f66;border:0;padding:0;cursor:pointer}" +
    ".sw::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .12s}" +
    ".sw.on{background:#7d6bb8}.sw.on::after{left:19px}" +
    ".st{margin-top:10px;font-size:13px;color:#cfc8ec;font-weight:400}.sub{margin-top:3px;font-size:11px;color:#8a8a9c}" +
    ".log{margin-top:10px;max-height:150px;overflow:auto;font:11px/1.4 ui-monospace,Menlo,monospace;color:#cfc8ec}" +
    ".log div{padding:4px 0;border-top:1px solid #313140;word-break:break-all}.log div:first-child{border-top:0}" +
    ".row{display:flex;gap:6px;margin-top:12px;flex-wrap:wrap}" +
    ".mb{font:inherit;font-size:11px;border:1px solid #938bb2;background:transparent;color:#b1a6d4;border-radius:999px;padding:3px 11px;cursor:pointer}" +
    ".mb:hover{background:rgba(147,139,178,.16)}.note{margin-top:10px;font-size:11px;color:#8a8a9c}";

  function build() {
    var host = document.createElement("div");
    host.setAttribute("data-hyphae-ui", "1");
    var shadow = host.attachShadow({ mode: "closed" });
    var style = document.createElement("style"); style.textContent = CSS; shadow.appendChild(style);
    var btn = el("button", "btn"); btn.type = "button";
    btn.appendChild(el("span", "dot")); btn.appendChild(el("span", "", "hyphae"));
    var menu = el("div", "menu");
    var hd = el("div", "hd");
    var sw = el("button", "sw"); sw.type = "button"; sw.title = "hyphae on or off";
    hd.appendChild(el("span", "word", "hyphae")); hd.appendChild(sw);
    var st = el("div", "st"), sub = el("div", "sub"), lg = el("div", "log");
    var row = el("div", "row");
    var copy = el("button", "mb", "Copy circle code"); copy.type = "button";
        var note = el("div", "note");
    note.textContent = "On: uploads are sealed first, sealed files show as “hyphae · name”, and double-clicking one opens it decrypted, editable and re-sealed on save. Off: sealed files are unreadable ciphertext named hy-….hyd.";
    [hd, st, sub, lg, row, note].forEach(function (n) { menu.appendChild(n); });
    shadow.appendChild(btn); shadow.appendChild(menu);

    sw.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (!on && !signedIn) { needSignIn(); return; }
      on = !on;
      try { chrome.storage.local.set({ driveSeal: on }); } catch (x) { /* ignore */ }
      swapNow(); paint(true);
    });
    btn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (menu.classList.contains("open")) { menu.classList.remove("open"); return; }
      var r = btn.getBoundingClientRect();
      menu.style.top = Math.round(r.bottom + 8) + "px";
      menu.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + "px";
      menu.classList.add("open");
    });
    copy.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      var code = circle && window.HyCrypto && window.HyCrypto.toWritten ? window.HyCrypto.toWritten(circle) : "";
      try { navigator.clipboard.writeText(code); copy.textContent = "Copied: send it by Signal"; } catch (x) { copy.textContent = "Couldn't copy"; }
    });
    document.addEventListener("mousedown", function (e) { if (e.target !== host) menu.classList.remove("open"); }, true);
    ["mousedown", "mouseup", "click", "keydown", "keyup", "contextmenu"].forEach(function (t) {
      host.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    return { host: host, btn: btn, sw: sw, st: st, sub: sub, lg: lg, key: "" };
  }

  /** Just before Drive's "Upgrade" button if there is one, else before the account button. */
  function slot() {
    var anchor = null;
    var cands = document.querySelectorAll('header a, header button, header [role="button"], [role="banner"] a, [role="banner"] button, [role="banner"] [role="button"]');
    for (var i = 0; i < cands.length; i++) {
      if (/^\s*upgrade\s*$/i.test(cands[i].textContent || "") && !cands[i].closest("[data-hyphae-ui]")) { anchor = cands[i]; break; }
    }
    if (!anchor) anchor = document.querySelector('a[aria-label*="Google Account"]');
    if (!anchor) return null;
    var child = anchor, parent = anchor.parentElement;
    for (var j = 0; j < 8 && parent; j++) {
      if (parent.children.length >= 3) return { parent: parent, before: child };
      child = parent; parent = parent.parentElement;
    }
    return null;
  }
  function place(d) {
    var sl = slot();
    if (sl) {
      if (d.host.parentNode !== sl.parent || d.host.nextSibling !== sl.before) sl.parent.insertBefore(d.host, sl.before);
      d.host.style.cssText = "all:initial;display:flex;align-items:center;margin:0 8px;";
      d.inHeader = true;
    } else if (!d.host.isConnected) {
      d.host.style.cssText = "all:initial;position:fixed;top:10px;right:210px;z-index:2147483646;display:flex;";
      (document.body || document.documentElement).appendChild(d.host);
      d.inHeader = false;
    }
  }
  function paint(force) {
    if (!dock) dock = build();
    place(dock);
    var key = [on, circle ? circle.kid : "", log.length ? log[0].t : 0].join("|");
    if (!force && dock.key === key) return;
    dock.key = key;
    dock.btn.className = "btn" + (on ? " on" : "");
    dock.sw.className = "sw" + (on ? " on" : "");
    if (!signedIn) { dock.st.textContent = "Signed out: sign in to hyphae with Matrix to use it"; dock.sub.textContent = "Open mail.hyphae.social/app and sign in"; }
    else dock.st.textContent = on ? "On: sealing uploads, showing real names" : "Off: Drive gets and shows files as they are";
    if (signedIn) dock.sub.textContent = circle ? ("Just you · Google Docs, Sheets and Slides can't be sealed") : "No circle yet — add one in hyphae";
    while (dock.lg.firstChild) dock.lg.removeChild(dock.lg.firstChild);
    log.forEach(function (l) { dock.lg.appendChild(el("div", "", l.msg)); });
  }

  function loadState(cb) {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["circles", "active", "driveSeal", "driveNames", "matrixUser"], function (d) {
          signedIn = !!(d && d.matrixUser);
          var cs = (d && d.circles) || {};
          var kid = (d && d.active && cs[d.active]) ? d.active : Object.keys(cs)[0];
          circle = (kid && signedIn) ? cs[kid] : null;
          if (d && d.driveSeal === true && signedIn) on = true;
          if (d && d.driveNames && typeof d.driveNames === "object") names = Object.assign(names, d.driveNames);
          cb();
        });
        return;
      }
    } catch (e) { /* fall through */ }
    cb();
  }

  window.__hyphaeDrive = {
    setCircle: function (c) { circle = c; paint(true); },
    setSignedIn: function (v) { signedIn = !!v; if (!signedIn) on = false; swapNow(); paint(true); },
    setOn: function (v) { on = !!v; swapNow(); paint(true); },
    setNames: function (m) { names = Object.assign(names, m || {}); swapNow(); },
    setAsk: function (v) { askFirst = !!v; },
    state: function () {
      return { on: on, circle: circle ? circle.name : null, askFirst: askFirst, log: log.map(function (l) { return l.msg; }),
        swapped: swapped.size, inHeader: !!(dock && dock.inHeader), attached: !!(dock && dock.host.isConnected) };
    },
    sealFile: sealFile,
    process: process,
    teardown: function () {
      on = false; circle = null; swapNow(); closeOverlay();
      if (dock) dock.host.remove();
      delete window.__hyphaeDrive;
    },
  };
  try {
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== "local" || !ch.matrixUser) return;
      loadState(function () { if (!signedIn) on = false; swapNow(); paint(true); });
    });
  } catch (e) { /* no live follow */ }
  loadState(function () { paint(true); swapNow(); setInterval(function () { paint(false); }, 1000); });
})();
