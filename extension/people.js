/* The People page: invite someone, accept what they send back, see who you are connected to. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var REASONS = {
    "bad-address": "That isn't an email address.", "bad-text": "That text isn't something hyphae can read.",
    "mistyped-code": "That code has a typo. Check it and try again.", "wrong-code": "That code isn't right.",
    "expired": "This invitation has expired. Ask for a new one.", "unknown-invite": "This isn't an invitation you sent.",
    "not-for-you": "This invitation wasn't addressed to this device.", "locked": "Too many wrong tries. Wait, then try again.",
  };
  var copyText = "";
  function call(op, args) {
    return new Promise(function (res) {
      chrome.runtime.sendMessage({ hyphae: "invite", op: op, args: args || {} }, function (r) {
        void chrome.runtime.lastError; res(r || { ok: false, reason: "no-answer" });
      });
    });
  }
  function why(r) { return REASONS[r.reason] || ("hyphae couldn't do that (" + (r.reason || "error") + ")."); }
  function out(t, cls) { var o = $("acc-out"); o.textContent = t; o.className = "out " + (cls || ""); }
  function copyBtn(text) { copyText = text; $("acc-copy").className = text ? "" : "hide"; }

  $("inv-go").addEventListener("click", async function () {
    var r = await call("invite-create", { to: $("inv-to").value.trim(), mode: "code" });
    var box = $("inv-out");
    if (!r.ok) { box.className = ""; $("inv-body").textContent = why(r); $("inv-code").textContent = ""; return; }
    $("inv-body").textContent = r.subject + "\n\n" + r.body;
    $("inv-code").textContent = r.code;
    box.className = "";
  });
  $("inv-copy").addEventListener("click", function () { navigator.clipboard.writeText($("inv-body").textContent); });
  $("acc-copy").addEventListener("click", function () { navigator.clipboard.writeText(copyText); $("acc-copy").textContent = "Copied"; });

  $("acc-go").addEventListener("click", async function () {
    var text = $("acc-text").value.trim();
    copyBtn(""); $("acc-copy").textContent = "Copy reply";
    if (!text) return out("Paste something first.", "warn");
    var c = await call("classify", { text: text });
    var kinds = (c && c.kinds) || [];
    if (kinds.indexOf("inv") !== -1) {
      var code = $("acc-code").value.trim();
      var rd = await call("invite-read", { text: text });
      if (!rd.ok) return out(why(rd), "warn");
      if (!code) {
        $("acc-codewrap").className = "";
        return out("Invitation from " + (rd.invite.from || "someone") + ". Enter the code they gave you by another channel, then press Continue.", "");
      }
      var j = await call("invite-join", { text: text, code: code });
      if (!j.ok) return out(why(j), "warn");
      out("Joined. Send this reply back to them — once they accept it, you are connected:", "ok");
      return copyBtn(j.hello);
    }
    if (kinds.indexOf("hello") !== -1) {
      var h = await call("hello-accept", { text: text });
      if (!h.ok) return out((h.alarm ? "Warning: " : "") + why(h), "warn");
      out("Accepted. Send this welcome back so they are connected too:", "ok");
      refresh();
      return copyBtn(h.welcome);
    }
    if (kinds.indexOf("welcome") !== -1) {
      var w = await call("welcome-accept", { text: text });
      if (!w.ok) return out((w.alarm ? "Warning: " : "") + why(w), "warn");
      out("Connected" + (w.status ? " (" + w.status + ")" : "") + ".", "ok");
      return refresh();
    }
    out("hyphae doesn't recognise that as an invitation, hello or welcome.", "warn");
  });

  async function refresh() {
    var d = await call("directory", {});
    var list = (d && d.people) || [];
    var box = $("who");
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!list.length) { box.textContent = "Nobody yet."; return; }
    list.forEach(function (p) {
      var row = document.createElement("div"); row.className = "who";
      var a = document.createElement("span"); a.textContent = (p.name || (p.emails && p.emails[0]) || "someone");
      var b = document.createElement("span"); b.className = "dim"; b.textContent = p.status || "";
      row.appendChild(a); row.appendChild(b); box.appendChild(row);
    });
  }
  refresh();
})();
