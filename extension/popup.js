(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var state = { circles: {}, active: null };

  function say(msg, kind) {
    var s = $("status");
    s.textContent = msg;
    s.className = kind || "";
  }

  async function load() {
    var d = await chrome.storage.local.get(["circles", "active"]);
    state.circles = d.circles || {};
    state.active = d.active && state.circles[d.active] ? d.active : (Object.keys(state.circles)[0] || null);
    render();
  }
  async function save() {
    await chrome.storage.local.set({ circles: state.circles, active: state.active });
  }

  function render() {
    var sel = $("circle");
    sel.innerHTML = "";
    var kids = Object.keys(state.circles);
    if (!kids.length) {
      var o = document.createElement("option");
      o.textContent = "No circle yet — create one below";
      o.value = "";
      sel.appendChild(o);
    }
    kids.forEach(function (kid) {
      var o = document.createElement("option");
      o.value = kid;
      o.textContent = state.circles[kid].name;
      if (kid === state.active) o.selected = true;
      sel.appendChild(o);
    });
    var c = state.active && state.circles[state.active];
    $("share").value = c ? HyCrypto.shareString(c) : "";
    $("seal").disabled = !c;
  }

  async function activeTab() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }
  async function inject(tab) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["crypto.js", "content.js"] });
  }

  $("circle").addEventListener("change", async function () {
    state.active = $("circle").value || null;
    await save();
    render();
  });

  $("create").addEventListener("click", async function () {
    var name = $("newName").value.trim();
    if (!name) return say("Give the circle a name.", "err");
    var c = HyCrypto.newCircle(name);
    state.circles[c.kid] = c;
    state.active = c.kid;
    $("newName").value = "";
    await save();
    render();
    say("Created “" + c.name + "”. Share its key with the people who should read it.", "ok");
  });

  $("copy").addEventListener("click", async function () {
    var v = $("share").value;
    if (!v) return say("Select a circle first.", "err");
    try { await navigator.clipboard.writeText(v); say("Key copied. Only send it over a channel you trust.", "ok"); }
    catch (e) { $("share").select(); say("Copy with ⌘/Ctrl+C.", ""); }
  });

  $("doImport").addEventListener("click", async function () {
    var p = HyCrypto.parseShare($("import").value);
    if (!p) return say("That isn't a Hyphae key.", "err");
    state.circles[p.kid] = { kid: p.kid, name: p.name || "circle", key: p.key };
    state.active = p.kid;
    $("import").value = "";
    await save();
    render();
    say("Joined “" + (p.name || "circle") + "”.", "ok");
  });

  $("seal").addEventListener("click", async function () {
    var c = state.active && state.circles[state.active];
    if (!c) return say("Create or join a circle first.", "err");
    try {
      var tab = await activeTab();
      await inject(tab);
      var r = await chrome.tabs.sendMessage(tab.id, { hyphae: "seal", circle: c });
      if (r && r.ok) { say("Sealed " + r.sealed + " characters for “" + c.name + "”.", "ok"); }
      else { say((r && r.reason) || "Couldn't seal that.", "err"); }
    } catch (e) {
      say("Hyphae can't run on this page.", "err");
    }
  });

  $("reveal").addEventListener("click", async function () {
    try {
      var tab = await activeTab();
      await inject(tab);
      var r = await chrome.tabs.sendMessage(tab.id, { hyphae: "reveal", circles: state.circles });
      if (!r || !r.ok) return say((r && r.reason) || "Couldn't reveal.", "err");
      if (r.opened) say("Revealed " + r.opened + " sealed item" + (r.opened === 1 ? "" : "s") + ".", "ok");
      else if (r.locked) say(r.locked + " sealed item(s) here are for circles you haven't joined.", "err");
      else say("No sealed text on this page.", "");
    } catch (e) {
      say("Hyphae can't run on this page.", "err");
    }
  });

  load();
})();
