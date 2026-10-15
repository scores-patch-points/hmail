/*
 * hyphae page layer. Injected on demand into the active tab only (activeTab),
 * never on a schedule, and it knows nothing about any particular site: it
 * works on whatever text field has focus and whatever text is on the page.
 *
 * Two things matter about how it shows plaintext:
 *
 *   1. Revealed text lives in a CLOSED shadow root, one per sealed token. The
 *      page's own scripts can read the page's DOM but not into a closed shadow
 *      root, so what the site's JavaScript sees where a message was is an empty
 *      span. (The sealed token stays in the markup the server delivered.)
 *   2. A "lens" flips every revealed item between what YOU see (plaintext) and
 *      what the SITE sees (the ciphertext token), so the difference is visible.
 *
 * Needs HyCrypto (crypto.js) loaded first in the same isolated world.
 */
(function () {
  "use strict";
  if (window.__hyphae) return; // already injected into this page

  // Lavender on the page for what you can read; amber for what the site stores.
  var CSS =
    ":host{all:initial}" +
    ".item{font:inherit;border-radius:3px;padding:0 2px}" +
    ".plain{background:rgba(147,139,178,.18);box-shadow:inset 0 -1px 0 rgba(125,107,184,.6)}" +
    ".site{font:11px/1.35 ui-monospace,Menlo,monospace;background:rgba(201,160,106,.14);" +
    "box-shadow:inset 0 -1px 0 rgba(201,160,106,.6);word-break:break-all;color:#7c5a2a}" +
    // a formatted message: block layout, quiet list/quote/link styling
    ".rich{display:block;padding:2px 6px}" +
    ".rich a{color:#5a46a8}" +
    ".rich ul,.rich ol{margin:4px 0 4px 22px;padding:0}" +
    ".rich blockquote{margin:6px 0;padding-left:10px;border-left:3px solid #c9c2e6;color:#555}";

  var observer = null;
  var revealCircles = null;
  var records = [];   // one per opened token: { host, inner, plain, token }
  var lens = "plain"; // "plain" = what you see · "site" = what the site sees
  var badge = null;   // { host, label }
  var secure = false;     // the one switch: on = encrypted view + secure look
  var userChose = false;  // once the person flips it, automatic changes stop
  var frame = null;       // the page-wide frame + tint
  var fieldSheet = null;  // focus / caret / selection styling for the page

  // ---- focused field --------------------------------------------------------

  /** The element that really has focus, through shadow roots and same-origin frames. */
  function focusedElement() {
    var el = document.activeElement;
    for (var depth = 0; el && depth < 10; depth++) {
      if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        try {
          var inner = el.contentDocument && el.contentDocument.activeElement;
          if (inner && inner !== el.contentDocument.body) { el = inner; continue; }
        } catch (e) { /* cross-origin frame: leave it */ }
      }
      break;
    }
    return el;
  }

  function isTextInput(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    var t = (el.getAttribute("type") || "text").toLowerCase();
    return ["text", "search", "email", "url", "tel", ""].indexOf(t) !== -1;
  }

  function setInputValue(el, value) {
    // React and friends track the value through the prototype setter.
    var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ---- small closed-shadow widgets -----------------------------------------

  function floating(css) {
    var host = document.createElement("div");
    host.setAttribute("data-hyphae-ui", "1");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;" + css;
    var shadow = host.attachShadow({ mode: "closed" });
    var style = document.createElement("style");
    style.textContent =
      ".card{font:300 12px/1.4 'Helvetica Neue','SF Pro Display',system-ui,sans-serif;background:#1b1d28;color:#b1a6d4;" +
      "border:1px solid #313140;border-radius:10px;padding:8px 12px;box-shadow:0 4px 18px rgba(0,0,0,.35);" +
      "max-width:340px;cursor:pointer}" +
      ".k{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#8a8a9c;margin-top:6px}" +
      ".k:first-child{margin-top:0}" +
      ".v{font-family:ui-monospace,Menlo,monospace;font-size:11px;word-break:break-all;white-space:pre-wrap}" +
      ".you{color:#cfc8ec}.them{color:#c9a06a}" +
      ".pill{display:flex;gap:10px;align-items:center}" +
      ".card.pill{padding:7px 9px;max-width:none}" +
      ".dot{width:10px;height:10px;border-radius:50%;flex:0 0 auto;background:#8a8a9c}" +
      ".lbl{font-size:11px;max-width:0;overflow:hidden;opacity:0;white-space:nowrap;" +
      "transition:max-width .18s ease,opacity .18s ease}" +
      ".card:hover .lbl,.card:focus-within .lbl{max-width:340px;opacity:1;margin-left:8px}";
    shadow.appendChild(style);
    (document.body || document.documentElement).appendChild(host);
    return { host: host, shadow: shadow };
  }

  function showBadge() {
    if (badge && badge.host.isConnected) { paintBadge(); return; }
    var w = floating("right:12px;bottom:12px;");
    var card = document.createElement("div");
    card.className = "card pill";
    var dot = document.createElement("span"); dot.className = "dot";
    var label = document.createElement("span"); label.className = "lbl";
    card.appendChild(dot); card.appendChild(label);
    card.title = "hyphae — click to turn encryption on or off";
    card.addEventListener("click", function () { userChose = true; setSecure("toggle"); });
    w.shadow.appendChild(card);
    badge = { host: w.host, dot: dot, label: label };
    paintBadge();
  }
  function paintBadge() {
    if (!badge) return;
    var n = records.filter(function (r) { return r.host.isConnected; }).length;
    var count = n ? " (" + n + ")" : "";
    if (secure && lens === "site") {
      badge.dot.style.background = "#c9a06a";
      badge.label.textContent = "hyphae · peeking at the site's view" + count;
    } else if (secure) {
      badge.dot.style.background = "#c9bff0";
      badge.label.textContent = "hyphae · encryption on" + count;
    } else {
      badge.dot.style.background = "#8a8a9c";
      badge.label.textContent = "hyphae · encryption off" + count;
    }
  }

  // No icon: the badge is the word and its state. The state colours the text.
  function makeMark(label) {
    return { set: function (on, color) { label.style.color = color; label.style.fontWeight = on ? "500" : "300"; } };
  }

  /** Tell the worker, so the toolbar icon follows the page. Best effort. */
  function announce() {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ hyphae: "secure-state", secure: secure }, function () { void chrome.runtime.lastError; });
      }
    } catch (e) { /* the page keeps working without it */ }
  }

  function showInspector(plain, token) {
    var w = floating("left:14px;bottom:14px;");
    var card = document.createElement("div");
    card.className = "card";
    function row(cls, k, v) {
      var kk = document.createElement("div"); kk.className = "k"; kk.textContent = k;
      var vv = document.createElement("div"); vv.className = "v " + cls; vv.textContent = v;
      card.appendChild(kk); card.appendChild(vv);
    }
    row("you", "You typed", plain.length > 280 ? plain.slice(0, 280) + "…" : plain);
    row("them", "The site receives", token.length > 280 ? token.slice(0, 280) + "…" : token);
    card.addEventListener("click", function () { w.host.remove(); });
    w.shadow.appendChild(card);
    setTimeout(function () { if (w.host.isConnected) w.host.remove(); }, 12000);
  }

  // ---- seal -----------------------------------------------------------------

  function inviteCall(op, args) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ hyphae: "invite", op: op, args: args || {} }, function (r) {
          void chrome.runtime.lastError; resolve(r || { ok: false, reason: "no-answer" });
        });
      } catch (e) { resolve({ ok: false, reason: "no-answer" }); }
    });
  }
  /** One sealed token: for the person chosen in the popup, or under your own circle. */
  async function sealText(circle, plain) {
    var to = null;
    try { to = (await chrome.storage.local.get("sealTo")).sealTo || null; } catch (e) { /* just you */ }
    if (!to) return HyCrypto.seal(circle, plain);
    var r = await inviteCall("seal-text", { fp: to, text: plain });
    if (!r.ok) {
      throw new Error(r.reason === "unverified" ? "That person isn't verified yet. Confirm their safety number on the People page." : "Couldn't seal to that person (" + r.reason + ").");
    }
    return r.token;
  }
  /** Tokens your own circles couldn't open may be from a connection: the worker holds those keys. */
  async function openFromConnections(segs) {
    for (var i = 0; i < segs.length; i++) {
      var sg = segs[i];
      if (!sg.token || sg.plain !== null) continue;
      var r = await inviteCall("open", { text: sg.token });
      var it = r.ok && r.items && r.items[0];
      if (it && it.ok && it.authentic && typeof it.body === "string") sg.plain = it.body;
    }
    return segs;
  }

  /** Seal the selection in the focused field, or the whole field. */
  async function sealFocused(circle) {
    var el = focusedElement();
    if (!el) return { ok: false, reason: "Click into the field you want to seal first." };

    if (el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password") {
      return { ok: false, reason: "hyphae never touches password fields." };
    }

    if (isTextInput(el)) {
      var value = el.value;
      var s = el.selectionStart, e = el.selectionEnd;
      var hasSel = typeof s === "number" && typeof e === "number" && s !== e;
      var start = hasSel ? s : 0, end = hasSel ? e : value.length;
      var plain = value.slice(start, end);
      if (!plain.trim()) return { ok: false, reason: "Nothing to seal in that field." };
      el.setAttribute(SEALING_ATTR, "1");
      var token;
      try { token = await sealText(circle, plain); }
      finally { el.removeAttribute(SEALING_ATTR); }
      setInputValue(el, value.slice(0, start) + token + value.slice(end));
      markField(el);
      cancelAutoSeal(el);
      showInspector(plain, token);
      if (!userChose && !secure) setSecure("on");
      return { ok: true, sealed: plain.length };
    }

    if (el.isContentEditable) {
      var doc = el.ownerDocument;
      var sel = doc.getSelection();
      var inside = sel && sel.rangeCount && !sel.isCollapsed && el.contains(sel.anchorNode);
      if (!inside) doc.execCommand("selectAll", false, null);
      var text = doc.getSelection().toString();
      if (!text.trim()) return { ok: false, reason: "Nothing to seal in that field." };
      el.setAttribute(SEALING_ATTR, "1");
      var tok;
      try { tok = await sealText(circle, text); }
      finally { el.removeAttribute(SEALING_ATTR); }
      // insertText keeps the editor's own undo stack and change events intact.
      if (!doc.execCommand("insertText", false, tok)) {
        return { ok: false, reason: "This editor wouldn't accept the sealed text." };
      }
      markField(el);
      cancelAutoSeal(el);
      showInspector(text, tok);
      if (!userChose && !secure) setSecure("on");
      return { ok: true, sealed: text.length };
    }

    return { ok: false, reason: "The focused element isn't a text field." };
  }

  // ---- reveal ---------------------------------------------------------------

  function isInsideEditable(node) {
    for (var n = node.parentNode; n; n = n.parentNode) {
      if (n.nodeType !== 1) continue;
      if (n.hasAttribute && (n.hasAttribute("data-hyphae") || n.hasAttribute("data-hyphae-ui"))) return true;
      if (n.isContentEditable || n.tagName === "TEXTAREA" || n.tagName === "INPUT" ||
          n.tagName === "SCRIPT" || n.tagName === "STYLE") return true;
    }
    return false;
  }

  // ---- rich text ------------------------------------------------------------
  // A formatted message travels sealed as a small structured document, not HTML:
  //   "hyrt1:" + JSON of nodes, where a node is a string or { t, c?, h? }.
  // Only the node types below exist, so there is no HTML to parse and nothing a
  // sender can smuggle in: unknown elements are unwrapped to their text, links
  // must be http(s) or mailto, and the reader rebuilds it with DOM calls.
  var RICH_PREFIX = "hyrt1:";
  var RICH_TAGS = {
    B: "b", STRONG: "b", I: "i", EM: "i", U: "u", S: "s", STRIKE: "s", DEL: "s",
    A: "a", BR: "br", P: "p", DIV: "p", UL: "ul", OL: "ol", LI: "li", BLOCKQUOTE: "q",
  };
  var RICH_EL = { b: "b", i: "i", u: "u", s: "s", a: "a", br: "br", p: "div", ul: "ul", ol: "ol", li: "li", q: "blockquote" };

  function safeHref(h) {
    var v = String(h || "").trim();
    return /^(https?:\/\/|mailto:)/i.test(v) ? v : null;
  }
  function richFromNode(node) {
    var out = [];
    node.childNodes.forEach(function (n) {
      if (n.nodeType === 3) { if (n.nodeValue) out.push(n.nodeValue); return; }
      if (n.nodeType !== 1) return;
      var t = RICH_TAGS[n.tagName];
      if (!t) { out.push.apply(out, richFromNode(n)); return; } // unknown: keep its text
      if (t === "br") { out.push({ t: "br" }); return; }
      var o = { t: t, c: richFromNode(n) };
      if (t === "a") {
        var href = safeHref(n.getAttribute("href"));
        if (!href) { out.push.apply(out, o.c); return; }
        o.h = href;
      }
      out.push(o);
    });
    return out;
  }
  /** An editor element's contents as the string that gets sealed. */
  function richEncode(editorEl) { return RICH_PREFIX + JSON.stringify(richFromNode(editorEl)); }

  function richBuild(nodes, parent, depth) {
    if (depth > 24) return;
    nodes.forEach(function (n) {
      if (typeof n === "string") { parent.appendChild(document.createTextNode(n)); return; }
      if (!n || typeof n !== "object" || !RICH_EL[n.t]) return;
      var el = document.createElement(RICH_EL[n.t]);
      if (n.t === "a") {
        var href = safeHref(n.h);
        if (!href) { richBuild(Array.isArray(n.c) ? n.c : [], parent, depth + 1); return; }
        el.setAttribute("href", href);
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
      if (n.t !== "br" && Array.isArray(n.c)) richBuild(n.c, el, depth + 1);
      parent.appendChild(el);
    });
  }
  /** Draw a formatted payload into `container`. False if it isn't one. */
  function richRender(plain, container) {
    if (typeof plain !== "string" || plain.indexOf(RICH_PREFIX) !== 0) return false;
    var tree;
    try { tree = JSON.parse(plain.slice(RICH_PREFIX.length)); } catch (e) { return false; }
    if (!Array.isArray(tree)) return false;
    while (container.firstChild) container.removeChild(container.firstChild);
    richBuild(tree, container, 0);
    return true;
  }

  /**
   * A message sealed to a pair circle carries a signed envelope: {"e":{body,name,...},"s":sig}.
   * Show its body, and its real subject. Authenticity is not checked here, so no sender
   * is named; the worker's `open` is what verifies.
   */
  function unwrapEnvelope(plain) {
    try {
      var p = JSON.parse(plain);
      if (p && p.e && p.e.v === 1 && typeof p.e.body === "string") {
        return { body: p.e.body, subject: (p.e.kind === "text" && typeof p.e.name === "string") ? p.e.name : "" };
      }
    } catch (e) { /* not an envelope */ }
    return null;
  }

  function paint(rec) {
    if (lens === "plain") {
      var env = unwrapEnvelope(rec.plain);
      var shown = env ? env.body : rec.plain;
      var rich = richRender(shown, rec.inner);
      if (!rich) rec.inner.textContent = shown;
      if (env && env.subject) {
        var hd = document.createElement("div");
        hd.style.cssText = "font-weight:600;margin-bottom:4px;";
        hd.textContent = env.subject;
        rec.inner.insertBefore(hd, rec.inner.firstChild);
      }
      rec.inner.className = "item plain" + (rich || (env && env.subject) ? " rich" : "");
      rec.inner.title = "Sealed with hyphae — this is what you see";
    } else {
      rec.inner.textContent = rec.token;
      rec.inner.className = "item site";
      rec.inner.title = "This is what the site sees";
    }
  }

  function makeHost(plain, token) {
    var host = document.createElement("span");
    host.setAttribute("data-hyphae", "1");
    // Closed: the page's scripts cannot reach into this, we keep the reference.
    var shadow = host.attachShadow({ mode: "closed" });
    var style = document.createElement("style");
    style.textContent = CSS;
    var inner = document.createElement("span");
    shadow.appendChild(style);
    shadow.appendChild(inner);
    var rec = { host: host, inner: inner, plain: plain, token: token };
    paint(rec);
    records.push(rec);
    return host;
  }

  async function revealNode(textNode, circlesByKid, stats) {
    var text = textNode.nodeValue;
    if (!text || text.indexOf("~") === -1 || !HyCrypto.hasToken(text)) return;
    var segs = await openFromConnections(await HyCrypto.revealSegments(text, circlesByKid));
    var opened = segs.filter(function (s) { return s.token && s.plain !== null; }).length;
    stats.locked += segs.filter(function (s) { return s.token && s.plain === null; }).length;
    if (!opened || !textNode.parentNode || textNode.nodeValue !== text) return;
    stats.opened += opened;
    var frag = document.createDocumentFragment();
    segs.forEach(function (s) {
      if (s.token && s.plain !== null) frag.appendChild(makeHost(s.plain, s.token));
      else frag.appendChild(document.createTextNode(s.token || s.text));
    });
    textNode.parentNode.replaceChild(frag, textNode);
  }

  async function revealIn(root, circlesByKid, stats) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [], n;
    while ((n = walker.nextNode())) {
      if (n.nodeValue && n.nodeValue.indexOf("~") !== -1 && !isInsideEditable(n)) nodes.push(n);
    }
    for (var i = 0; i < nodes.length; i++) await revealNode(nodes[i], circlesByKid, stats);
  }

  // A token can be split across sibling blocks — Gmail renders one wrapped line
  // per <div> — so no single text node holds all of it. Find a node where a token
  // starts, join the text nodes that follow it in document order up to the "~",
  // and replace that whole run with the opened text.
  var TOKEN_START = /h\s*y\s*1\s*\./;
  async function revealSpanning(root, circlesByKid, stats) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var all = [], n;
    while ((n = walker.nextNode())) all.push(n);
    for (var i = 0; i < all.length; i++) {
      var first = all[i];
      var v = first.nodeValue;
      if (!v || !first.parentNode || isInsideEditable(first)) continue;
      var m = TOKEN_START.exec(v);
      // only a token that starts here and whose "~" is in a later node
      if (!m || v.indexOf("~", m.index) !== -1) continue;
      var parts = [v.slice(m.index)], nodes = [first], len = parts[0].length, end = -1;
      for (var j = i + 1; j < all.length && j < i + 80 && len < 6000; j++) {
        if (isInsideEditable(all[j])) break;
        var nv = all[j].nodeValue || "";
        nodes.push(all[j]);
        var t = nv.indexOf("~");
        if (t !== -1) { parts.push(nv.slice(0, t + 1)); end = t + 1; break; }
        parts.push(nv);
        len += nv.length;
      }
      if (end === -1) continue;
      var joined = parts.join("");
      if (!HyCrypto.hasToken(joined)) continue;
      var segs = await openFromConnections(await HyCrypto.revealSegments(joined, circlesByKid));
      var seg = segs.filter(function (s) { return s.token; })[0];
      if (!seg) continue;
      if (seg.plain === null) { stats.locked++; continue; }
      var last = nodes[nodes.length - 1];
      if (!first.isConnected || !last.isConnected) continue;
      var range = document.createRange();
      range.setStart(first, m.index);
      range.setEnd(last, end);
      range.deleteContents();
      range.insertNode(makeHost(seg.plain, seg.token));
      stats.opened++;
    }
  }

  /** Reveal now, and keep revealing what the page adds, until it's closed. */
  async function reveal(circlesByKid) {
    revealCircles = circlesByKid;
    markFields(document.body);
    var stats = { opened: 0, locked: 0 };
    await revealIn(document.body, circlesByKid, stats);
    await revealSpanning(document.body, circlesByKid, stats);
    if (!observer) {
      observer = new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          m.addedNodes.forEach(function (node) {
            var s = { opened: 0, locked: 0 };
            if (node.nodeType === 3) {
              if (!isInsideEditable(node)) {
                revealNode(node, revealCircles, s)
                  .then(function () { return node.parentNode ? revealSpanning(node.parentNode, revealCircles, s) : null; })
                  .then(paintBadge);
              }
            } else if (node.nodeType === 1 && !node.hasAttribute("data-hyphae") && !node.hasAttribute("data-hyphae-ui")) {
              revealIn(node, revealCircles, s)
                .then(function () { return revealSpanning(node, revealCircles, s); })
                .then(paintBadge);
            }
          });
          if (m.type === "characterData" && m.target.nodeType === 3 && !isInsideEditable(m.target)) {
            revealNode(m.target, revealCircles, { opened: 0, locked: 0 }).then(paintBadge);
          }
        });
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    if (stats.opened || records.length) {
      // Sealed text opened here, so this page is a protected one: turn the
      // secure look on, unless the person already chose either way.
      if (!userChose && !secure) setSecure("on"); else showBadge();
    }
    return { ok: true, opened: stats.opened, locked: stats.locked, lens: lens, secure: secure };
  }

  // ---- lens -----------------------------------------------------------------

  /** "plain" = what you see, "site" = what the site sees, "toggle" flips. */
  function setLens(mode) {
    lens = mode === "toggle" ? (lens === "plain" ? "site" : "plain") : (mode === "site" ? "site" : "plain");
    records = records.filter(function (r) { return r.host.isConnected; });
    records.forEach(paint);
    paintBadge();
    return { ok: true, lens: lens, count: records.length };
  }

  // ---- secure mode ----------------------------------------------------------
  // One switch. ON: you see the message, new text is sealed, and the whole page
  // carries the hyphae "this is encrypted" look (lavender frame, a top tab, lavender focus rings). OFF: the page exactly as the site
  // delivered it, with none of our styling. The look is deliberately quiet — a
  // thin frame, a barely-there tint, green carets, selections and focus rings —
  // and it never captures a click (pointer-events:none, closed shadow root).

  var FIELD_CSS =
    "html{accent-color:#938bb2}" +
    "::selection{background:rgba(147,139,178,.38)}" +
    "textarea,input[type=text],input[type=email],input[type=search],input:not([type]),[contenteditable=\"true\"],[contenteditable=\"\"]{caret-color:#938bb2}" +
    "textarea:focus,input[type=text]:focus,input[type=email]:focus,input[type=search]:focus,input:not([type]):focus," +
    "[contenteditable=\"true\"]:focus,[contenteditable=\"\"]:focus{" +
    "outline:2px solid rgba(147,139,178,.85)!important;outline-offset:1px!important;box-shadow:0 0 0 4px rgba(147,139,178,.18)!important}";

  function applyFieldStyle(on) {
    try {
      if (on) {
        if (!fieldSheet) { fieldSheet = new CSSStyleSheet(); fieldSheet.replaceSync(FIELD_CSS); }
        if (document.adoptedStyleSheets.indexOf(fieldSheet) === -1) {
          document.adoptedStyleSheets = document.adoptedStyleSheets.concat([fieldSheet]);
        }
      } else if (fieldSheet) {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(function (s) { return s !== fieldSheet; });
      }
    } catch (e) { /* a page that forbids it: the frame and badge still show the state */ }
  }

  function showFrame(on) {
    if (!on) { if (frame) { frame.host.remove(); frame = null; } return; }
    if (frame && frame.host.isConnected) return;
    var host = document.createElement("div");
    host.setAttribute("data-hyphae-ui", "1");
    host.style.cssText = "all:initial;position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483646;pointer-events:none;";
    var shadow = host.attachShadow({ mode: "closed" });
    var style = document.createElement("style");
    style.textContent =
      ".f{position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;background:rgba(147,139,178,.045);" +
      "box-shadow:inset 0 0 0 3px rgba(147,139,178,.7),inset 0 0 90px rgba(120,106,190,.18);animation:in .5s ease-out}" +
      ".t{position:absolute;top:0;left:50%;transform:translateX(-50%);padding:3px 14px 4px;border-radius:0 0 12px 12px;" +
      "background:#1b1d28;color:#c9bff0;border:1px solid #4d4a6e;border-top:0;" +
      "font:300 10px/1.2 'Helvetica Neue',system-ui,sans-serif;letter-spacing:.28em;text-transform:uppercase;white-space:nowrap}" +
      "@keyframes in{from{opacity:0}to{opacity:1}}" +
      "@media (prefers-reduced-motion:reduce){.f{animation:none}}";
    var f = document.createElement("div"); f.className = "f";
    var t = document.createElement("div"); t.className = "t"; t.textContent = "hyphae \u00b7 encrypted";
    shadow.appendChild(style); shadow.appendChild(f); shadow.appendChild(t);
    (document.body || document.documentElement).appendChild(host);
    frame = { host: host };
  }

  /** true / "on", false / "off", "toggle", or "state" (read only). */
  function setSecure(mode) {
    if (mode !== "state") {
      secure = mode === "toggle" ? !secure : (mode === true || mode === "on");
      if (!secure) cancelAllAutoSeal();
      showFrame(secure);
      applyFieldStyle(secure);
      showBadge();
      setLens(secure ? "plain" : "site"); // also repaints the badge
      announce();
    }
    records = records.filter(function (r) { return r.host.isConnected; });
    return { ok: true, secure: secure, lens: lens, count: records.length };
  }

  // ---- every-site mode ------------------------------------------------------

  /** How many text nodes on this page hold something that looks like a sealed token. No keys needed. */
  function detect() {
    var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, null);
    var n, seen = 0, found = 0;
    while ((n = walker.nextNode()) && seen < 20000) {
      seen++;
      var t = n.nodeValue;
      if (!t || isInsideEditable(n)) continue;
      if (t.indexOf("~") !== -1 && HyCrypto.hasToken(t)) found++;
      // a token whose "~" sits in a later node (Gmail: one line per block)
      else if (/h\s*y\s*1\s*\.[A-Za-z0-9_-]{11}\./.test(t)) found++;
    }
    return found;
  }

  /**
   * The first sealed token on this page, shortened for display, or null.
   * This is a real fragment of the ciphertext — what the popup's state line
   * shows. No key is needed to find it.
   */
  function firstToken() {
    var re = /h\s*y\s*1\s*\.[A-Za-z0-9_-]{11}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{20,}~/;
    function pick(s) {
      if (!s) return null;
      var m = re.exec(String(s).replace(/\s+/g, ""));
      return m ? m[0].slice(0, 18) + "…~" : null;
    }
    var root = document.body || document.documentElement;
    var fs = root.querySelectorAll("input,textarea,[contenteditable='true'],[contenteditable='']");
    for (var i = 0; i < fs.length; i++) { var v = pick(fieldValue(fs[i])); if (v) return v; }
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (isInsideEditable(n)) continue;
      var t = pick(n.nodeValue);
      if (t) return t;
    }
    return null;
  }

  /**
   * Run on every page, but ask for keys only if the page actually has sealed
   * text. A page without any never causes the worker to hand out a key.
   * `getCircles` returns a promise of { kid: circle } (or null).
   */
  function autoStart(getCircles) {
    var started = false, fetching = false, timer = null, watcher = null;
    async function check() {
      if (started || fetching || !detect()) return;
      fetching = true;
      try {
        var circles = await getCircles();
        if (circles && Object.keys(circles).length) {
          started = true;
          if (watcher) { watcher.disconnect(); watcher = null; }
          await reveal(circles); // its own observer takes over from here
        }
      } finally { fetching = false; }
    }
    check();
    if (document.body) {
      watcher = new MutationObserver(function () {
        if (started) return;
        clearTimeout(timer);
        timer = setTimeout(check, 400);
      });
      watcher.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  // ---- sealed fields --------------------------------------------------------
  // A field that holds sealed text, or one you are sealing right now, looks
  // plainly different from an ordinary field: a solid lavender ring, a tint and
  // a "sealed" tag on the right, and while a seal is in flight a pulsing ring.
  // This is per-field and independent of the page-wide secure look, so what has
  // been encrypted is unmistakable at a glance, on any site.
  var SEALED_ATTR = "data-hyphae-sealed";
  var SEALING_ATTR = "data-hyphae-sealing";
  var sealedSheet = null;
  var LOCK_URI =
    "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='84'%20height='22'%3E" +
    "%3Crect%20width='84'%20height='22'%20rx='11'%20fill='%236d5cc0'/%3E" +
    "%3Cpath%20d='M14%2010V8a3%203%200%200%201%206%200v2'%20fill='none'%20stroke='%23fff'%20stroke-width='1.5'/%3E" +
    "%3Crect%20x='12'%20y='10'%20width='10'%20height='7'%20rx='1.5'%20fill='%23fff'/%3E" +
    "%3Ctext%20x='28'%20y='15'%20font-family='system-ui,sans-serif'%20font-size='11'%20fill='%23fff'%3Esealed%3C/text%3E%3C/svg%3E";
  var SEALED_CSS =
    "[data-hyphae-sealed]{background-color:rgba(147,139,178,.16)!important;" +
    "box-shadow:inset 0 0 0 2px #6d5cc0,0 0 0 3px rgba(109,92,192,.20)!important;" +
    "caret-color:#5a46a8!important;" +
    "background-image:url(\"" + LOCK_URI + "\")!important;" +
    "background-repeat:no-repeat!important;background-position:right 10px center!important;" +
    "background-size:84px 22px!important}" +
    "[data-hyphae-sealed]:focus{box-shadow:inset 0 0 0 2px #5a46a8,0 0 0 4px rgba(109,92,192,.30)!important}" +
    "[data-hyphae-sealing]{box-shadow:inset 0 0 0 2px #938bb2,0 0 0 4px rgba(147,139,178,.35)!important;" +
    "animation:hyphae-seal .8s ease-in-out infinite}" +
    "@keyframes hyphae-seal{0%,100%{box-shadow:inset 0 0 0 2px #938bb2,0 0 0 4px rgba(147,139,178,.22)}" +
    "50%{box-shadow:inset 0 0 0 2px #6d5cc0,0 0 0 6px rgba(109,92,192,.42)}}" +
    "@media (prefers-reduced-motion:reduce){[data-hyphae-sealing]{animation:none}}";

  function ensureSealedSheet() {
    try {
      if (!sealedSheet) { sealedSheet = new CSSStyleSheet(); sealedSheet.replaceSync(SEALED_CSS); }
      if (document.adoptedStyleSheets.indexOf(sealedSheet) === -1) {
        document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sealedSheet]);
      }
    } catch (e) { /* a page that forbids it: the field keeps its normal look */ }
  }

  function isTextField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute && el.hasAttribute("data-hyphae")) return false; // hyphae's own fields
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") {
      var t = (el.getAttribute("type") || "text").toLowerCase();
      return t !== "password" && ["text", "search", "email", "url", "tel", ""].indexOf(t) !== -1;
    }
    return el.isContentEditable === true;
  }
  function fieldValue(el) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el.value || "";
    return el.innerText || el.textContent || "";
  }
  /** Mark one field as holding sealed text, or clear it. */
  function markField(el) {
    if (!isTextField(el)) return;
    var v = fieldValue(el);
    if (v.indexOf("~") !== -1 && HyCrypto.hasToken(v)) {
      ensureSealedSheet();
      el.setAttribute(SEALED_ATTR, "1");
    } else if (el.hasAttribute && el.hasAttribute(SEALED_ATTR)) {
      el.removeAttribute(SEALED_ATTR);
    }
  }
  /** Mark every text field under `root` (or the page). */
  function markFields(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var els = scope.querySelectorAll("input,textarea,[contenteditable='true'],[contenteditable='']");
    for (var i = 0; i < els.length; i++) markField(els[i]);
  }
  /** Mark now, and keep marking: fields you type into, and fields the page adds. */
  function watchFields() {
    markFields(document.body || document.documentElement);
    ["input", "change", "paste", "blur"].forEach(function (t) {
      document.addEventListener(t, function (e) {
        if (isTextField(e.target)) setTimeout(function () { markField(e.target); }, 0);
      }, true);
    });
    // Auto-seal: pause seals an input/textarea, leaving any field seals it at once.
    document.addEventListener("input", function (e) {
      if (isTextField(e.target)) scheduleAutoSeal(e.target);
    }, true);
    document.addEventListener("blur", function (e) {
      if (!isTextField(e.target)) return;
      cancelAutoSeal(e.target);
      void autoSeal(e.target);
    }, true);
    document.addEventListener("change", function (e) {
      if (isTextField(e.target)) void autoSeal(e.target);
    }, true);
    if (document.body) {
      var fo = new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          m.addedNodes.forEach(function (node) {
            if (node.nodeType === 1) markFields(node);
          });
        });
      });
      fo.observe(document.body, { childList: true, subtree: true });
    }
  }

  // ---- auto-seal on activation ------------------------------------------------
  // When protection is ON, hyphae seals what you type without waiting for Send,
  // so the site never retains plaintext: a pause seals an input/textarea, leaving
  // a field seals it at once, and Seal seals it now. Only sealable text is sealed:
  // a token you cannot open is left alone (never nested) and a field holding only
  // token(s) is left alone. Gmail/Drive are left to their own adapters. This stops
  // the site from auto-saving plaintext. It does not stop a live keystroke listener
  // on the page from seeing keys as you press them — nothing in an extension can;
  // the tripwire reports those, and hyphae's own fields (Gmail) are the airtight path.
  var AUTOSEAL_MS = 1200;
  var autoTimers = new Map();
  var autoCircles = null; // { circles, active } once fetched

  function autoHostSkip() {
    var h = "";
    try { h = location.hostname.toLowerCase(); } catch (e) { return false; }
    return h === "mail.google.com" || h === "drive.google.com" ||
      h === "docs.google.com" || h === "sheets.google.com" || h === "slides.google.com";
  }
  async function autoSealState() {
    if (autoCircles) return autoCircles;
    try {
      var r = await new Promise(function (resolve) {
        if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) return resolve(null);
        chrome.runtime.sendMessage({ hyphae: "get-circles" }, function (x) { void chrome.runtime.lastError; resolve(x || null); });
      });
      if (r && r.circles && Object.keys(r.circles).length) autoCircles = r;
    } catch (e) { /* no circle: auto-seal stays off */ }
    return autoCircles;
  }
  function activeCircleFrom(st) {
    if (!st || !st.circles) return null;
    var ids = Object.keys(st.circles);
    if (!ids.length) return null;
    if (st.active && st.circles[st.active]) return st.circles[st.active];
    return st.circles[ids[0]];
  }
  /** Seal `el` now if it holds sealable plaintext. Never nests, never seals pure tokens. */
  async function autoSeal(el) {
    if (!secure || !isTextField(el) || autoHostSkip()) return;
    var v = fieldValue(el);
    if (!v || !v.trim()) return;
    var st = await autoSealState();
    var circle = activeCircleFrom(st);
    if (!circle) return;
    var plain = null;
    if (v.indexOf("~") !== -1 && HyCrypto.hasToken(v)) {
      var segs;
      try { segs = await HyCrypto.revealSegments(v, st.circles); } catch (e) { return; }
      var locked = false, hasPlain = false, texts = [];
      for (var i = 0; i < segs.length; i++) {
        if (segs[i].token) { if (segs[i].plain === null) { locked = true; break; } texts.push(segs[i].plain); }
        else { if (segs[i].text.trim()) hasPlain = true; texts.push(segs[i].text); }
      }
      if (locked) return;                    // not ours: leave it, never nest
      if (!hasPlain) return;                 // pure token(s): nothing new to protect
      plain = texts.join("");
    } else {
      plain = v;
    }
    var token;
    try { token = await HyCrypto.seal(circle, plain); } catch (e) { return; }
    if (!secure || !isTextField(el)) return;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      setInputValue(el, token);
      try { el.selectionStart = el.selectionEnd = el.value.length; } catch (e2) { /* caret stays */ }
    } else {
      try { el.textContent = token; } catch (e2) { return; }
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    markField(el);
  }
  function scheduleAutoSeal(el) {
    if (!secure || !isTextField(el) || autoHostSkip()) return;
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return; // editors seal on leave, not mid-typing
    cancelAutoSeal(el);
    autoTimers.set(el, setTimeout(function () { autoTimers.delete(el); void autoSeal(el); }, AUTOSEAL_MS));
  }
  function cancelAutoSeal(el) {
    if (autoTimers.has(el)) { clearTimeout(autoTimers.get(el)); autoTimers.delete(el); }
  }
  function cancelAllAutoSeal() {
    autoTimers.forEach(function (t) { clearTimeout(t); });
    autoTimers.clear();
  }

  // Shared with the site adapters (gmail.js): the same encoder the reader decodes.
  var rich = { encode: richEncode, render: richRender, prefix: RICH_PREFIX };

  window.__hyphae = {
    rich: rich,
    sealFocused: sealFocused, reveal: reveal, setLens: setLens, detect: detect, autoStart: autoStart,
    markFields: markFields, peek: firstToken,
    setSecure: function (mode) { if (mode !== "state") userChose = true; return setSecure(mode); },
  };

  watchFields();

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, _sender, send) {
      if (!msg || !msg.hyphae) return;
      if (msg.hyphae === "seal") {
        sealFocused(msg.circle).then(send, function (e) { send({ ok: false, reason: String(e) }); });
        return true;
      }
      if (msg.hyphae === "reveal") {
        reveal(msg.circles).then(send, function (e) { send({ ok: false, reason: String(e) }); });
        return true;
      }
      if (msg.hyphae === "lens") {
        send(setLens(msg.mode || "toggle"));
        return;
      }
      if (msg.hyphae === "secure") {
        if (msg.mode !== "state") userChose = true;
        send(setSecure(msg.mode || "toggle"));
        return;
      }
      if (msg.hyphae === "peek") {
        send({ ok: true, token: firstToken() });
        return;
      }
    });
  }
})();
