// Hyphae worker: keyboard shortcuts, circles arriving from the hub, and the
// activity ledger. Shortcuts count as a user gesture, so activeTab grants one tab.
importScripts("crypto.js", "ledger-core.js");

var storage = {
  get: async function (k) { return (await chrome.storage.local.get(k))[k]; },
  set: function (k, v) { var o = {}; o[k] = v; return chrome.storage.local.set(o); },
};

async function circlesByKid() {
  var data = await chrome.storage.local.get(["circles", "active"]);
  return { circles: data.circles || {}, active: data.active || null };
}

async function injectInto(tabId) {
  await chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: false }, files: ["crypto.js", "content.js"] });
}

async function badge(tabId, text, color) {
  await chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: color });
  await chrome.action.setBadgeText({ tabId: tabId, text: text });
  setTimeout(function () { chrome.action.setBadgeText({ tabId: tabId, text: "" }); }, 2500);
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
