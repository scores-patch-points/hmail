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
