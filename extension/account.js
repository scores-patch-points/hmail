/* The sign-in page: the popup shows it when nobody is signed in; the Drive page opens it in a tab. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var acct = HyAccount.create({ fetch: window.fetch.bind(window) });
  var VIEWS = ["signin", "create", "forgot", "newpw", "waiting"];
  var pendingReg = null, pendingReset = null, poll = null;
  if (window.innerWidth > 420 || /[?&]tab=1/.test(location.search)) document.body.classList.add("tab");

  function msg(t, ok) { $("msg").textContent = t || ""; $("msg").className = ok ? "ok" : ""; }
  function show(v) {
    if (poll) { clearInterval(poll); poll = null; }
    VIEWS.forEach(function (n) { $(n).classList.toggle("hide", n !== v); });
    msg("");
    var first = document.querySelector("#" + v + " input");
    if (first) first.focus();
  }
  function busy(form, on) { Array.prototype.forEach.call(form.querySelectorAll("button"), function (b) { b.disabled = on; }); }
  function fail(e, form) { if (form) busy(form, false); msg(e && e.message ? e.message : String(e)); }

  async function signedIn(s) {
    await chrome.storage.local.set({ matrixUser: s.userId, matrixToken: s.accessToken, matrixDevice: s.deviceId });
    // The first sign-in makes the personal circle (the worker does this on the session message).
    try { await chrome.runtime.sendMessage({ hyphae: "session-local", user: s.userId }); } catch (e) { /* ignore */ }
    location.replace(/[?&]tab=1/.test(location.search) ? "popup.html?tab=1" : "popup.html");
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-go]"), function (b) {
    b.addEventListener("click", function () { show(b.getAttribute("data-go")); });
  });

  $("signin").addEventListener("submit", async function (e) {
    e.preventDefault();
    var f = e.currentTarget; busy(f, true); msg("");
    try { await signedIn(await acct.login($("si-id").value, $("si-pw").value, $("si-code").value)); }
    catch (err) {
      if (err.needCode) $("si-codewrap").classList.remove("hide");
      fail(err, f);
    }
  });

  $("create").addEventListener("submit", async function (e) {
    e.preventDefault();
    var f = e.currentTarget; busy(f, true); msg("");
    try {
      var p = await acct.registerStart($("cr-name").value, $("cr-email").value, $("cr-pw").value);
      if (p.done) return signedIn(p.session);
      pendingReg = p; busy(f, false); show("waiting");
      poll = setInterval(async function () {
        try {
          var r = await acct.registerFinish(pendingReg);
          if (r.done) { clearInterval(poll); poll = null; signedIn(r.session); }
        } catch (err) { clearInterval(poll); poll = null; show("create"); fail(err); }
      }, 3000);
    } catch (err) { fail(err, f); }
  });

  $("forgot").addEventListener("submit", async function (e) {
    e.preventDefault();
    var f = e.currentTarget; busy(f, true); msg("");
    try {
      pendingReset = await acct.resetStart($("fg-email").value);
      busy(f, false);
      $("np-sub").textContent = "We emailed a link to " + $("fg-email").value.trim() + ". Follow it, then choose a new password here.";
      show("newpw");
    } catch (err) { fail(err, f); }
  });

  $("newpw").addEventListener("submit", async function (e) {
    e.preventDefault();
    var f = e.currentTarget; busy(f, true); msg("");
    try {
      var r = await acct.resetFinish(pendingReset, $("np-pw").value);
      busy(f, false);
      if (!r.done) return msg("The link hasn't been followed yet. Open the email, follow the link, then press again.");
      show("signin"); msg("Password changed. Sign in with the new one.", true);
    } catch (err) { fail(err, f); }
  });

  // Browser check: Brave identifies itself to pages; anything else is judged by the worker.
  (async function () {
    try {
      var brave = !!(navigator.brave && await navigator.brave.isBrave());
      await chrome.runtime.sendMessage({ hyphae: "browser-brave", brave: brave });
    } catch (e) { /* the worker's own brand check stands */ }
    var b = (await chrome.storage.local.get("browser")).browser;
    if (b && b.ok === false) {
      VIEWS.forEach(function (n) { $(n).classList.add("hide"); });
      $("msg").className = "";
      $("msg").textContent = "hyphae doesn't run in " + b.name + ", because it sends what you do to the company behind it. Use Brave or another privacy browser.";
    }
  })();
  show("signin");
})();
