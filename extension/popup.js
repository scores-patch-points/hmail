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
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["crypto.js", "content.js", "gmail.js", "drive/hash.js", "drive/seal.js", "drive-page.js"] });
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
    if (!p) return say("That isn't a hyphae key.", "err");
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
      say("hyphae can't run on this page.", "err");
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
      say("hyphae can't run on this page.", "err");
    }
  });

  // The one switch: encryption on or off for this page.
  async function paintSecure(on) {
    $("secure").checked = !!on;
    $("secureLabel").textContent = on ? "Encryption on — page is protected" : "Encryption off — the site's view";
  }
  async function loadSecure() {
    try {
      var tab = await activeTab();
      await inject(tab);
      var r = await chrome.tabs.sendMessage(tab.id, { hyphae: "secure", mode: "state" });
      if (r && r.ok) paintSecure(r.secure);
    } catch (e) {
      $("secure").disabled = true;
      $("secureLabel").textContent = "Encryption (can't run on this page)";
    }
  }
  $("secure").addEventListener("change", async function () {
    var want = $("secure").checked;
    try {
      var tab = await activeTab();
      await inject(tab);
      var r = await chrome.tabs.sendMessage(tab.id, { hyphae: "secure", mode: want ? "on" : "off" });
      if (!r || !r.ok) throw new Error("no reply");
      paintSecure(r.secure);
      say(r.secure ? "Encryption on: you see what your circle sealed." : "Encryption off: this is what the site sees.", "ok");
    } catch (e) {
      $("secure").checked = !want;
      say("hyphae can't run on this page.", "err");
    }
  });

  $("lens").addEventListener("click", async function () {
    try {
      var tab = await activeTab();
      await inject(tab);
      var r = await chrome.tabs.sendMessage(tab.id, { hyphae: "lens", mode: "toggle" });
      if (!r || !r.ok) return say("Couldn't switch the lens.", "err");
      if (!r.count) return say("Nothing revealed on this page yet — press Reveal first.", "");
      say(r.lens === "plain"
        ? "Showing what YOU see (plaintext)."
        : "Showing what the SITE sees (ciphertext).", "ok");
    } catch (e) {
      say("hyphae can't run on this page.", "err");
    }
  });

  // Every-site mode. The browser's permission prompt needs a click, so the
  // request happens here; the worker does the registering.
  async function hostOf(tab) {
    try { return new URL(tab.url).hostname.toLowerCase(); } catch (e) { return ""; }
  }
  async function loadAuto() {
    var d = await chrome.storage.local.get(["everySite", "offSites"]);
    var has = false;
    try { has = await chrome.permissions.contains({ origins: ["<all_urls>"] }); } catch (e) { /* ignore */ }
    $("everySite").checked = d.everySite === true && has;
    var tab = await activeTab();
    var host = tab ? await hostOf(tab) : "";
    var off = Array.isArray(d.offSites) && host && d.offSites.indexOf(host) !== -1;
    $("siteOff").textContent = off ? "Turn back on for " + host : "Not on this site";
    $("siteOff").disabled = !host;
  }
  $("everySite").addEventListener("change", async function () {
    var want = $("everySite").checked;
    if (want) {
      var ok = false;
      try { ok = await chrome.permissions.request({ origins: ["<all_urls>"] }); } catch (e) { ok = false; }
      if (!ok) { $("everySite").checked = false; return say("Access to all sites wasn't granted.", "err"); }
    }
    await chrome.runtime.sendMessage({ hyphae: "auto-set", on: want });
    if (!want) { try { await chrome.permissions.remove({ origins: ["<all_urls>"] }); } catch (e) { /* ignore */ } }
    say(want ? "On: sealed text opens on any site as it loads." : "Off: hyphae only runs where you invoke it.", "ok");
  });
  $("siteOff").addEventListener("click", async function () {
    var tab = await activeTab();
    var host = tab ? await hostOf(tab) : "";
    if (!host) return;
    var d = await chrome.storage.local.get(["offSites"]);
    var isOff = Array.isArray(d.offSites) && d.offSites.indexOf(host) !== -1;
    await chrome.runtime.sendMessage({ hyphae: "site-off", host: host, off: !isOff });
    await loadAuto();
    say(isOff ? "Back on for " + host + "." : "hyphae will not run on " + host + ".", "ok");
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

  async function loadUpdate() {
    var u = await chrome.runtime.sendMessage({ hyphae: "update-check" });
    if (!u || !u.available) return;
    $("updateText").textContent = "hyphae " + u.latest + " is out — this is " + u.have + ".";
    $("update").style.display = "block";
  }
  $("updateOpen").addEventListener("click", function () {
    chrome.runtime.sendMessage({ hyphae: "update-open" });
    window.close();
  });

  $("messages").addEventListener("click", function () {
    chrome.tabs.create({ url: "https://app.element.io/#/login?hs_url=https%3A%2F%2Fhyphae.social" });
  });
  var ver = chrome.runtime.getManifest().version;
  $("syncState").textContent = "v" + ver;
  $("syncGh").addEventListener("click", async function () {
    $("syncState").textContent = "checking…";
    var u = await chrome.runtime.sendMessage({ hyphae: "update-sync" });
    $("syncState").textContent = !u ? "couldn't reach GitHub"
      : u.available ? "installing v" + u.latest + "…" : "v" + ver + " · up to date";
  });

  chrome.storage.local.get("matrixUser", function (d) {
    if (d && d.matrixUser) return;
    document.body.classList.add("locked");
    $("gate").style.display = "block";
    $("gateOpen").addEventListener("click", function () {
      chrome.tabs.create({ url: "https://mail.hyphae.social/app/" });
    });
  });

  load();
  loadAuto();
  loadSecure();
  loadUpdate().catch(function () { /* no banner */ });
})();
