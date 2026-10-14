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
      ".pill{display:flex;gap:10px;align-items:center}";
    shadow.appendChild(style);
    (document.body || document.documentElement).appendChild(host);
    return { host: host, shadow: shadow };
  }

  function showBadge() {
    if (badge && badge.host.isConnected) { paintBadge(); return; }
    var w = floating("right:14px;bottom:14px;");
    var card = document.createElement("div");
    card.className = "card pill";
    var label = document.createElement("span");
    var mark = makeMark(label);
    card.appendChild(label);
    card.title = "Click to turn hyphae encryption on or off";
    card.addEventListener("click", function () { userChose = true; setSecure("toggle"); });
    w.shadow.appendChild(card);
    badge = { host: w.host, mark: mark, label: label };
    paintBadge();
  }
  function paintBadge() {
    if (!badge) return;
    var n = records.filter(function (r) { return r.host.isConnected; }).length;
    var count = n ? " (" + n + ")" : "";
    if (secure && lens === "site") {
      badge.mark.set(true, "#c9a06a");
      badge.label.textContent = "hyphae · encryption on · peeking at the site's view" + count;
    } else if (secure) {
      badge.mark.set(true, "#c9bff0");
      badge.label.textContent = "hyphae · encryption on · you see the message" + count;
    } else {
      badge.mark.set(false, "#8a8a9c");
      badge.label.textContent = "hyphae · encryption off · the site's view" + count;
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
      var token = await HyCrypto.seal(circle, plain);
      setInputValue(el, value.slice(0, start) + token + value.slice(end));
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
      var tok = await HyCrypto.seal(circle, text);
      // insertText keeps the editor's own undo stack and change events intact.
      if (!doc.execCommand("insertText", false, tok)) {
        return { ok: false, reason: "This editor wouldn't accept the sealed text." };
      }
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
    var segs = await HyCrypto.revealSegments(text, circlesByKid);
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
      var segs = await HyCrypto.revealSegments(joined, circlesByKid);
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

  // Shared with the site adapters (gmail.js): the same encoder the reader decodes.
  var rich = { encode: richEncode, render: richRender, prefix: RICH_PREFIX };

  window.__hyphae = {
    rich: rich,
    sealFocused: sealFocused, reveal: reveal, setLens: setLens, detect: detect, autoStart: autoStart,
    setSecure: function (mode) { if (mode !== "state") userChose = true; return setSecure(mode); },
  };

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
    });
  }
})();
