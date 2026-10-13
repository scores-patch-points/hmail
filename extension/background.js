// Keyboard shortcuts. The popup does the same through its buttons.
// A command counts as a user gesture, so activeTab grants this one tab only.

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
    } else if (command === "reveal-page") {
      var rr = await chrome.tabs.sendMessage(tab.id, { hyphae: "reveal", circles: state.circles });
      badge(tab.id, rr && rr.ok ? String(rr.opened) : "!", rr && rr.ok ? "#15803d" : "#b91c1c");
    }
  } catch (e) {
    // chrome:// pages, the Web Store and PDFs can't be scripted.
    badge(tab.id, "×", "#b91c1c");
  }
});

// Circles arriving from the hub over Matrix, via bridge.js.
// Only the hub origin may add circles; an existing circle's key is never
// replaced (a hostile page can't swap a key you already trust), and keys are
// never sent back out of the extension.
var HUB_ORIGIN = /^https:\/\/mail\.hyphae\.social\//;
var KID_RE = /^[A-Za-z0-9_-]{11}$/;
var KEY_RE = /^[A-Za-z0-9_-]{43}$/;

chrome.runtime.onMessage.addListener(function (msg, sender, send) {
  if (!msg || msg.hyphae !== "merge-circles") return;
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
