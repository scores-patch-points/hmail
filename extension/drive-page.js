/*
 * hyphae on drive.google.com — a button, and a seal on the way in.
 *
 * While it is on, every file you pick or drop into Drive (a new upload, or a new
 * version of one) is sealed on this device under your circle key before Drive's own
 * page code receives it. Drive then uploads the sealed bytes under an opaque name.
 * Google Docs, Sheets and Slides cannot be sealed (Google edits them on its servers),
 * and files already in your Drive are not touched here: the Drive sweep in the
 * worker does those.
 *
 * Sharing is two separate things on purpose: Google's Share dialog gives someone
 * the (sealed) file; the circle key, which opens it, goes by another channel. This
 * script never puts a key in Drive.
 *
 * Loaded after crypto.js, drive/hash.js and drive/seal.js. Closed shadow root,
 * DOM calls only (Drive enforces Trusted Types).
 */
(function () {
  "use strict";
  if (location.hostname !== "drive.google.com" && !window.__hyphaeDriveAllow) return;
  if (window.__hyphaeDrive) return;
  var Seal = window.HyDriveSeal;
  if (!Seal) return;

  var FONT = "'Helvetica Neue','SF Pro Display',ui-sans-serif,system-ui,sans-serif";
  var on = false, circle = null, log = [], dock = null;
  var sealedFiles = (typeof WeakSet === "function") ? new WeakSet() : null;
  var NAME_RE = /^hy-[a-z2-7]{24}\.hyd$/;
  var BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

  function opaqueName() {
    var b = new Uint8Array(24);
    crypto.getRandomValues(b);
    var s = "hy-";
    for (var i = 0; i < b.length; i++) s += BASE32[b[i] & 31];
    return s + ".hyd";
  }
  function alreadySealed(f) { return (sealedFiles && sealedFiles.has(f)) || NAME_RE.test(f.name); }
  function say(msg) { log.unshift({ t: Date.now(), msg: msg }); if (log.length > 8) log.pop(); paint(true); }

  /** One file in, one sealed File out. The real name travels inside the sealed bytes. */
  async function sealFile(file) {
    var bytes = new Uint8Array(await file.arrayBuffer());
    var sealed = await Seal.sealBytes(circle, bytes, {
      name: file.name, mime: file.type || "application/octet-stream", size: bytes.length,
      mtime: file.lastModified || Date.now(), id: "upload", path: null,
    });
    var out = new File([sealed], opaqueName(), { type: "application/octet-stream", lastModified: Date.now() });
    if (sealedFiles) sealedFiles.add(out);
    say(file.name + "  →  " + out.name + "  (" + bytes.length + " B in, " + sealed.length + " B sealed)");
    return out;
  }
  async function sealList(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(alreadySealed(list[i]) ? list[i] : await sealFile(list[i]));
    return out;
  }

  // ---- interception -----------------------------------------------------------------
  // A file picker fires "change" on an <input type=file>; a drop fires "drop". Both are
  // caught first (capture, at the document), the files are replaced with sealed ones,
  // and the event is re-sent so Drive's own code carries on as if the person had picked
  // the sealed files. If sealing fails, nothing reaches Drive.

  document.addEventListener("change", function (e) {
    var t = e.target;
    if (!on || !circle || !t || t.tagName !== "INPUT" || t.type !== "file" || !t.files || !t.files.length) return;
    if (Array.prototype.every.call(t.files, alreadySealed)) return;
    e.stopImmediatePropagation();
    var picked = Array.prototype.slice.call(t.files);
    sealList(picked).then(function (outs) {
      var dt = new DataTransfer();
      outs.forEach(function (f) { dt.items.add(f); });
      t.files = dt.files;
      t.dispatchEvent(new Event("change", { bubbles: true }));
    }, function (err) {
      try { t.value = ""; } catch (x) { /* ignore */ }
      say("Not uploaded: " + (err && err.message ? err.message : err));
    });
  }, true);

  document.addEventListener("drop", function (e) {
    var dt0 = e.dataTransfer;
    if (!on || !circle || e.__hyphae || !dt0 || !dt0.files || !dt0.files.length) return;
    var files = Array.prototype.slice.call(dt0.files);
    if (!files.length || files.every(alreadySealed)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    var target = e.target, cx = e.clientX, cy = e.clientY;
    sealList(files).then(function (outs) {
      var dt = new DataTransfer();
      outs.forEach(function (f) { dt.items.add(f); });
      var ev;
      try { ev = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }); }
      catch (x) { ev = new Event("drop", { bubbles: true, cancelable: true }); ev.dataTransfer = dt; }
      ev.__hyphae = true;
      target.dispatchEvent(ev);
    }, function (err) { say("Not uploaded: " + (err && err.message ? err.message : err)); });
  }, true);

  // ---- the button and its menu ---------------------------------------------------------

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

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function build() {
    var host = document.createElement("div");
    host.setAttribute("data-hyphae-ui", "1");
    var shadow = host.attachShadow({ mode: "closed" });
    var style = document.createElement("style"); style.textContent = CSS; shadow.appendChild(style);
    var btn = el("button", "btn"); btn.type = "button";
    btn.appendChild(el("span", "dot")); btn.appendChild(el("span", "", "hyphae"));
    var menu = el("div", "menu");
    var hd = el("div", "hd");
    var sw = el("button", "sw"); sw.type = "button"; sw.title = "Seal uploads";
    hd.appendChild(el("span", "word", "hyphae")); hd.appendChild(sw);
    var st = el("div", "st"), sub = el("div", "sub"), lg = el("div", "log");
    var row = el("div", "row");
    var copy = el("button", "mb", "Copy circle code"); copy.type = "button";
    row.appendChild(copy);
    var note = el("div", "note");
    note.textContent = "Share the file with Google's Share dialog as usual; they get sealed bytes. Give them the circle code by Signal or in person, never in Drive or email, and they can open it.";
    [hd, st, sub, lg, row, note].forEach(function (n) { menu.appendChild(n); });
    shadow.appendChild(btn); shadow.appendChild(menu);

    sw.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); on = !on; try { chrome.storage.local.set({ driveSeal: on }); } catch (x) { /* ignore */ } paint(true); });
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
    var s = slot();
    if (s) {
      if (d.host.parentNode !== s.parent || d.host.nextSibling !== s.before) s.parent.insertBefore(d.host, s.before);
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
    dock.st.textContent = on ? "Sealing uploads and new versions" : "Off: Drive receives files as they are";
    dock.sub.textContent = circle ? ("Circle “" + circle.name + "” · Google Docs, Sheets and Slides can't be sealed") : "No circle yet — add one in hyphae";
    while (dock.lg.firstChild) dock.lg.removeChild(dock.lg.firstChild);
    log.forEach(function (l) { dock.lg.appendChild(el("div", "", l.msg)); });
  }

  function loadCircle(cb) {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["circles", "active", "driveSeal"], function (d) {
          var cs = (d && d.circles) || {};
          var kid = (d && d.active && cs[d.active]) ? d.active : Object.keys(cs)[0];
          circle = kid ? cs[kid] : null;
          if (d && d.driveSeal === true) on = true;
          cb();
        });
        return;
      }
    } catch (e) { /* fall through */ }
    cb();
  }

  window.__hyphaeDrive = {
    setCircle: function (c) { circle = c; paint(true); },
    setOn: function (v) { on = !!v; paint(true); },
    state: function () {
      return { on: on, circle: circle ? circle.name : null, log: log.map(function (l) { return l.msg; }),
        inHeader: !!(dock && dock.inHeader), attached: !!(dock && dock.host.isConnected) };
    },
    sealFile: sealFile,
  };
  loadCircle(function () { paint(true); setInterval(function () { paint(false); }, 1000); });
})();
