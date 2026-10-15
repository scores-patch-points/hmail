/*
 * hyphae Gmail adapter. Runs only on mail.google.com, on top of the page layer
 * (crypto.js + content.js), which it uses for sealing, for opening messages, and
 * for the formatted-message encoder/renderer.
 *
 * It is part of the page — a line inside the compose window's own layout and a
 * line above each opened message — but plainly hyphae's, not Google's: its own
 * wordmark and palette, and a mark that is just the letters h and y overlaid.
 * It stays out of the way: nothing is drawn unless there is something to act
 * on, and the compose line is a quiet grey link until encryption is on.
 *
 * Compose: a hyphae line sits directly above the message body. When
 * "Encrypt this message" is on, a normal-looking Subject line and a formatted
 * body (bold, italic, underline, strikethrough, lists, quotes, links) appear in
 * its place and Gmail's own fields stay empty, so Gmail's draft autosave never
 * holds plaintext. Only at Send is the subject and body sealed to the circle and
 * put into Gmail's fields, and Gmail sends the ciphertext.
 *
 * Reading: messages sealed to a circle you hold get a hyphae line that offers
 * to decrypt them, and then can show what Google actually stores. The header
 * button counts what a page holds.
 *
 * This file never holds, shows or sends a key. It asks storage for circles
 * (or a test hook) and only calls HyCrypto.seal.
 */
(function () {
  "use strict";
  if (location.hostname !== "mail.google.com") return;
  if (window.__hyphaeGmail) return;
  if (!window.HyCrypto || !window.__hyphae) return;

  var H = window.HyCrypto;
  var circles = {};
  var activeKid = null;
  var bypass = false;          // true while we re-fire Send ourselves
  var states = [];             // one per compose window
  var strips = [];             // one per opened message
  var defaultOn = false;       // start every new message encrypted

  // ---- circles --------------------------------------------------------------

  function loadCircles() {
    return new Promise(function (resolve) {
      try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get(["circles", "active", "encryptByDefault"], function (d) {
            circles = (d && d.circles) || {};
            activeKid = (d && d.active) || Object.keys(circles)[0] || null;
            // On unless the person opted out: every new compose opens inside hyphae's
            // fields, so Google never receives the keystrokes in the first place.
            // Interception happens at the field, not at Send.
            defaultOn = !d || d.encryptByDefault !== false;
            resolve();
          });
          return;
        }
      } catch (e) { /* no extension storage here (tests) */ }
      resolve();
    });
  }
  function activeCircle() { return (activeKid && circles[activeKid]) || null; }

  // ---- finding things in Gmail ---------------------------------------------

  var BODY_SEL = 'div[aria-label="Message Body"][contenteditable="true"]';

  function rootOf(body) {
    return body.closest('div[role="dialog"]') || body.closest('div[role="main"]') || body.parentElement;
  }
  function sendButton(root) {
    var cands = root.querySelectorAll('div[role="button"]');
    for (var i = 0; i < cands.length; i++) {
      var l = (cands[i].getAttribute("aria-label") || cands[i].getAttribute("data-tooltip") || "");
      if (/^Send(\b|$)/.test(l) && !/schedule|more send/i.test(l)) return cands[i];
    }
    return null;
  }
  function recipients(root) {
    var out = {};
    root.querySelectorAll("[email]").forEach(function (n) { out[n.getAttribute("email")] = 1; });
    return Object.keys(out);
  }
  function subjectInput(root) {
    return root.querySelector('input[name="subjectbox"]');
  }
  /** Set an input's value the way the page's own framework expects to hear it. */
  function setNative(input, value) {
    var d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (d && d.set) d.set.call(input, value); else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ---- hyphae's mark: the word, no icon --------------------------------------
  // Everywhere hyphae shows itself it is the word "hyphae" in thin, letter-spaced
  // capitals: no monogram, no logo. Strips already carry the word beside their
  // state text, so setMark just clears its holder; the header button (setWord)
  // is the word itself, lavender while something is encrypted, slate otherwise.

  var FONT = "'Helvetica Neue','SF Pro Display',ui-sans-serif,system-ui,sans-serif";

  function setMark(holder) {
    if (holder.getAttribute("data-m") === "-") return;
    holder.setAttribute("data-m", "-");
    while (holder.firstChild) holder.removeChild(holder.firstChild);
  }

  function setWord(holder, active, color, size) {
    var s = size || 11;
    var key = (active ? "1" : "0") + "|" + color + "|" + s;
    if (holder.getAttribute("data-m") === key) return;
    holder.setAttribute("data-m", key);
    while (holder.firstChild) holder.removeChild(holder.firstChild);
    var w = document.createElement("span");
    w.textContent = "hyphae";
    w.style.cssText =
      "font:" + (active ? 500 : 400) + " " + s + "px/1 " + FONT + ";letter-spacing:.2em;text-transform:uppercase;" +
      "color:" + color + ";white-space:nowrap;";
    holder.appendChild(w);
  }

  // ---- the look --------------------------------------------------------------
  // Hyphae Network palette, sampled from the brand image: field 1b1d28, ring
  // 313140, dot 938bb2, title b1a6d4, muted 8a8a9c. Dark where it is a notice on
  // Gmail's white page; while you are writing, the editor is light and ordinary
  // so it feels like writing an email, marked only by a lavender edge and the
  // hyphae line above it.

  var CSS =
    ":host{all:initial;display:block;margin:2px 0}" +
    "*{box-sizing:border-box}" +
    ".wrap{font:300 12px/1.45 " + FONT + ";color:#b1a6d4;border:1px solid #313140;border-left:3px solid #777091;" +
    "border-radius:8px;background:#1b1d28;overflow:hidden}" +
    ".wrap.on{border-color:#3d3a5a;border-left-color:#b1a6d4}" +
    ".wrap.warn{border-left-color:#c9a06a}" +
    ".wrap.quiet{border:0;border-radius:0;background:transparent}" +
    ".strip{display:flex;align-items:center;gap:8px;padding:5px 10px}" +
    ".quiet .strip{padding:1px 0}" +
    ".mark{display:flex;align-items:center}" + ".mark:empty{display:none}" +
    ".word{font:300 10px/1 " + FONT + ";letter-spacing:.32em;text-transform:uppercase;color:#b1a6d4}" +
    ".quiet .word{color:#4d4f66;font-weight:400}" +
    ".state{font-weight:400;font-size:12px;color:#cfc8ec}" +
    ".state:empty{display:none}" +
    ".grow{flex:1}" +
    ".not{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#8a8a9c}" +
    ".quiet .not{display:none}" +
    "button{font:inherit;font-size:11px;font-weight:400;letter-spacing:.05em;border:1px solid #938bb2;" +
    "background:transparent;color:#b1a6d4;border-radius:999px;padding:2px 11px;cursor:pointer}" +
    "button:hover{background:rgba(147,139,178,.16)}" +
    ".quiet button{border-color:transparent;background:transparent;color:#4d4f66;padding:1px 4px;" +
    "text-decoration:underline;text-underline-offset:2px}" +
    ".quiet button:hover{color:#1b1d28;background:transparent}" +

    // while writing: a light, ordinary editor with a lavender edge
    ".wrap.lt{background:#fff;color:#202124;border:1px solid #dadce0;border-left:3px solid #7d6bb8;border-radius:6px}" +
    ".lt .strip{background:#f6f4fc;padding:4px 10px}" +
    ".lt .word{color:#5a46a8}" +
    ".lt .state{color:#3c3763}" +
    ".lt .not{color:#80779f}" +
    ".lt button.off{border:1px solid #c9c2e6;color:#5a46a8;background:#fff}" +
    ".lt button.off:hover{background:#f0ecfb}" +
    ".panel{display:none}" +
    ".lt .panel{display:block}" +
    ".head{font-size:11px;color:#6b6585;background:#faf9fe;border-top:1px solid #ece8f7;padding:4px 12px}" +
    // the subject sits in Gmail's own Subject row, in place of Gmail's box
    ".srow{display:flex;align-items:center;width:100%;min-width:0}" +
    "input.sj{flex:1;min-width:0;border:0;outline:0;background:transparent;padding:0;margin:0;color:inherit;font:inherit}" +
    "input.sj::placeholder{color:#80868b}" +
    ".sjtag{margin-left:8px;font:300 9px/1 " + FONT + ";letter-spacing:.16em;text-transform:uppercase;" +
    "color:#7d6bb8;white-space:nowrap}" +
    ".pref{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:11px;color:#b1a6d4}" +
    ".pref input{accent-color:#938bb2}" +
    ".tb{display:flex;align-items:center;flex-wrap:wrap;gap:2px;padding:4px 8px;border-bottom:1px solid #ece8f7;background:#fff}" +
    ".tb button{border:0;border-radius:4px;background:transparent;color:#444;padding:3px 8px;font:13px/1.2 Arial,sans-serif;" +
    "letter-spacing:0}" +
    ".tb button:hover{background:#efecf8}" +
    ".tb .sep{width:1px;height:16px;background:#dadce0;margin:0 4px}" +
    ".linkbar{display:none;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid #ece8f7;background:#faf9fe}" +
    ".linkbar.open{display:flex}" +
    ".linkbar input{flex:1;border:1px solid #c9c2e6;border-radius:4px;padding:5px 8px;font:13px Arial,sans-serif;outline:0}" +
    ".rte{min-height:150px;max-height:440px;overflow:auto;padding:10px 12px;font:14px/1.5 Arial,Helvetica,sans-serif;" +
    "color:#202124;outline:0;background:#fff}" +
    ".rte a{color:#1a0dab}" +
    ".rte ul,.rte ol{margin:4px 0 4px 22px;padding:0}" +
    ".rte blockquote{margin:6px 0;padding-left:10px;border-left:3px solid #dadce0;color:#555}" +

    // the header button, beside the profile, and its small menu
    // the word on a light lavender chip, so it reads against Gmail's white bar
    ".hbtn{position:relative;height:32px;border-radius:16px;border:1px solid #d9d3ef;background:#efecf8;padding:0 14px;" +
    "display:flex;align-items:center;justify-content:center;cursor:pointer;text-decoration:none}" +
    ".hbtn:hover{background:#e3def4}" +
    ".torow{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:4px;width:100%;padding:4px 0;" +
    "font:14px/1.4 Arial,sans-serif;color:#202124}" +
    ".tolab{color:#5f6368;font-size:13px;margin-right:4px}" + ".chips{display:contents}" +
    ".chip{display:inline-flex;align-items:center;background:#efecf8;color:#3c3763;border:1px solid #d9d3ef;" +
    "border-radius:14px;padding:1px 4px 1px 10px;font:13px/1.5 Arial,sans-serif}" +
    ".chip.no{background:#fbf3e6;border-color:#e6cfa3;color:#6b4e1b}" +
    ".chip .x{border:0;background:transparent;color:inherit;padding:0 5px;font-size:15px;line-height:1;cursor:pointer;text-decoration:none}" +
    "input.toin{flex:1;min-width:140px;border:0;outline:0;background:transparent;font:inherit;color:inherit;padding:2px 0}" +
    "input.toin::placeholder{color:#80868b}" +
    ".sugg{position:absolute;left:0;top:100%;min-width:300px;max-width:100%;background:#fff;border:1px solid #dadce0;" +
    "border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.2);z-index:2147483647;display:none;overflow:hidden}" +
    ".sugg.open{display:block}" +
    ".sg{display:flex;justify-content:space-between;gap:12px;padding:6px 12px;cursor:pointer;font:13px/1.35 Arial,sans-serif}" +
    ".sg.sel,.sg:hover{background:#f3f0fb}" + ".sg .em{color:#5f6368}" +
    ".sg .tag{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#7d6bb8;white-space:nowrap}" +
    ".invbar{display:none;padding:8px 12px;background:#faf9fe;border-top:1px solid #ece8f7;font-size:12px;color:#3c3763}" +
    ".invbar.open{display:block}" + ".invbar .row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px}" +
    ".invbar button{border:1px solid #c9c2e6;color:#5a46a8;background:#fff}" + ".invbar button:hover{background:#f0ecfb}" +
    ".code{font:600 15px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;color:#1b1d28;background:#efecf8;border-radius:6px;padding:4px 8px}" +
    ".fam .strip{flex-wrap:wrap}" + ".fam input{border:1px solid #c9c2e6;border-radius:6px;padding:3px 8px;font:12px ui-monospace,Menlo,monospace;" +
    "letter-spacing:.1em;background:#fff;color:#202124;outline:0;width:150px}" +
    ".pbody{padding:10px 12px;background:#fff;color:#202124;font:14px/1.5 Arial,Helvetica,sans-serif}" +
    ".pbody:empty{display:none}" + ".psub{font-weight:600;margin-bottom:6px}" +
    ".pbody a{color:#1a0dab}" + ".pbody ul,.pbody ol{margin:4px 0 4px 22px;padding:0}" +
    ".tbbtn{height:22px;border:0;border-radius:11px;background:transparent;padding:0 9px;margin:0 2px;cursor:pointer;" +
    "font:400 10px/1 " + FONT + ";letter-spacing:.2em;text-transform:uppercase;color:#e8eaed;display:flex;align-items:center}" +
    ".tbbtn:hover{background:rgba(255,255,255,.18)}" +
    ".tbbtn.on{background:#efecf8;color:#5a46a8;font-weight:500}" + ".tbbtn.on:hover{background:#e3def4}" +
    ".hbadge{position:absolute;top:-4px;right:-4px;min-width:15px;height:15px;border-radius:8px;background:#7d6bb8;" +
    "color:#fff;font:600 9px/15px " + FONT + ";text-align:center;padding:0 3px;letter-spacing:0}" +
    ".hbadge.none{display:none}" +
    ".hbadge.warn{background:#c9a06a}" +
    ".menu{position:fixed;width:300px;display:none;font:300 12px/1.45 " + FONT + ";color:#b1a6d4;background:#1b1d28;" +
    "border:1px solid #313140;border-radius:14px;box-shadow:0 10px 34px rgba(0,0,0,.4);padding:12px 14px;z-index:2147483647}" +
    ".menu.open{display:block}" +
    ".mhead{display:flex;align-items:center;gap:10px}" +
    ".mstate{margin-top:10px;font-size:13px;font-weight:400;color:#cfc8ec}" +
    ".msub{margin-top:3px;font-size:11px;color:#8a8a9c}" +
    ".mbtns{display:flex;gap:6px;margin-top:12px;flex-wrap:wrap}" +
    ".menu button.primary{background:#938bb2;color:#1b1d28}" +
    ".menu button.hide{display:none}";

  function makeShadow(host) {
    var shadow = host.attachShadow({ mode: "closed" });
    var style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);
    return shadow;
  }

  // ---- compose --------------------------------------------------------------

  var TOOLS = [
    { label: "B", title: "Bold (Ctrl/Cmd+B)", cmd: "bold", style: "font-weight:700" },
    { label: "I", title: "Italic (Ctrl/Cmd+I)", cmd: "italic", style: "font-style:italic" },
    { label: "U", title: "Underline (Ctrl/Cmd+U)", cmd: "underline", style: "text-decoration:underline" },
    { label: "S", title: "Strikethrough", cmd: "strikeThrough", style: "text-decoration:line-through" },
    { sep: true },
    { label: "• List", title: "Bulleted list", cmd: "insertUnorderedList" },
    { label: "1. List", title: "Numbered list", cmd: "insertOrderedList" },
    { label: "Quote", title: "Quote", block: "blockquote" },
    { sep: true },
    { label: "Link", title: "Add a link", link: true },
    { label: "Clear", title: "Remove formatting", cmd: "removeFormat" },
  ];

  function build(st) {
    var host = document.createElement("div");
    host.setAttribute("data-hyphae-ui", "1");
    var shadow = makeShadow(host);
    st.shadow = shadow;

    var wrap = document.createElement("div");
    wrap.className = "wrap quiet";
    var strip = document.createElement("div");
    strip.className = "strip";
    var mark = document.createElement("span"); mark.className = "mark";
    var word = document.createElement("span"); word.className = "word"; word.textContent = "hyphae";
    var state = document.createElement("span"); state.className = "state";
    var grow = document.createElement("span"); grow.className = "grow";
    var not = document.createElement("span"); not.className = "not"; not.textContent = "not part of Gmail";
    var btn = document.createElement("button"); btn.type = "button";
    btn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); toggle(st); });
    [mark, word, state, grow, not, btn].forEach(function (n) { strip.appendChild(n); });

    var panel = document.createElement("div");
    panel.className = "panel";
    var head = document.createElement("div"); head.className = "head";

    // Subject: hyphae's field takes the place of Gmail's own Subject box, in the
    // same row (see mountSubject), so the subject is typed where a subject goes.
    // Gmail's real input stays empty and hidden, so autosave never receives it.
    var sjHost = document.createElement("div");
    sjHost.setAttribute("data-hyphae-ui", "1");
    sjHost.style.cssText = "all:initial;display:none;flex:1 1 auto;min-width:0;width:100%;";
    var sjShadow = makeShadow(sjHost);
    var srow = document.createElement("div"); srow.className = "srow";
    var sub = document.createElement("input");
    sub.type = "text";
    sub.className = "sj";
    sub.placeholder = "Subject";
    sub.setAttribute("data-hyphae", "ignore");
    var sjTag = document.createElement("span"); sjTag.className = "sjtag"; sjTag.textContent = "encrypted";
    srow.appendChild(sub); srow.appendChild(sjTag);
    sjShadow.appendChild(srow);

    // Recipients: typed here and suggested from the local directory only. Gmail's
    // own To box asks Google to autocomplete every prefix (measured), so while
    // encryption is on this field stands in for it, and Gmail is given only the
    // final addresses, at send time.
    st.to = []; st.toStatus = {}; st.toActive = false;
    var toHost = document.createElement("div");
    toHost.setAttribute("data-hyphae-ui", "1");
    toHost.style.cssText = "all:initial;display:none;";
    var toShadow = makeShadow(toHost);
    var torow = document.createElement("div"); torow.className = "torow";
    var tolab = document.createElement("span"); tolab.className = "tolab"; tolab.textContent = "To";
    var chipsEl = document.createElement("span"); chipsEl.className = "chips";
    var toIn = document.createElement("input");
    toIn.type = "text"; toIn.className = "toin"; toIn.placeholder = "Recipients";
    toIn.setAttribute("data-hyphae", "ignore"); toIn.setAttribute("autocomplete", "off");
    var sugg = document.createElement("div"); sugg.className = "sugg";
    torow.appendChild(tolab); torow.appendChild(chipsEl); torow.appendChild(toIn); torow.appendChild(sugg);
    toShadow.appendChild(torow);
    var rows = [], sel = -1, searchTimer = null, searchSeq = 0;

    function renderChips() {
      while (chipsEl.firstChild) chipsEl.removeChild(chipsEl.firstChild);
      st.to.forEach(function (addr) {
        var c = document.createElement("span");
        var known = st.toStatus[addr];
        c.className = "chip" + (known === false ? " no" : "");
        c.title = known === false ? "Not connected on hyphae yet" : (known ? "Connected" : "");
        c.appendChild(document.createTextNode(addr));
        var x = document.createElement("button"); x.type = "button"; x.className = "x"; x.textContent = "\u00d7";
        x.addEventListener("click", function (e) {
          e.preventDefault();
          st.to = st.to.filter(function (a) { return a !== addr; });
          renderChips();
        });
        c.appendChild(x);
        chipsEl.appendChild(c);
      });
      st.painted = null;
    }
    function addTo(raw) {
      var a = String(raw || "").trim().replace(/^<|>$/g, "").toLowerCase();
      if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(a)) return false;
      if (st.to.indexOf(a) === -1) {
        st.to.push(a);
        Promise.all([contactLookup(a), inviteCall("who", { addrs: [a] })]).then(function (rs) {
          var c = rs[0] && !rs[0].error && rs[0].contact;
          var w = rs[1] && rs[1].ok && rs[1].who && rs[1].who[a];
          // connected = a shared circle we hold, or a verified pair from an invitation; known only here
          st.toStatus[a] = !!((c && c.status === "ready" && c.circleKid && circles[c.circleKid]) || (w && w.state === "pair-verified"));
          renderChips();
        });
      }
      toIn.value = "";
      closeSugg();
      renderChips();
      return true;
    }
    function closeSugg() { sugg.className = "sugg"; rows = []; sel = -1; while (sugg.firstChild) sugg.removeChild(sugg.firstChild); }
    function markSel() {
      Array.prototype.forEach.call(sugg.children, function (el, i) { el.className = "sg" + (i === sel ? " sel" : ""); });
    }
    function showSugg(list) {
      closeSugg();
      list.slice(0, 6).forEach(function (c) {
        (c.emails || []).slice(0, 2).forEach(function (em) {
          if (rows.length >= 6 || st.to.indexOf(String(em).toLowerCase()) !== -1) return;
          rows.push(em);
          var r = document.createElement("div"); r.className = "sg";
          var left = document.createElement("span");
          left.appendChild(document.createTextNode((c.name || em) + " "));
          var e2 = document.createElement("span"); e2.className = "em"; e2.textContent = c.name ? "\u00b7 " + em : "";
          left.appendChild(e2);
          var tag = document.createElement("span"); tag.className = "tag";
          tag.textContent = c.status === "ready" ? "connected" : "";
          r.appendChild(left); r.appendChild(tag);
          r.addEventListener("mousedown", function (e) { e.preventDefault(); addTo(em); toIn.focus(); });
          sugg.appendChild(r);
        });
      });
      if (rows.length) { sugg.className = "sugg open"; sel = 0; markSel(); }
    }
    toIn.addEventListener("input", function () {
      var v = toIn.value;
      if (/[,;]\s*$/.test(v)) { if (addTo(v.replace(/[,;]\s*$/, ""))) return; }
      clearTimeout(searchTimer);
      var q = v.trim();
      if (!q) { closeSugg(); return; }
      var mine = ++searchSeq;
      searchTimer = setTimeout(function () {
        directorySearch(q).then(function (list) { if (mine === searchSeq) showSugg(list || []); });
      }, 80);
    });
    toIn.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" && rows.length) { e.preventDefault(); sel = (sel + 1) % rows.length; markSel(); return; }
      if (e.key === "ArrowUp" && rows.length) { e.preventDefault(); sel = (sel + rows.length - 1) % rows.length; markSel(); return; }
      if (e.key === "Escape") { closeSugg(); return; }
      if (e.key === "Enter" || e.key === "Tab" || e.key === "," || e.key === ";") {
        var v = toIn.value.trim();
        if (!v && e.key === "Tab") return;   // nothing typed: let Tab walk on
        var picked = (sel >= 0 && rows[sel]) ? rows[sel] : null;
        // a fully typed address wins over whichever suggestion is highlighted
        var cand = (picked && !/@[^\s@]+\.[^\s@]+$/.test(v)) ? picked : v;
        if (cand && addTo(cand)) { e.preventDefault(); return; }
        if (e.key === "Enter") e.preventDefault();
        return;
      }
      if (e.key === "Backspace" && !toIn.value && st.to.length) { st.to.pop(); renderChips(); }
    });
    toIn.addEventListener("blur", function () { setTimeout(function () { if (toIn.value.trim()) addTo(toIn.value); closeSugg(); }, 120); });
    ["mousedown", "mouseup", "click", "dblclick", "keydown", "keypress", "keyup", "input", "beforeinput", "paste", "cut", "copy", "contextmenu"].forEach(function (t) {
      toHost.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    st.toHost = toHost; st.toIn = toIn; st.renderChips = renderChips;
    st.suggestions = function () { return rows.slice(); };
    // Enter or Tab in the subject goes straight to the body, like any email.
    sub.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) { e.preventDefault(); rte.focus(); }
    });
    ["mousedown", "mouseup", "click", "dblclick", "keydown", "keypress", "keyup",
      "input", "beforeinput", "paste", "cut", "copy", "contextmenu"].forEach(function (t) {
      sjHost.addEventListener(t, function (e) { e.stopPropagation(); });
    });

    // Formatting controls: text labels, no icons.
    var tb = document.createElement("div"); tb.className = "tb";
    var linkbar = document.createElement("div"); linkbar.className = "linkbar";
    var linkIn = document.createElement("input");
    linkIn.type = "text"; linkIn.placeholder = "Paste a link (https://…)";
    linkIn.setAttribute("data-hyphae", "ignore");
    var linkOk = document.createElement("button"); linkOk.type = "button"; linkOk.textContent = "Add link";
    var linkNo = document.createElement("button"); linkNo.type = "button"; linkNo.textContent = "Cancel";
    linkbar.appendChild(linkIn); linkbar.appendChild(linkOk); linkbar.appendChild(linkNo);

    // Body: a formatted editor.
    var rte = document.createElement("div");
    rte.className = "rte";
    rte.setAttribute("contenteditable", "true");
    rte.setAttribute("role", "textbox");
    rte.setAttribute("aria-multiline", "true");
    rte.setAttribute("aria-label", "Message body (encrypted)");
    rte.setAttribute("data-hyphae", "ignore");
    // Paste as plain text: formatting comes only from the controls, so a pasted
    // page can't carry anything into the sealed message.
    rte.addEventListener("paste", function (e) {
      e.preventDefault();
      var t = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
      if (t) document.execCommand("insertText", false, t);
    });

    function selection() {
      return (shadow.getSelection ? shadow.getSelection() : window.getSelection());
    }
    function openLink() {
      var s = selection();
      st.savedRange = (s && s.rangeCount && rte.contains(s.getRangeAt(0).commonAncestorContainer))
        ? s.getRangeAt(0).cloneRange() : null;
      linkbar.classList.add("open");
      linkIn.value = "";
      linkIn.focus();
    }
    function closeLink() { linkbar.classList.remove("open"); rte.focus(); }
    function addLink() {
      var v = linkIn.value.trim();
      if (!v) return closeLink();
      if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = (v.indexOf("@") !== -1 && v.indexOf("/") === -1 ? "mailto:" : "https://") + v;
      if (!/^(https?:\/\/|mailto:)/i.test(v)) { linkIn.value = ""; linkIn.placeholder = "Only http, https or mailto links"; return; }
      rte.focus();
      var s = selection();
      if (st.savedRange && s) { s.removeAllRanges(); s.addRange(st.savedRange); }
      if (s && s.rangeCount && !s.getRangeAt(0).collapsed) {
        document.execCommand("createLink", false, v);
      } else if (s && s.rangeCount) {
        var a = document.createElement("a");
        a.setAttribute("href", v);
        a.textContent = v;
        var r = s.getRangeAt(0);
        r.insertNode(a);
        r.setStartAfter(a); r.collapse(true);
        s.removeAllRanges(); s.addRange(r);
      }
      closeLink();
    }
    linkOk.addEventListener("click", function (e) { e.preventDefault(); addLink(); });
    linkNo.addEventListener("click", function (e) { e.preventDefault(); closeLink(); });
    linkIn.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); addLink(); }
      if (e.key === "Escape") { e.preventDefault(); closeLink(); }
    });

    TOOLS.forEach(function (t) {
      if (t.sep) { var sp = document.createElement("span"); sp.className = "sep"; tb.appendChild(sp); return; }
      var b = document.createElement("button");
      b.type = "button"; b.textContent = t.label; b.title = t.title;
      b.tabIndex = -1; // Tab goes subject -> body, not through the toolbar
      if (t.style) b.style.cssText = t.style;
      // Keep the selection in the editor when a control is pressed.
      b.addEventListener("mousedown", function (e) { e.preventDefault(); });
      b.addEventListener("click", function (e) {
        e.preventDefault();
        if (t.link) return openLink();
        rte.focus();
        if (t.block) document.execCommand("formatBlock", false, t.block);
        else document.execCommand(t.cmd, false, null);
      });
      tb.appendChild(b);
    });

    var inviteBar = document.createElement("div");
    inviteBar.className = "invbar";
    st.inviteBar = inviteBar;
    panel.appendChild(head);
    panel.appendChild(inviteBar);
    panel.appendChild(tb);
    panel.appendChild(linkbar);
    panel.appendChild(rte);

    wrap.appendChild(strip); wrap.appendChild(panel);
    shadow.appendChild(wrap);

    // Gmail's own handlers are written for Gmail's fields. Keep our editor's
    // pointer and keyboard events from reaching them, and focus the editor
    // ourselves on a press, since Gmail may cancel the browser's default focus.
    ["mousedown", "mouseup", "click", "dblclick", "keydown", "keypress", "keyup",
      "input", "beforeinput", "paste", "cut", "copy", "contextmenu"].forEach(function (t) {
      host.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    rte.addEventListener("mousedown", function () { if (st.on) setTimeout(function () { rte.focus(); }, 0); });

    // The switch itself lives in the compose title bar, next to Minimize and
    // Close (see mountTitle). It carries only the word; pressing it turns the
    // subject and the body into hyphae's encrypted fields, or back.
    var tbHost = document.createElement("div");
    tbHost.setAttribute("data-hyphae-ui", "1");
    tbHost.style.cssText = "all:initial;display:inline-flex;align-items:center;";
    var tbShadow = makeShadow(tbHost);
    var tbBtn = document.createElement("button");
    tbBtn.type = "button";
    tbBtn.className = "tbbtn";
    tbBtn.textContent = "hyphae";
    tbBtn.title = "Encrypt the subject and message with hyphae";
    tbBtn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); toggle(st); });
    tbShadow.appendChild(tbBtn);
    ["mousedown", "mouseup", "click", "dblclick", "keydown", "keyup", "contextmenu"].forEach(function (t) {
      tbHost.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    st.tbHost = tbHost; st.tbBtn = tbBtn;

    st.host = host; st.wrap = wrap; st.mark = mark; st.state = state; st.btn = btn;
    st.head = head; st.sub = sub; st.rte = rte; st.sjHost = sjHost;
  }

  function mount(st) {
    // Directly above Gmail's message body, inside the compose window's own layout.
    // Only (re)insert when it has actually left that container: moving a DOM node
    // that holds the focused editor would drop the person's keyboard focus, and
    // Gmail adds neighbouring nodes (banners, draft-saved strips) all the time.
    if (st.host.isConnected && st.host.parentNode === st.body.parentNode) return;
    st.body.parentNode.insertBefore(st.host, st.body);
  }

  /**
   * The switch goes in the compose title bar, just before Minimize. The nearest
   * ancestor holding a Minimize button AND only this compose's body is that
   * compose's own title bar; an inline reply has none, and then the strip keeps
   * its own button so there is always a way to turn it on.
   */
  function titleButton(st) {
    for (var p = st.body.parentElement, i = 0; p && i < 40; p = p.parentElement, i++) {
      if (p.querySelectorAll(BODY_SEL).length !== 1) return null;
      var m = p.querySelector('[aria-label="Minimize"]');
      if (m) return m;
    }
    return null;
  }
  function mountTitle(st) {
    var m = titleButton(st);
    if (!m || !m.parentNode) return false;
    if (st.tbHost.isConnected && st.tbHost.nextSibling === m) return true;
    m.parentNode.insertBefore(st.tbHost, m);
    return true;
  }

  /**
   * Gmail's To area: the child of the lowest ancestor that holds both the To
   * input and the Subject input. hyphae's recipient field goes just before it.
   */
  function toInput(root) { return root.querySelector('input[aria-label="To recipients"]'); }
  function toRow(root) {
    var ti = toInput(root), si = subjectInput(root);
    if (!ti || !si) return null;
    var n = ti;
    while (n.parentElement && !n.parentElement.contains(si)) n = n.parentElement;
    return n.parentElement ? n : null;
  }
  function mountTo(st) {
    var row = toRow(st.root);
    if (!row || !row.parentNode) return;
    if (!st.toHost.isConnected || st.toHost.nextSibling !== row) row.parentNode.insertBefore(st.toHost, row);
  }
  /** Who this message is for: hyphae's own field while it stands in, else Gmail's chips. */
  function chosen(st) { return st.toActive ? st.to.slice() : recipients(st.root).map(function (a) { return a.toLowerCase(); }); }

  /**
   * Hand the chosen addresses to Gmail's own To line, at send time only. The
   * addresses go in as typed text and Gmail turns them into chips; the letters
   * that led to them were never typed into Gmail.
   */
  async function putRecipients(st) {
    var row = toRow(st.root), ti = toInput(st.root);
    if (!row || !ti) return false;
    row.style.display = st.toRowDisplay || "";
    var have = recipients(st.root).map(function (a) { return a.toLowerCase(); });
    var need = st.to.filter(function (a) { return have.indexOf(a) === -1; });
    for (var i = 0; i < need.length; i++) {
      ti.focus();
      document.execCommand("insertText", false, need[i] + ",");
      await new Promise(function (r) { setTimeout(r, 160); });
    }
    await new Promise(function (r) { setTimeout(r, 200); });
    var got = recipients(st.root).map(function (a) { return a.toLowerCase(); });
    return st.to.every(function (a) { return got.indexOf(a) !== -1; });
  }

  /**
   * Put hyphae's subject field in Gmail's Subject row, right where Gmail's own
   * box is, so it reads and behaves as the subject field. It takes on the look of
   * Gmail's input (font, colour), and is shown only while encryption is on.
   */
  function mountSubject(st) {
    var gs = subjectInput(st.root);
    if (!gs || !gs.parentNode) return;
    if (!st.sjHost.isConnected || st.sjHost.parentNode !== gs.parentNode) {
      gs.parentNode.insertBefore(st.sjHost, gs);
    }
    if (!st.sjStyled && st.on) {
      try {
        var cs = window.getComputedStyle(gs);
        st.sub.style.font = cs.font;
        st.sub.style.color = cs.color;
      } catch (e) { /* the defaults are fine */ }
      st.sjStyled = true;
    }
  }

  function paint(st, force) {
    // Repaint only when something changed, so a status such as "Not sent: …"
    // stays up, and the strip isn't rebuilt twice a second.
    var c = activeCircle();
    var to = st.on ? chosen(st) : [];
    var inBar = mountTitle(st);
    var key = (st.on ? "1" : "0") + "|" + (c ? c.kid + c.name : "") + "|" + to.join(",") + "|" + (inBar ? "t" : "s");
    if (!force && st.painted === key) return;
    st.painted = key;
    setMark(st.mark);
    st.tbBtn.className = "tbbtn" + (st.on ? " on" : "");
    // With the switch in the title bar, nothing is drawn in the compose until it is on.
    st.host.style.display = (!st.on && inBar) ? "none" : "";
    st.wrap.className = "wrap " + (st.on ? "on lt" : "quiet");
    st.state.textContent = st.on ? "Encrypted" : "";
    st.btn.textContent = st.on ? "Turn off" : "Encrypt this message";
    st.btn.className = st.on ? "off" : "";
    if (st.on) {
      st.head.textContent =
        (to.length ? "Sealed for " + to.join(", ") : "Sealed for the people you pick") +
        " · subject and message are encrypted; the addresses are not";
    }
  }

  /** Put plain text into the editor as paragraphs. */
  function fillEditor(st, text) {
    while (st.rte.firstChild) st.rte.removeChild(st.rte.firstChild);
    String(text || "").split("\n").forEach(function (line) {
      var d = document.createElement("div");
      if (line) d.textContent = line; else d.appendChild(document.createElement("br"));
      st.rte.appendChild(d);
    });
  }

  function toggle(st) {
    var c = activeCircle();
    if (!st.on) {
      // Whatever is already in Gmail's field moves into our editor; Gmail's field is then hidden.
      var existing = st.body.innerText.replace(/​/g, "").trim();
      fillEditor(st, existing);
      // The subject moves into our field and out of Gmail's, which is then hidden.
      var gs = subjectInput(st.root);
      if (gs) {
        st.sub.value = gs.value;
        if (gs.value) setNative(gs, "");
        st.subDisplay = gs.style.display;
        gs.style.display = "none";
        st.on = true;           // so mountSubject copies Gmail's look
        mountSubject(st);
        st.sjHost.style.display = "block";
      }
      // The To line: hyphae's field takes over only while Gmail's has no chips
      // yet; if addresses are already there, Gmail's own row is left as it is.
      var trow = toRow(st.root);
      st.toActive = !!trow && recipients(st.root).length === 0;
      if (st.toActive) {
        st.toRowDisplay = trow.style.display;
        trow.style.display = "none";
        mountTo(st);
        st.toHost.style.display = "block";
        st.renderChips();
      }
      var h = Math.max(150, st.body.offsetHeight);
      if (existing) { st.body.focus(); document.execCommand("selectAll", false, null); document.execCommand("delete", false, null); }
      st.rte.style.minHeight = h + "px";
      st.prevDisplay = st.body.style.display;
      st.body.style.display = "none";
      st.on = true;
      paint(st);
      (st.sub.value || !gs ? st.rte : st.sub).focus();
    } else {
      // Turning it off puts the text back into Gmail, in the clear — the person chose that.
      var text = st.rte.innerText.replace(/​/g, "");
      var gs2 = subjectInput(st.root);
      if (gs2) { gs2.style.display = st.subDisplay || ""; if (st.sub.value) setNative(gs2, st.sub.value); }
      st.sjHost.style.display = "none";
      st.sub.value = "";
      st.body.style.display = st.prevDisplay || "";
      st.on = false;
      if (st.toActive) {
        st.toHost.style.display = "none";
        var carry = st.to.slice();
        putRecipients(st).then(function () { st.toActive = false; st.to = carry; st.toStatus = {}; });
      }
      paint(st);
      if (text.trim()) { st.body.focus(); document.execCommand("insertText", false, text); }
    }
  }

  function track(body) {
    for (var i = 0; i < states.length; i++) if (states[i].body === body) return;
    var st = { body: body, root: rootOf(body), on: false };
    build(st);
    states.push(st);
    mount(st);
    mountSubject(st);
    paint(st, true);
    // Start encrypted when the person asked for that (the header menu's
    // "Encrypt new messages by default", or "Encrypt a new message").
    if ((wantEncrypt || defaultOn) && !suppressAuto) { wantEncrypt = false; toggle(st); }
  }

  // ---- who may receive: connected contacts only -------------------------------
  // An encrypted message goes only to people hyphae already has a circle with.
  // The lookup asks the worker (contacts/core.js) by message; it returns a
  // status, never a key. When the lookup can't answer, nothing is sent.

  var lookupFn = null;   // test hook: addr -> Promise<{contact}|{error}>

  function contactLookup(addr) {
    if (lookupFn) return lookupFn(addr);
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ hyphae: "contacts", op: "byEmail", args: [addr] }, function (r) {
          if (chrome.runtime.lastError || !r || r.ok !== true) return resolve({ error: true });
          resolve({ contact: r.result || null });
        });
      } catch (e) { resolve({ error: true }); }
    });
  }

  var searchFn = null;   // test hook: q -> Promise<[{name, emails, status}]>

  /** Suggestions for the recipient field, from the local directory only. */
  function directorySearch(q) {
    if (searchFn) return searchFn(q);
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ hyphae: "contacts", op: "search", args: [q] }, function (r) {
          if (chrome.runtime.lastError || !r || r.ok !== true || !Array.isArray(r.result)) return resolve([]);
          resolve(r.result);
        });
      } catch (e) { resolve([]); }
    });
  }

  var inviteHook = null;   // test hook: (op, args) -> Promise<result>

  /** Ask the worker's invite bridge. Nothing it returns is a key. */
  function inviteCall(op, args) {
    if (inviteHook) return inviteHook(op, args);
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ hyphae: "invite", op: op, args: args || {} }, function (r) {
          if (chrome.runtime.lastError || !r) return resolve({ ok: false, reason: "unavailable" });
          resolve(r);
        });
      } catch (e) { resolve({ ok: false, reason: "unavailable" }); }
    });
  }

  /**
   * Who can this go to? A person connected by invite (a pair circle that only
   * the two of you hold) is sealed to on their own; people from a shared circle
   * are sealed to that circle. Anyone else is named, and can be invited.
   */
  async function checkRecipients(addrs) {
    if (!addrs.length) return { ok: false, why: "Add who this is for first." };
    var w = await inviteCall("who", { addrs: addrs });
    var pair = [], unver = [], rest = [];
    addrs.forEach(function (a) {
      var st = (w && w.ok && w.who && w.who[a]) ? w.who[a].state : "none";
      if (st === "pair-verified") pair.push(a);
      else if (st === "pair-unverified") unver.push(a);
      else if (st === "ambiguous") unver.push(a);
      else rest.push(a);
    });
    if (unver.length) {
      return { ok: false, unverified: unver,
        why: "Check the safety number with " + unver.join(", ") + " first (or they answered more than once). Nothing was sent." };
    }
    if (pair.length && !rest.length) return { ok: true, mode: "pair", pair: pair };
    if (pair.length && rest.length) {
      return { ok: false, why: "These people are connected in different ways. Send to them separately." };
    }
    var g = await checkCircle(addrs);
    if (g.ok) g.mode = "circle";
    return g;
  }

  async function checkCircle(addrs) {
    var missing = [], kids = {}, unavailable = false;
    for (var i = 0; i < addrs.length; i++) {
      var r = await contactLookup(addrs[i]);
      if (!r || r.error) { unavailable = true; continue; }
      var c = r.contact;
      if (c && c.status === "ready" && c.circleKid && circles[c.circleKid]) kids[c.circleKid] = 1;
      else missing.push(addrs[i]);
    }
    if (unavailable) return { ok: false, why: "hyphae can't check who you're connected to right now, so nothing was sent." };
    if (missing.length) {
      return { ok: false, missing: missing,
        why: "Not connected on hyphae yet: " + missing.join(", ") + ". Invite them first, then send." };
    }
    var ks = Object.keys(kids);
    if (ks.length !== 1) return { ok: false, why: "These people are in different circles. Send to them separately." };
    return { ok: true, circle: circles[ks[0]] };
  }

  // ---- send: seal at the moment of sending ---------------------------------

  // `dry` seals and fills Gmail's fields exactly as a send would, then stops
  // short of pressing Send — used to check the result against the real fields.
  async function sealAndSend(st, send, dry) {
    var c = null;
    var plainBody = st.rte.innerText.replace(/​/g, "");
    if (!plainBody.trim()) { st.state.textContent = "Nothing to send"; st.rte.focus(); return; }
    var gate = await checkRecipients(chosen(st));
    if (!gate.ok) {
      st.state.textContent = "Not sent";
      st.head.textContent = gate.why;
      showInviteBar(st, gate.missing || []);
      return { ok: false, error: gate.why, missing: gate.missing || null };
    }
    hideInviteBar(st);
    c = gate.circle || null;   // circle mode: the circle these recipients share
    if (st.toActive) {
      var put = await putRecipients(st);
      if (!put) {
        st.state.textContent = "Not sent";
        st.head.textContent = "Gmail didn't take the addresses. Nothing was sent.";
        return { ok: false, error: "recipients not accepted" };
      }
      st.toActive = false;
      st.toHost.style.display = "none";
    }
    var subjIn = subjectInput(st.root);
    try {
      // A formatted body is sealed as the structured document the reader rebuilds.
      var rich = window.__hyphae && window.__hyphae.rich;
      var payload = rich ? rich.encode(st.rte) : plainBody;
      var subjText = st.sub.value.trim();
      var token, subjToken = null, body, subjectValue, needle;
      if (gate.mode === "pair") {
        // Sealed to each person's own pair circle, signed inside; the typed subject
        // rides inside the envelope and Gmail's Subject is only a neutral label.
        var sr = await inviteCall("seal", { recipients: gate.pair, text: payload, subject: subjText });
        if (!sr || !sr.ok) throw new Error("couldn't seal: " + ((sr && (sr.reason || "")) || "unavailable"));
        body = sr.body + "\n";
        subjectValue = sr.subject;
        var tk = /hy1\.[A-Za-z0-9_-]{11}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{20}/.exec(sr.body.replace(/\s+/g, ""));
        needle = tk ? tk[0] : sr.body.replace(/\s+/g, "").slice(-40);
      } else {
        token = await H.seal(c, payload);
        subjToken = (subjIn && subjText) ? await H.seal(c, subjText) : null;
        // A bare block of ciphertext reads as junk and Gmail filed it as spam, so
        // wrap the token in a plain sentence a person and a filter can both read.
        // The cover text and subject say nothing about hyphae or encryption: the
        // mail itself must not tell Google the recipient is in a private network.
        body = (H.coverNote ? H.coverNote() : "Hi,\n\nSending this through.") + "\n\n" + token + "\n";
        subjectValue = subjToken ? "Note: " + subjToken : "";
        needle = token.replace(/\s+/g, "").slice(0, 40);
      }
      st.body.style.display = st.prevDisplay || "";
      st.body.focus();
      document.execCommand("selectAll", false, null);
      if (!document.execCommand("insertText", false, body)) throw new Error("Gmail would not take the text");
      var got = st.body.innerText.replace(/\s+/g, "");
      if (got.indexOf(needle.slice(0, 40)) === -1) throw new Error("the body didn't take the encrypted text");
      // The subject: a short plain label plus the sealed token, so the inbox list
      // and the thread header open it in place for someone who holds the circle.
      if (subjIn) {
        subjIn.style.display = st.subDisplay || "";
        setNative(subjIn, subjectValue);
        if (subjectValue && subjIn.value.indexOf(subjectValue.slice(0, 30)) === -1) {
          throw new Error("the subject didn't take the text");
        }
      }
      st.sub.value = "";
      st.sjHost.style.display = "none";
      while (st.rte.firstChild) st.rte.removeChild(st.rte.firstChild);
      st.on = false;
      paint(st);
      if (dry) return { ok: true, subject: subjIn ? subjIn.value : null, rich: !!rich };
      bypass = true;
      ["mousedown", "mouseup", "click"].forEach(function (t) {
        send.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      });
    } catch (e) {
      st.prevDisplay = st.body.style.display;
      st.body.style.display = "none";
      if (subjIn) { subjIn.style.display = "none"; st.sjHost.style.display = "block"; }
      st.state.textContent = "Not sent: " + (e && e.message ? e.message : e);
      return { ok: false, error: String(e && e.message ? e.message : e) };
    } finally {
      setTimeout(function () { bypass = false; }, 600);
    }
  }

  function intercept(e) {
    if (bypass) return;
    var t = e.target;
    if (!t || !t.closest) return;
    for (var i = 0; i < states.length; i++) {
      var st = states[i];
      if (!st.on) continue;
      var send = sendButton(st.root);
      if (send && send.contains(t)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.type === "click") void sealAndSend(st, send);
        return;
      }
    }
  }
  ["mousedown", "mouseup", "click"].forEach(function (t) { document.addEventListener(t, intercept, true); });

  // Ctrl/Cmd+Enter sends in Gmail; treat it the same way.
  document.addEventListener("keydown", function (e) {
    if (bypass || e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    for (var i = 0; i < states.length; i++) {
      var st = states[i];
      // Focus inside our editor shows up as our host element (closed shadow root).
      if (st.on && (st.root.contains(document.activeElement) || document.activeElement === st.host)) {
        var send = sendButton(st.root);
        if (send) { e.preventDefault(); e.stopImmediatePropagation(); void sealAndSend(st, send); return; }
      }
    }
  }, true);

  // ---- reading: a hyphae line above each message that holds a sealed token ---

  // Shown BEFORE anything is decrypted, so a recipient is never left with bare
  // ciphertext and no control. Three states: encrypted + we hold the key (a
  // Decrypt button), encrypted + we don't (says so), decrypted (can show what
  // Google stores).
  var KID_IN_TEXT = /h\s*y\s*1\s*\.\s*([A-Za-z0-9_-]{11})\s*\./;

  function newReceivedStrip(box) {
    var host = document.createElement("div");
    host.setAttribute("data-hyphae-ui", "1");
    var shadow = makeShadow(host);
    var wrap = document.createElement("div");
    wrap.className = "wrap";
    var strip = document.createElement("div");
    strip.className = "strip";
    var mark = document.createElement("span"); mark.className = "mark";
    var word = document.createElement("span"); word.className = "word"; word.textContent = "hyphae";
    var state = document.createElement("span"); state.className = "state";
    var grow = document.createElement("span"); grow.className = "grow";
    var not = document.createElement("span"); not.className = "not"; not.textContent = "not part of Gmail";
    var btn = document.createElement("button"); btn.type = "button";
    [mark, word, state, grow, not, btn].forEach(function (n) { strip.appendChild(n); });
    wrap.appendChild(strip);
    shadow.appendChild(wrap);
    var s = { box: box, host: host, wrap: wrap, mark: mark, state: state, btn: btn, mode: "", peeking: false };
    btn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (s.mode === "decrypt") {
        btn.disabled = true; btn.textContent = "Decrypting…";
        window.__hyphae.reveal(circles).then(function () { s.lastKey = ""; update(s); }, function () { s.lastKey = ""; update(s); });
      } else if (s.mode === "decrypted") {
        var r = window.__hyphae.setLens("toggle");
        s.peeking = r.lens === "site";
        s.lastKey = ""; update(s);
      }
    });
    return s;
  }

  function update(s) {
    var decrypted = !!s.box.querySelector("[data-hyphae]");
    var m = KID_IN_TEXT.exec(s.box.innerText || "");
    var kid = m ? m[1] : null;
    var hasKey = !!(kid && circles[kid]);
    var mode = decrypted ? "decrypted" : (hasKey ? "decrypt" : "nokey");
    var key = mode + "|" + s.peeking;
    if (s.lastKey === key) return;
    s.mode = mode;
    s.lastKey = key;
    s.btn.disabled = false;
    s.btn.style.display = "";
    if (mode === "decrypted") {
      s.wrap.className = "wrap on";
      setMark(s.mark, !s.peeking, "#c9bff0", 20);
      s.state.textContent = s.peeking ? "This is what Google stores" : "Decrypted here";
      s.btn.textContent = s.peeking ? "Show the message" : "Show what Google stores";
    } else if (mode === "decrypt") {
      s.wrap.className = "wrap";
      setMark(s.mark, false, "#8a8a9c", 20);
      s.state.textContent = "This message is encrypted";
      s.btn.textContent = "Decrypt with hyphae";
    } else {
      s.wrap.className = "wrap warn";
      setMark(s.mark, false, "#c9a06a", 20);
      s.state.textContent = "Encrypted for a circle you haven't joined";
      s.btn.style.display = "none";
    }
  }

  // ---- inviting someone who isn't connected yet ----------------------------------

  var suppressAuto = false;
  var famStrips = [];
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** Open a new Gmail compose and fill Gmail's own fields. The person presses Send. */
  async function composeWith(to, subject, bodyText) {
    var before = Array.prototype.slice.call(document.querySelectorAll(BODY_SEL));
    var open = document.querySelector('div[gh="cm"]') || document.querySelector('div[role="button"][aria-label="Compose"]');
    if (!open) return false;
    suppressAuto = true;
    try {
      fire(open);
      var body = null;
      for (var i = 0; i < 30 && !body; i++) {
        await wait(200);
        var now = document.querySelectorAll(BODY_SEL);
        for (var j = 0; j < now.length; j++) if (before.indexOf(now[j]) === -1) { body = now[j]; break; }
      }
      if (!body) return false;
      var root = rootOf(body), ti = toInput(root), si = subjectInput(root);
      if (ti && to) { ti.focus(); document.execCommand("insertText", false, to + ","); await wait(250); }
      if (si) setNative(si, subject || "");
      body.focus();
      document.execCommand("insertText", false, bodyText);
      return true;
    } finally {
      suppressAuto = false;
    }
  }

  function hideInviteBar(st) {
    if (st.pending) return;
    while (st.inviteBar.firstChild) st.inviteBar.removeChild(st.inviteBar.firstChild);
    st.inviteBar.className = "invbar";
  }

  function line(text) { var d = document.createElement("div"); d.textContent = text; return d; }
  function rowOf() { var r = document.createElement("div"); r.className = "row"; return r; }
  function smallBtn(label, fn) {
    var b = document.createElement("button"); b.type = "button"; b.textContent = label;
    b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); fn(b); });
    return b;
  }

  /** Who isn't connected, with one button each; or, once made, the invitation's code. */
  function showInviteBar(st, missing) {
    var bar = st.inviteBar;
    while (bar.firstChild) bar.removeChild(bar.firstChild);
    if (st.pending) { showCode(st); return; }
    if (!missing.length) { bar.className = "invbar"; return; }
    bar.className = "invbar open";
    bar.appendChild(line("Not connected yet: " + missing.join(", ") + ". Invite them; your message stays here until they have joined."));
    var row = rowOf();
    missing.forEach(function (addr) {
      row.appendChild(smallBtn("Invite " + addr, function (b) { b.disabled = true; startInvite(st, addr); }));
    });
    bar.appendChild(row);
    // The person may not want to wait to connect: let them send it as an ordinary
    // Gmail message, in the clear. The label says so; nothing is hidden about it.
    bar.appendChild(line("Send anyway leaves this message unencrypted."));
    var row2 = rowOf();
    row2.appendChild(smallBtn("Send anyway (unencrypted)", function (b) { b.disabled = true; void sendPlain(st); }));
    bar.appendChild(row2);
  }

  /**
   * Send what was typed as an ordinary, unencrypted Gmail message — the escape hatch
   * when the recipients aren't connected yet. The text goes back into Gmail's own
   * fields in the clear and Gmail's Send is pressed. hyphae adds nothing.
   */
  async function sendPlain(st) {
    var send = sendButton(st.root);
    var text = st.rte.innerText.replace(/\u200b/g, "");
    var gs = subjectInput(st.root);
    if (st.toActive) {
      await putRecipients(st);
      st.toActive = false;
      st.toHost.style.display = "none";
    }
    if (gs) { gs.style.display = st.subDisplay || ""; setNative(gs, st.sub.value); }
    st.sub.value = "";
    st.sjHost.style.display = "none";
    st.body.style.display = st.prevDisplay || "";
    st.body.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);
    while (st.rte.firstChild) st.rte.removeChild(st.rte.firstChild);
    st.on = false;
    paint(st);
    if (!send) return;
    bypass = true;
    ["mousedown", "mouseup", "click"].forEach(function (t) {
      send.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
    setTimeout(function () { bypass = false; }, 600);
  }

  async function startInvite(st, addr) {
    var r = await inviteCall("invite-create", { to: addr, mode: "code" });
    if (!r || !r.ok) {
      st.head.textContent = "Couldn't make an invitation (" + ((r && r.reason) || "unavailable") + "). Nothing was sent.";
      showInviteBar(st, [addr]);
      return;
    }
    st.pending = { addr: addr, code: r.code, setup: r.setup };
    showCode(st);
    var okc = await composeWith(addr, r.subject, r.body);
    if (!okc) st.head.textContent = "Couldn't open a new message for the invitation. Open one to " + addr + " and paste the invitation in.";
  }

  function showCode(st) {
    var bar = st.inviteBar, p = st.pending;
    while (bar.firstChild) bar.removeChild(bar.firstChild);
    bar.className = "invbar open";
    bar.appendChild(line("An invitation to " + p.addr + " is drafted in a new message: press Send on it there."));
    bar.appendChild(line("Give them this one-time code by Signal, phone or in person. Not by email, and not in any Google chat:"));
    var row = rowOf();
    var code = document.createElement("span"); code.className = "code"; code.textContent = p.code;
    row.appendChild(code);
    row.appendChild(smallBtn("Copy code", function (b) { copyText(p.code).then(function () { b.textContent = "Copied"; }); }));
    row.appendChild(smallBtn("Copy how to open it", function (b) { copyText(p.setup).then(function () { b.textContent = "Copied"; }); }));
    row.appendChild(smallBtn("Done", function () { st.pending = null; hideInviteBar(st); }));
    bar.appendChild(row);
    bar.appendChild(line("It works once and expires in a day. Your message stays here until they have joined."));
  }
  function copyText(t) {
    try { return navigator.clipboard.writeText(t); } catch (e) { return Promise.reject(e); }
  }

  // Received invitations, answers and confirmations (machine messages in a mail).
  var WHY = {
    "bad-tag": "That code didn't match.", "locked": "Too many wrong codes. Ask for a new invitation.",
    "expired": "This invitation has expired. Ask for a new one.", "used": "This invitation was already used.",
    "dead": "This invitation is no longer valid.", "needs-code": "Enter the one-time code first.",
    "mistyped-code": "That code has a typo. Check it and try again.", "unknown-invite": "This isn't an invitation you sent.",
    "bad-signature": "This answer didn't check out. Nothing was changed.", "unavailable": "hyphae isn't reachable right now.",
    "too-many-unconfirmed": "Too many unconfirmed answers. Try again later.",
  };
  function why(r) {
    var m = WHY[r && r.reason] || ("Couldn't do that (" + ((r && r.reason) || "error") + ").");
    if (r && r.alarm === "code-used-twice") m = "Warning: this code was used twice. Someone else may have it. Don't trust this connection.";
    return m;
  }
  function threadSubject(box) {
    var holder = box.closest("div.adn") || box.parentElement;
    var el = (holder && holder.querySelector(".sj, h2.hP")) || document.querySelector("h2.hP");
    var t = el ? el.textContent.trim() : "";
    return t.replace(/^re:\s*/i, "");
  }
  function senderOf(box) {
    var holder = box.closest("div.adn") || box.closest('div[role="listitem"]') || box.parentElement;
    var el = holder && holder.querySelector(".gD[email], span[email]");
    return el ? String(el.getAttribute("email") || "").toLowerCase() : "";
  }

  function newFamilyStrip(box) {
    var host = document.createElement("div");
    host.setAttribute("data-hyphae-ui", "1");
    var shadow = makeShadow(host);
    var wrap = document.createElement("div"); wrap.className = "wrap fam";
    var strip = document.createElement("div"); strip.className = "strip";
    var word = document.createElement("span"); word.className = "word"; word.textContent = "hyphae";
    var state = document.createElement("span"); state.className = "state";
    var grow = document.createElement("span"); grow.className = "grow";
    var input = document.createElement("input"); input.type = "text"; input.placeholder = "One-time code";
    input.setAttribute("data-hyphae", "ignore"); input.style.display = "none"; input.setAttribute("autocomplete", "off");
    var btn = document.createElement("button"); btn.type = "button";
    [word, state, grow, input, btn].forEach(function (n) { strip.appendChild(n); });
    wrap.appendChild(strip); shadow.appendChild(wrap);
    ["mousedown", "mouseup", "click", "keydown", "keyup", "input", "paste"].forEach(function (t) {
      host.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    var s = { box: box, host: host, state: state, input: input, btn: btn, kind: null, size: -1, busy: false, done: false };
    btn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (s.busy || s.done) return;
      famAct(s);
    });
    return s;
  }

  async function famAct(s) {
    var text = s.box.innerText || "";
    s.busy = true; s.btn.disabled = true;
    try {
      if (s.kind === "inv") {
        var from = senderOf(s.box);
        var r = await inviteCall("invite-join", { text: text, from: from, code: s.input.value.trim() });
        if (!r.ok) { s.state.textContent = why(r); return; }
        var okc = await composeWith(from, "Re: " + threadSubject(s.box), "Hi,\n\nHere's my answer.\n\n" + r.hello + "\n");
        s.state.textContent = okc ? "Reply drafted. Press Send on it, and you'll be connected once they accept." : "Answer ready, but no reply could be opened. Copy it from here.";
        s.done = true; s.btn.style.display = "none"; s.input.style.display = "none";
      } else if (s.kind === "hello") {
        var a = await inviteCall("hello-accept", { text: text });
        if (!a.ok) { s.state.textContent = why(a); return; }
        var okw = await composeWith(a.to, "Re: connected", "Hi,\n\nAll set on my side.\n\n" + a.welcome + "\n");
        s.state.textContent = okw ? "Connected. A confirmation is drafted to " + a.to + ": press Send." : "Connected, but no message could be opened for the confirmation.";
        s.done = true; s.btn.style.display = "none";
      } else if (s.kind === "welcome") {
        var w = await inviteCall("welcome-accept", { text: text, from: senderOf(s.box) });
        if (!w.ok) { s.state.textContent = why(w); return; }
        s.state.textContent = "Connected. You can send each other private messages now.";
        s.done = true; s.btn.style.display = "none";
      }
    } finally {
      s.busy = false; s.btn.disabled = false;
    }
  }

  async function famUpdate(s) {
    var text = s.box.innerText || "";
    if (s.done || text.length === s.size) return;
    s.size = text.length;
    var r = await inviteCall("classify", { text: text });
    var k = (r && r.ok && r.kinds) ? r.kinds : [];
    s.kind = k.indexOf("inv") !== -1 ? "inv" : (k.indexOf("hello") !== -1 ? "hello" : (k.indexOf("welcome") !== -1 ? "welcome" : null));
    if (s.kind === "inv") { s.state.textContent = "An invitation to read private messages. Enter the one-time code they gave you."; s.input.style.display = ""; s.btn.textContent = "Join"; s.btn.style.display = ""; }
    else if (s.kind === "hello") { s.state.textContent = "Someone answered your invitation."; s.input.style.display = "none"; s.btn.textContent = "Accept"; s.btn.style.display = ""; }
    else if (s.kind === "welcome") { s.state.textContent = "They accepted. One more step to finish connecting."; s.input.style.display = "none"; s.btn.textContent = "Finish"; s.btn.style.display = ""; }
    else { s.state.textContent = ""; s.btn.style.display = "none"; s.input.style.display = "none"; }
  }

  // ---- messages sealed to a pair circle ----------------------------------------
  // The worker opens them (it holds the pair keys and checks the signature); this
  // panel shows the real subject and body above the message, which stays below
  // as what Google stores.

  var pairPanels = [], pairBusy = false;
  function pairFor(box) {
    for (var i = 0; i < pairPanels.length; i++) if (pairPanels[i].box === box && pairPanels[i].host.isConnected) return pairPanels[i];
    return null;
  }
  function newPairPanel(box) {
    var host = document.createElement("div");
    host.setAttribute("data-hyphae-ui", "1");
    var shadow = makeShadow(host);
    var wrap = document.createElement("div"); wrap.className = "wrap on lt";
    var strip = document.createElement("div"); strip.className = "strip";
    var word = document.createElement("span"); word.className = "word"; word.textContent = "hyphae";
    var state = document.createElement("span"); state.className = "state";
    strip.appendChild(word); strip.appendChild(state);
    var body = document.createElement("div"); body.className = "pbody";
    wrap.appendChild(strip); wrap.appendChild(body); shadow.appendChild(wrap);
    return { box: box, host: host, state: state, body: body, size: -1, opened: false };
  }
  function paintPair(p, r) {
    while (p.body.firstChild) p.body.removeChild(p.body.firstChild);
    var it = r && r.ok && r.items ? r.items.filter(function (x) { return x.ok && typeof x.body === "string"; })[0] : null;
    if (!it) { p.opened = false; p.state.textContent = "Sealed for a connection you don't have"; return; }
    p.opened = true;
    p.state.textContent = it.authentic
      ? "Opened here \u00b7 signed by someone you connected with"
      : "Opened here \u00b7 sender not verified" + (it.reason ? " (" + it.reason + ")" : "");
    if (it.subject) { var h = document.createElement("div"); h.className = "psub"; h.textContent = it.subject; p.body.appendChild(h); }
    var holder = document.createElement("div");
    var rich = window.__hyphae && window.__hyphae.rich;
    if (!(rich && rich.render(it.body, holder))) holder.textContent = it.body;
    p.body.appendChild(holder);
  }
  async function markPair() {
    if (pairBusy) return;
    pairBusy = true;
    try {
      var boxes = document.querySelectorAll("div.a3s");
      for (var i = 0; i < boxes.length; i++) {
        var box = boxes[i], text = box.innerText || "";
        var m = KID_IN_TEXT.exec(text);
        if (!m || circles[m[1]]) continue;   // shared circles are opened by the reveal layer
        var p = pairFor(box);
        if (p && p.size === text.length) continue;
        if (!p) { p = newPairPanel(box); box.parentNode.insertBefore(p.host, box); pairPanels.push(p); }
        p.size = text.length;
        paintPair(p, await inviteCall("open", { text: text }));
      }
      pairPanels = pairPanels.filter(function (x) { return x.host.isConnected; });
    } finally { pairBusy = false; }
  }

  var FAMILY_IN_TEXT = /h\s*y\s*1\s*(inv|hello|welcome)\s*\./i;
  function markFamily() {
    document.querySelectorAll("div.a3s").forEach(function (box) {
      if (!FAMILY_IN_TEXT.test(box.innerText || "")) return;
      var found = null;
      for (var i = 0; i < famStrips.length; i++) if (famStrips[i].box === box && famStrips[i].host.isConnected) { found = famStrips[i]; break; }
      if (!found) { found = newFamilyStrip(box); box.parentNode.insertBefore(found.host, box); famStrips.push(found); }
      famUpdate(found);
    });
    famStrips = famStrips.filter(function (s) { return s.host.isConnected; });
  }

  function markReceived() {
    // Gmail's message body container carries the class a3s.
    document.querySelectorAll("div.a3s").forEach(function (box) {
      var hasSealed = !!box.querySelector("[data-hyphae]") || KID_IN_TEXT.test(box.innerText || "");
      if (!hasSealed) return;
      var pp = pairFor(box);
      if (pp && pp.opened) {
        // opened as a pair message: the "circle you haven't joined" line no longer applies
        strips.forEach(function (x) { if (x.box === box) x.host.remove(); });
        strips = strips.filter(function (x) { return x.box !== box; });
        return;
      }
      var found = null;
      for (var i = 0; i < strips.length; i++) if (strips[i].box === box && strips[i].host.isConnected) { found = strips[i]; break; }
      if (!found) {
        found = newReceivedStrip(box);
        box.parentNode.insertBefore(found.host, box);
        strips.push(found);
      }
      update(found);
    });
    strips = strips.filter(function (s) { return s.host.isConnected; });
  }

  // ---- the header button ----------------------------------------------------
  // One small button in Gmail's top bar, right before the profile — the spot
  // Gmail's own account tools use. It is the h-y mark, still and grey by default,
  // heavier when something is encrypted, with a count when the page holds
  // encrypted messages, and it opens a small menu with the one thing to do. The
  // hyphae lines inside compose and above each message stay where they are;
  // nothing floats over the page.

  var dock = null;
  var wantEncrypt = false; // "Encrypt a new message" opened a compose: switch it on when it appears

  function fire(el) {
    ["mousedown", "mouseup", "click"].forEach(function (t) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
  }

  /** Where the profile cluster's row is, so the button can sit just before it. */
  function headerSlot() {
    var a = document.querySelector('a[aria-label*="Google Account"]');
    if (!a) return null;
    var child = a, parent = a.parentElement;
    for (var i = 0; i < 8 && parent; i++) {
      if (parent.children.length >= 3) return { parent: parent, before: child };
      child = parent;
      parent = parent.parentElement;
    }
    return null;
  }

  function placeDock(d) {
    var slot = headerSlot();
    if (slot) {
      if (d.host.parentNode !== slot.parent || d.host.nextSibling !== slot.before) {
        slot.parent.insertBefore(d.host, slot.before);
      }
      d.host.style.cssText = "all:initial;display:flex;align-items:center;margin:0 6px;";
      d.inHeader = true;
    } else if (!d.host.isConnected) {
      // Gmail's header not found: sit in the top-right corner rather than not at all.
      d.host.style.cssText = "all:initial;position:fixed;top:10px;right:250px;z-index:2147483646;display:flex;";
      (document.body || document.documentElement).appendChild(d.host);
    }
  }

  function ensureDock() {
    if (dock && dock.host.isConnected) return dock;
    var host = document.createElement("div");
    host.setAttribute("data-hyphae-ui", "1");
    var shadow = makeShadow(host);

    var btn = document.createElement("button"); btn.type = "button"; btn.className = "hbtn"; btn.title = "hyphae";
    var mark = document.createElement("span"); mark.className = "mark";
    var badge = document.createElement("span"); badge.className = "hbadge none";
    btn.appendChild(mark); btn.appendChild(badge);

    var menu = document.createElement("div"); menu.className = "menu";
    var head = document.createElement("div"); head.className = "mhead";
    var word = document.createElement("span"); word.className = "word"; word.textContent = "hyphae";
    var not = document.createElement("span"); not.className = "not"; not.textContent = "not part of Gmail";
    head.appendChild(word); head.appendChild(not);
    var state = document.createElement("div"); state.className = "mstate";
    var sub = document.createElement("div"); sub.className = "msub";
    var btns = document.createElement("div"); btns.className = "mbtns";
    var primary = document.createElement("button"); primary.type = "button"; primary.className = "primary";
    var compose = document.createElement("button"); compose.type = "button"; compose.textContent = "Encrypt a new message";
    btns.appendChild(primary); btns.appendChild(compose);
    // A standing choice, so writing is the usual To / Subject / body / Send.
    var pref = document.createElement("label"); pref.className = "pref";
    var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = defaultOn;
    var lbl = document.createElement("span"); lbl.textContent = "Encrypt new messages by default";
    pref.appendChild(cb); pref.appendChild(lbl);
    cb.addEventListener("change", function () {
      defaultOn = cb.checked;
      try { if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) chrome.storage.local.set({ encryptByDefault: defaultOn }); } catch (e) { /* kept for this page only */ }
    });
    menu.appendChild(head); menu.appendChild(state); menu.appendChild(sub); menu.appendChild(btns); menu.appendChild(pref);

    shadow.appendChild(btn);
    shadow.appendChild(menu);
    dock = { host: host, btn: btn, mark: mark, badge: badge, menu: menu, state: state, sub: sub, primary: primary, act: null, key: "" };
    placeDock(dock);

    function close() { menu.classList.remove("open"); }
    btn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (menu.classList.contains("open")) { close(); return; }
      var r = btn.getBoundingClientRect();
      menu.style.top = Math.round(r.bottom + 8) + "px";
      menu.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + "px";
      menu.classList.add("open");
    });
    // A press anywhere else closes it; a press inside our host is retargeted to the host.
    document.addEventListener("mousedown", function (e) {
      if (dock && e.target !== dock.host) close();
    }, true);
    ["mousedown", "mouseup", "click", "keydown", "keyup", "contextmenu"].forEach(function (t) {
      host.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    primary.addEventListener("click", function () { if (dock.act) dock.act(); });
    compose.addEventListener("click", function () {
      close();
      var existing = states.filter(function (s) { return s.body.isConnected; })[0];
      if (existing) { if (!existing.on) toggle(existing); return; }
      wantEncrypt = true;
      var open = document.querySelector('div[gh="cm"]') || document.querySelector('div[role="button"][aria-label="Compose"]');
      if (open) fire(open);
    });
    return dock;
  }

  function updateDock() {
    var d = ensureDock();
    placeDock(d);
    var modes = strips.map(function (s) { return s.mode; });
    var toDecrypt = modes.filter(function (m) { return m === "decrypt"; }).length;
    var nokey = modes.filter(function (m) { return m === "nokey"; }).length;
    var done = modes.filter(function (m) { return m === "decrypted"; }).length;
    var peeking = strips.some(function (s) { return s.peeking; });
    var composing = states.some(function (s) { return s.on; });
    var c = activeCircle();
    var key = [toDecrypt, nokey, done, peeking, composing, c ? c.kid : ""].join("|");
    if (d.key === key) return;
    d.key = key;

    var active = (done > 0 && !peeking) || composing;
    setWord(d.mark, active, active ? "#5a46a8" : "#4d4f66", 11);
    var count = toDecrypt + nokey;
    d.badge.textContent = String(count);
    d.badge.className = "hbadge" + (count ? (toDecrypt ? "" : " warn") : " none");

    var circleLine = c ? "Circle “" + c.name + "”" : "No circle yet — add one in hyphae";
    d.primary.className = "primary";
    d.act = null;
    if (toDecrypt > 0) {
      d.state.textContent = toDecrypt + " encrypted message" + (toDecrypt === 1 ? "" : "s") + " on this page";
      d.sub.textContent = circleLine;
      d.primary.textContent = "Decrypt with hyphae";
      d.act = function () {
        d.primary.disabled = true; d.primary.textContent = "Decrypting…";
        window.__hyphae.reveal(circles).then(function () { d.primary.disabled = false; d.key = ""; scan(); },
          function () { d.primary.disabled = false; d.key = ""; scan(); });
      };
    } else if (done > 0) {
      d.state.textContent = peeking ? "This is what Google stores" : "Decrypted here";
      d.sub.textContent = peeking
        ? "Only ciphertext. This is all Google, or anyone with the mailbox, can read."
        : "Google only stores the encrypted text. " + circleLine;
      d.primary.textContent = peeking ? "Show the message" : "Show what Google stores";
      d.act = function () {
        var r = window.__hyphae.setLens("toggle");
        strips.forEach(function (s) { s.peeking = r.lens === "site"; s.lastKey = ""; });
        d.key = ""; scan();
      };
    } else if (nokey > 0) {
      d.state.textContent = "Encrypted for a circle you haven't joined";
      d.sub.textContent = "Ask the sender to hand you the key by Signal, in person, or as a file. hyphae never takes a key over email.";
      d.primary.className = "primary hide";
    } else {
      d.state.textContent = "No encrypted messages on this page";
      d.sub.textContent = circleLine;
      d.primary.className = "primary hide";
    }
  }

  // ---- scan and open what arrives ------------------------------------------

  function scan() {
    document.querySelectorAll(BODY_SEL).forEach(track);
    states = states.filter(function (st) {
      if (st.body.isConnected) return true;
      st.host.remove();
      st.sjHost.remove();
      st.tbHost.remove();
      st.toHost.remove();
      return false;
    });
    states.forEach(function (st) { mount(st); mountSubject(st); if (st.toActive) mountTo(st); paint(st); });
    markReceived();
    markFamily();
    void markPair();
    updateDock();
  }

  async function revealReceived() {
    if (!Object.keys(circles).length) return;
    try { await window.__hyphae.reveal(circles); } catch (e) { /* the page keeps working */ }
  }

  window.__hyphaeGmail = {
    /** Test hook: hand the adapter circles directly instead of reading storage. */
    setCircles: function (map, kid) {
      circles = map || {};
      activeKid = kid || Object.keys(circles)[0] || null;
      revealReceived();
      states.forEach(function (s) { paint(s); });
    },
    scan: scan,
    typeTo: function (i, q) {
      var st = states[i || 0]; if (!st || !st.toIn) return null;
      st.toIn.value = q; st.toIn.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    pickTo: function (i, text) {
      var st = states[i || 0]; if (!st || !st.toIn) return null;
      if (text != null) st.toIn.value = text;
      st.toIn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      return st.to.slice();
    },
    suggestions: function (i) { var st = states[i || 0]; return st && st.suggestions ? st.suggestions() : null; },
    inviteClick: function (i, addr) { var st = states[i || 0]; return st ? startInvite(st, addr) : null; },
    ui: function (i) {
      var st = states[i || 0]; if (!st) return null;
      return { head: st.head.textContent, state: st.state.textContent, invite: st.inviteBar.innerText || st.inviteBar.textContent,
        inviteOpen: st.inviteBar.className, to: st.to.slice(), toActive: st.toActive,
        toShown: st.toHost.style.display, titleBar: st.tbHost.isConnected };
    },
    famClick: function (i, code) {
      var f = famStrips[i || 0]; if (!f) return null;
      if (code != null) f.input.value = code;
      return famAct(f);
    },
    pairs: function () {
      return pairPanels.map(function (p) { return { opened: p.opened, state: p.state.textContent, text: p.body.textContent }; });
    },
    fam: function () { return famStrips.map(function (s) { return { kind: s.kind, state: s.state.textContent, btn: s.btn.textContent }; }); },
    setInvite: function (fn) { inviteHook = typeof fn === "function" ? fn : null; },
    setContacts: function (fn, search) {
      lookupFn = typeof fn === "function" ? fn : null;
      searchFn = typeof search === "function" ? search : null;
    },
    /** Test hooks: switch compose #i on/off, fill its fields, seal into Gmail's fields without Send. */
    toggle: function (i) { var st = states[i || 0]; if (st) toggle(st); return st ? st.on : null; },
    fill: function (i, subject, bodyText) {
      var st = states[i || 0];
      if (!st || !st.on) return false;
      st.sub.value = subject || "";
      fillEditor(st, bodyText || "");
      return true;
    },
    format: function (i, cmd) { var st = states[i || 0]; if (!st) return false; st.rte.focus(); return document.execCommand(cmd, false, null); },
    sealOnly: function (i) { var st = states[i || 0]; return st ? sealAndSend(st, null, true) : null; },
    fields: function (i) {
      var st = states[i || 0];
      if (!st) return null;
      var gs = subjectInput(st.root);
      return {
        gmailSubject: gs ? gs.value : null,
        gmailSubjectHidden: gs ? gs.style.display === "none" : null,
        subjectInRow: !!(gs && st.sjHost.parentNode === gs.parentNode && st.sjHost.style.display !== "none"),
        gmailBody: st.body.innerText.replace(/\s+/g, " ").slice(0, 160),
        ourSubject: st.sub.value,
        ourBody: st.rte.innerText,
        ourBodyHtml: st.rte.innerHTML,
      };
    },
    state: function () {
      return {
        composes: states.map(function (s) {
          return { on: s.on, recipients: recipients(s.root), mounted: s.host.isConnected && s.host.parentNode === s.body.parentNode };
        }),
        received: strips.map(function (s) { return s.mode; }),
        headerButton: !!(dock && dock.host.isConnected),
        inHeader: !!(dock && dock.inHeader),
        menuOpen: !!(dock && dock.menu.classList.contains("open")),
      };
    },
  };

  loadCircles().then(function () { scan(); revealReceived(); });
  setInterval(scan, 500);
})();
