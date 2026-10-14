// Hyphae worker: keyboard shortcuts, circles arriving from the hub, and the
// activity ledger. Shortcuts count as a user gesture, so activeTab grants one tab.
importScripts("crypto.js", "ledger-core.js", "contacts/core.js", "invite/p256.js", "invite/spake2.js", "invite/hyinvite.js", "invite-bridge.js", "release-key.js");

var storage = {
  get: async function (k) { return (await chrome.storage.local.get(k))[k]; },
  set: function (k, v) { var o = {}; o[k] = v; return chrome.storage.local.set(o); },
};

async function circlesByKid() {
  var data = await chrome.storage.local.get(["circles", "active"]);
  return { circles: data.circles || {}, active: data.active || null };
}

async function injectInto(tabId) {
  // gmail.js does nothing off mail.google.com; it rides along with the page layer.
  await chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: false }, files: ["crypto.js", "content.js", "gmail.js", "drive/hash.js", "drive/seal.js", "drive-page.js"] });
}

async function badge(tabId, text, color) {
  await chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: color });
  await chrome.action.setBadgeText({ tabId: tabId, text: text });
  setTimeout(function () { chrome.action.setBadgeText({ tabId: tabId, text: "" }); }, 2500);
}

// Toolbar mark: closed padlock around a capital H = encryption on, open padlock
// around a small h = off. Same path data as content.js and popup.js.
// The lock body is the letter: a notched block = capital H (closed), or a small
// h whose tall stem is the shackle's left leg (open).
var MARK = {
  closed: { shackle: "M6.25 10V8a5.75 5.75 0 0 1 11.5 0V10", body: "M4.7 10.5H8.5V14H15.5V10.5H19.3V21.3H15.5V17.5H8.5V21.3H4.7Z" },
  open: { shackle: "M6.25 13V8a5.75 5.75 0 0 1 11.5 0V10.2", body: "M4.7 13.5H19.3V21.3H15.5V18H8.5V21.3H4.7Z" },
};

function markImage(locked, size) {
  var c = new OffscreenCanvas(size, size);
  var g = c.getContext("2d");
  var color = locked ? "#059669" : "#d97706";
  var m = locked ? MARK.closed : MARK.open;
  g.scale(size / 24, size / 24);
  g.lineCap = "round";
  g.lineJoin = "round";
  g.strokeStyle = color; g.lineWidth = 3;
  g.stroke(new Path2D(m.shackle));
  g.fillStyle = color; g.lineWidth = 1.4;
  var body = new Path2D(m.body);
  g.fill(body);
  g.stroke(body);
  return g.getImageData(0, 0, size, size);
}

function setMark(locked, tabId) {
  var args = { imageData: { 16: markImage(locked, 16), 32: markImage(locked, 32) } };
  if (tabId != null) args.tabId = tabId;
  return chrome.action.setIcon(args).catch(function () { /* tab went away */ });
}

async function note(kind, data) {
  try { await HyLedger.record(storage, kind, data, Date.now()); } catch (e) { /* the ledger never blocks the action */ }
}

chrome.commands.onCommand.addListener(async function (command, tab) {
  if (!tab || tab.id == null) return;
  var state = await circlesByKid();
  try {
    await injectInto(tab.id);
    if (command === "seal-focused") {
      var circle = state.active && state.circles[state.active];
      if (!circle) return badge(tab.id, "?", "#b45309");
      var r = await chrome.tabs.sendMessage(tab.id, { hyphae: "seal", circle: circle });
      badge(tab.id, r && r.ok ? "✓" : "!", r && r.ok ? "#15803d" : "#b91c1c");
      if (r && r.ok) await note("seal", { url: tab.url, circleKid: circle.kid });
    } else if (command === "reveal-page") {
      var rr = await chrome.tabs.sendMessage(tab.id, { hyphae: "reveal", circles: state.circles });
      badge(tab.id, rr && rr.ok ? String(rr.opened) : "!", rr && rr.ok ? "#15803d" : "#b91c1c");
      if (rr && rr.ok) await note("reveal", { url: tab.url, opened: rr.opened, locked: rr.locked });
    } else if (command === "toggle-secure") {
      var sr = await chrome.tabs.sendMessage(tab.id, { hyphae: "secure", mode: "toggle" });
      // "ON" / "OFF" on the toolbar icon, so the state is visible even off-page
      badge(tab.id, sr && sr.ok ? (sr.secure ? "ON" : "OFF") : "!", sr && sr.ok ? (sr.secure ? "#15803d" : "#b45309") : "#b91c1c");
    } else if (command === "toggle-lens") {
      var lr = await chrome.tabs.sendMessage(tab.id, { hyphae: "lens", mode: "toggle" });
      // "P" = you see plaintext, "S" = the site's view (ciphertext)
      badge(tab.id, lr && lr.ok ? (lr.lens === "plain" ? "P" : "S") : "!", lr && lr.ok ? "#15803d" : "#b91c1c");
    }
  } catch (e) {
    // chrome:// pages, the Web Store and PDFs can't be scripted.
    badge(tab.id, "×", "#b91c1c");
  }
});

// Visits. This only does anything when the user chose a visits mode AND
// granted the optional "tabs" permission; without it, tab.url is not given.
var lastVisit = {};
chrome.tabs.onUpdated.addListener(function (tabId, info, tab) {
  if (info.status !== "complete" || !tab || !tab.url) return;
  var now = Date.now();
  if (lastVisit[tabId] && lastVisit[tabId].url === tab.url && now - lastVisit[tabId].t < 3000) return;
  lastVisit[tabId] = { url: tab.url, t: now };
  note("visit", { url: tab.url, title: tab.title });
});
chrome.tabs.onRemoved.addListener(function (tabId) { delete lastVisit[tabId]; });

// Messages.
//  - merge-circles: from bridge.js on the hub origin only. An existing key is
//    never replaced, and keys are never sent back out.
//  - record: from our own popup after a seal/reveal.
var HUB_ORIGIN = /^https:\/\/mail\.hyphae\.social\//;
var KID_RE = /^[A-Za-z0-9_-]{11}$/;
var KEY_RE = /^[A-Za-z0-9_-]{43}$/;

chrome.runtime.onMessage.addListener(function (msg, sender, send) {
  if (!msg) return;

  if (msg.hyphae === "record") {
    if (sender.id !== chrome.runtime.id || sender.tab) return; // popup only
    var kind = msg.kind === "seal" || msg.kind === "reveal" ? msg.kind : null;
    if (!kind) return;
    note(kind, msg.data || {}).then(function () { send({ ok: true }); });
    return true;
  }

  if (msg.hyphae !== "merge-circles") return;
  if (!sender || !sender.tab || !HUB_ORIGIN.test(sender.url || "")) {
    send({ added: 0, total: 0 });
    return;
  }
  (async function () {
    var state = await circlesByKid();
    var circles = state.circles, active = state.active, added = 0;
    (msg.circles || []).forEach(function (c) {
      if (!c || !KID_RE.test(c.kid) || !KEY_RE.test(c.key)) return;
      if (circles[c.kid]) return; // never overwrite a key we already hold
      circles[c.kid] = { kid: c.kid, name: String(c.name || "circle").slice(0, 60), key: c.key };
      if (!active) active = c.kid;
      added++;
    });
    if (added) await chrome.storage.local.set({ circles: circles, active: active });
    send({ added: added, total: Object.keys(circles).length });
  })();
  return true;
});

// ---- every-site mode -------------------------------------------------------
// Off by default. When the user turns it on (popup) and grants the optional
// all-sites permission, the page layer is registered for every page. It still
// does nothing until a page holds sealed text, and only then is it handed keys.
var AUTO_ID = "hyphae-auto";

async function autoState() {
  var d = await chrome.storage.local.get(["everySite", "offSites"]);
  return { on: d.everySite === true, off: Array.isArray(d.offSites) ? d.offSites : [] };
}

async function registerAuto() {
  var s = await autoState();
  try { await chrome.scripting.unregisterContentScripts({ ids: [AUTO_ID] }); } catch (e) { /* not registered */ }
  if (!s.on) return;
  var has = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  if (!has) return;
  var exclude = s.off.slice(0, 200).map(function (h) { return "*://" + h + "/*"; });
  await chrome.scripting.registerContentScripts([{
    id: AUTO_ID,
    matches: ["<all_urls>"],
    excludeMatches: exclude,
    js: ["crypto.js", "content.js", "gmail.js", "drive/hash.js", "drive/seal.js", "drive-page.js", "auto.js"],
    runAt: "document_idle",
    allFrames: false,
    persistAcrossSessions: true,
  }]);
}

// Updates. Every push to main publishes a signed release on GitHub (extension-release.yml).
// The worker only asks GitHub for the latest release's version; it fetches no code. When
// a newer one is out it opens update.html?auto=1 in a background tab, which downloads the
// zip, verifies its signature against release-key.js, writes it into the folder you
// granted once, and reloads. If that page can't finish without you (no folder yet, or
// Chrome wants the folder permission confirmed) the toolbar shows ↑ and the popup offers
// the update instead.
var RELEASES_URL = "https://api.github.com/repos/" + self.HyReleaseKey.repo + "/releases/latest";
var UPDATE_EVERY_MIN = 60;

function newer(a, b) {
  var x = String(a).split("."), y = String(b).split(".");
  for (var i = 0; i < Math.max(x.length, y.length); i++) {
    var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0);
    if (d) return d > 0;
  }
  return false;
}

async function checkUpdate(force) {
  var have = chrome.runtime.getManifest().version;
  var d = (await chrome.storage.local.get("update")).update || {};
  if (force || !d.checkedAt || Date.now() - d.checkedAt > 5 * 60 * 1000) {
    try {
      var r = await fetch(RELEASES_URL, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store", credentials: "omit" });
      if (r.ok) {
        var v = String((await r.json()).tag_name || "").replace(/^v/, "");
        if (/^\d+(\.\d+){0,3}$/.test(v)) { d.latest = v; d.checkedAt = Date.now(); }
      }
    } catch (e) { /* offline: keep what we had */ }
  }
  var up = !!d.latest && newer(d.latest, have);
  // One silent attempt per version; after that it waits for you in the popup.
  if (up && d.autoTried !== d.latest) {
    d.autoTried = d.latest;
    chrome.tabs.create({ url: chrome.runtime.getURL("update.html?auto=1"), active: false });
  }
  await chrome.storage.local.set({ update: d });
  return markUpdate(have, d.latest);
}

async function markUpdate(have, latest) {
  var up = !!latest && newer(latest, have);
  await chrome.action.setBadgeBackgroundColor({ color: "#5a46a8" });
  await chrome.action.setBadgeText({ text: up ? "↑" : "" });
  return { have: have, latest: latest || null, available: up };
}

chrome.alarms.create("hyphae-update", { periodInMinutes: UPDATE_EVERY_MIN, delayInMinutes: 1 });
chrome.alarms.onAlarm.addListener(function (a) { if (a.name === "hyphae-update") checkUpdate(true); });
chrome.runtime.onInstalled.addListener(function () { registerAuto(); setMark(false); checkUpdate(true); });
chrome.runtime.onStartup.addListener(function () { registerAuto(); setMark(false); checkUpdate(true); });

// The invite flow (invite/hyinvite.js through invite-bridge.js). The identity keys and
// every pair key live only here; pages ask by message and get text and plain objects.
var inviteBridge = HyInviteBridge.create({ HyInvite: HyInvite, storage: storage });

// The contacts directory (contacts/core.js). Pages ask it by message and get a
// status back — never a key. It is told which circles are held by id only.
var contacts = HyContacts.create({ storage: HyContacts.fromChrome(chrome.storage.local) });
async function syncHeldCircles() {
  var d = await chrome.storage.local.get("circles");
  try { await contacts.setHeldCircles(Object.keys(d.circles || {})); } catch (e) { /* the next change retries */ }
}
syncHeldCircles();
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === "local" && changes.circles) syncHeldCircles();
});

chrome.runtime.onMessage.addListener(function (msg, sender, send) {
  if (!msg) return;

  // The invite flow. Own pages only; nothing returned is a key (the one-time code goes
  // to hyphae's own panel and is refused by the send guard anywhere in a Gmail field).
  if (msg.hyphae === "invite") {
    if (sender.id !== chrome.runtime.id) return;
    inviteBridge.handle(String(msg.op || ""), msg.args).then(send, function () { send({ ok: false, reason: "error" }); });
    return true;
  }

  // Contacts. A content script may only look an address up or get suggestions;
  // the rest of the directory is for hyphae's own pages (sheet, popup). What a
  // page gets back is a name, addresses, a status and the id of the circle it
  // would be sealed to: never a Matrix identifier or a key.
  if (msg.hyphae === "contacts") {
    if (sender.id !== chrome.runtime.id) return;
    var fromPage = !!sender.tab && !/^chrome-extension:/.test(sender.url || "");
    var allowed = fromPage ? ["byEmail", "search"] : ["all", "byEmail", "search", "importGoogle", "importMatrix", "link", "setHeldCircles", "remove"];
    if (allowed.indexOf(msg.op) === -1) { send({ ok: false, code: "refused" }); return; }
    var args = Array.isArray(msg.args) ? msg.args : [];
    if (fromPage && (args.length !== 1 || typeof args[0] !== "string" || args[0].length > 200)) { send({ ok: false, code: "refused" }); return; }
    var shape = function (c) {
      return { name: c.name, emails: c.emails, status: c.status, circleKid: c.circleKid };
    };
    contacts[msg.op].apply(contacts, args).then(
      async function (r) {
        if (fromPage) {
          r = Array.isArray(r) ? r.slice(0, 8).map(shape) : (r ? shape(r) : null);
          // People connected by invitation are known to hyphae only; they join the suggestions here.
          if (msg.op === "search" && Array.isArray(r)) {
            try {
              var d = await inviteBridge.handle("directory", { q: args[0] });
              r = HyInviteBridge.mergeSuggestions(r, d.people);
            } catch (e) { /* the store's own answers stand */ }
          }
        }
        send({ ok: true, result: r });
      },
      function (e) { send({ ok: false, code: (e && e.code) || "error", message: String(e && e.message) }); }
    );
    return true;
  }

  // The page layer reports its encryption state so the toolbar mark follows it.
  // Own content script only; it carries no key and no page content.
  if (msg.hyphae === "secure-state") {
    if (sender.id !== chrome.runtime.id || !sender.tab) return;
    setMark(msg.secure === true, sender.tab.id);
    return;
  }

  // Keys go only to our own content script, only for sites that aren't switched off.
  if (msg.hyphae === "get-circles") {
    if (sender.id !== chrome.runtime.id || !sender.tab || !sender.tab.url) { send({ circles: null }); return; }
    (async function () {
      if (!(await chrome.storage.local.get("matrixUser")).matrixUser) return send({ circles: null, signedOut: true });
      var s = await autoState();
      var host = "";
      try { host = new URL(sender.tab.url).hostname.toLowerCase(); } catch (e) { /* ignore */ }
      if (!s.on || !host || s.off.indexOf(host) !== -1) return send({ circles: null });
      var st = await circlesByKid();
      send({ circles: st.circles });
    })();
    return true;
  }

  // From our own popup only.
  if (msg.hyphae === "update-check") {
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    checkUpdate(msg.force === true).then(send, function () { send(null); });
    return true;
  }
  if (msg.hyphae === "update-open") {
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    chrome.tabs.create({ url: chrome.runtime.getURL("update.html") });
    return;
  }

  if (msg.hyphae === "auto-set" || msg.hyphae === "site-off") {
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    (async function () {
      var d = await chrome.storage.local.get(["offSites"]);
      var off = Array.isArray(d.offSites) ? d.offSites : [];
      if (msg.hyphae === "auto-set") {
        await chrome.storage.local.set({ everySite: msg.on === true });
      } else {
        var h = String(msg.host || "").toLowerCase();
        if (!h) return send({ ok: false });
        off = off.filter(function (x) { return x !== h; });
        if (msg.off === true) off.push(h);
        await chrome.storage.local.set({ offSites: off });
      }
      await registerAuto();
      send({ ok: true });
    })();
    return true;
  }
});

// Drive: fetch a sealed file's bytes for the page viewer (drive-page.js), with the signed-in
// Drive session. Only from a drive.google.com tab of ours; the page decrypts, not this worker.
chrome.runtime.onMessage.addListener(function (msg, sender, send) {
  if (!msg || msg.hyphae !== "drive-fetch") return;
  var okTab = sender.id === chrome.runtime.id && sender.tab && /^https:\/\/drive\.google\.com\//.test(sender.url || "");
  var id = String(msg.id || "");
  if (!okTab || !/^[\w-]{10,80}$/.test(id)) { send({ ok: false, message: "refused" }); return; }
  (async function () {
    var r = await fetch("https://drive.google.com/uc?export=download&confirm=t&id=" + encodeURIComponent(id), { credentials: "include", cache: "no-store" });
    if (!r.ok) throw new Error("Drive answered " + r.status);
    if (/text\/html/i.test(r.headers.get("content-type") || "")) throw new Error("Drive returned a page, not the file (sign in, or the file is not shared with you)");
    var buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > 32 * 1048576) throw new Error("file is larger than 32 MB");
    var s = "";
    for (var i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    send({ ok: true, b64: btoa(s) });
  })().catch(function (e) { send({ ok: false, message: String(e && e.message || e) }); });
  return true;
});

// Sign-in gate. The hub page (signed in to Matrix) tells us who it is; until it has, no key
// is handed to any page and the Drive layer stays off. It is a gate, not a boundary: it
// follows what the hub origin's own page says, and the hub is the only place that can say it.
chrome.runtime.onMessage.addListener(function (msg, sender, send) {
  if (!msg || msg.hyphae !== "session") return;
  if (!sender || !sender.tab || !HUB_ORIGIN.test(sender.url || "")) return;
  var u = typeof msg.user === "string" ? msg.user.trim().slice(0, 200) : "";
  if (!u) { chrome.storage.local.remove("matrixUser"); return; }
  // One person for now: the first sign-in makes a personal circle (a key only this device
  // and you hold), so there is never a "no circle yet". Sharing with others comes later,
  // by invitation, on top of the same circle model.
  (async function () {
    var st = await circlesByKid();
    if (!Object.keys(st.circles).length) {
      var c = HyCrypto.newCircle("Personal");
      st.circles[c.kid] = c;
      await chrome.storage.local.set({ circles: st.circles, active: c.kid });
    }
    await chrome.storage.local.set({ matrixUser: u });
  })();
});

// "Sync with GitHub": check now and, if a newer signed release is out, install it now.
chrome.runtime.onMessage.addListener(function (msg, sender, send) {
  if (!msg || msg.hyphae !== "update-sync") return;
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  checkUpdate(true).then(function (u) {
    if (u && u.available) chrome.tabs.create({ url: chrome.runtime.getURL("update.html?auto=1"), active: false });
    send(u);
  }, function () { send(null); });
  return true;
});
