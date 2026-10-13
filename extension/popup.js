(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var state = { circles: {}, active: null, policy: { mode: "seal-only", paused: false, textSites: [] }, queued: 0 };

  function say(msg, kind) {
    var s = $("status");
    s.textContent = msg;
    s.className = kind || "";
  }

  async function load() {
    var d = await chrome.storage.local.get(["circles", "active", "policy", "ledger"]);
    state.circles = d.circles || {};
    state.active = d.active && state.circles[d.active] ? d.active : (Object.keys(state.circles)[0] || null);
    if (d.policy && typeof d.policy === "object") {
      state.policy = {
        mode: d.policy.mode === "visits" ? "visits" : "seal-only",
        paused: d.policy.paused === true,
        textSites: Array.isArray(d.policy.textSites) ? d.policy.textSites : [],
      };
    }
    state.queued = (d.ledger || []).length;
    render();
  }
  async function save() {
    await chrome.storage.local.set({ circles: state.circles, active: state.active });
  }
  async function savePolicy() {
    await chrome.storage.local.set({ policy: state.policy });
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
      var opt = document.createElement("option");
      opt.value = kid;
      opt.textContent = state.circles[kid].name;
      if (kid === state.active) opt.selected = true;
      sel.appendChild(opt);
    });
    var c = state.active && state.circles[state.active];
    $("share").value = c ? HyCrypto.shareString(c) : "";
    $("seal").disabled = !c;

    $("mode").value = state.policy.mode;
    $("paused").checked = state.policy.paused;
    $("ledgerInfo").textContent = state.policy.paused
      ? "Paused. Nothing is being recorded."
      : state.queued + " sealed event" + (state.queued === 1 ? "" : "s") + " queued on this device.";
  }

  async function activeTab() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }
  async function inject(tab) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["crypto.js", "content.js"] });
  }
  function tell(kind, data) {
    // Best effort; the ledger never gets in the way of the action.
    try { chrome.runtime.sendMessage({ hyphae: "record", kind: kind, data: data }, function () { void chrome.runtime.lastError; }); }
    catch (e) { /* ignore */ }
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
      if (r && r.ok) {
        say("Sealed " + r.sealed + " characters for “" + c.name + "”.", "ok");
        tell("seal", { url: tab.url, circleKid: c.kid });
      } else { say((r && r.reason) || "Couldn't seal that.", "err"); }
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
      tell("reveal", { url: tab.url, opened: r.opened, locked: r.locked });
      if (r.opened) say("Revealed " + r.opened + " sealed item" + (r.opened === 1 ? "" : "s") + ".", "ok");
      else if (r.locked) say(r.locked + " sealed item(s) here are for circles you haven't joined.", "err");
      else say("No sealed text on this page.", "");
    } catch (e) {
      say("Hyphae can't run on this page.", "err");
    }
  });

  // Activity ledger settings. Visit capture needs the optional "tabs"
  // permission, asked for only here, only when the user picks it.
  $("mode").addEventListener("change", async function () {
    var want = $("mode").value;
    if (want === "visits") {
      var granted = false;
      try { granted = await chrome.permissions.request({ permissions: ["tabs"] }); } catch (e) { granted = false; }
      if (!granted) {
        $("mode").value = state.policy.mode;
        return say("Visit recording needs the “tabs” permission, which wasn't granted.", "err");
      }
    }
    state.policy.mode = want === "visits" ? "visits" : "seal-only";
    await savePolicy();
    render();
    say(want === "visits" ? "Recording the pages you open, sealed on this device." : "Recording only seal / reveal actions.", "ok");
  });

  $("paused").addEventListener("change", async function () {
    state.policy.paused = $("paused").checked;
    await savePolicy();
    render();
  });

  load();
})();
