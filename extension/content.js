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

  var CSS =
    ":host{all:initial}" +
    ".item{font:inherit;border-radius:3px;padding:0 2px}" +
    ".plain{background:rgba(34,139,34,.13);box-shadow:inset 0 -1px 0 rgba(34,139,34,.55)}" +
    ".site{font:11px/1.35 ui-monospace,Menlo,monospace;background:rgba(180,83,9,.13);" +
    "box-shadow:inset 0 -1px 0 rgba(180,83,9,.6);word-break:break-all;color:#7c2d12}";

  var observer = null;
  var revealCircles = null;
  var records = [];   // one per opened token: { host, inner, plain, token }
  var lens = "plain"; // "plain" = what you see · "site" = what the site sees
  var badge = null;   // { host, label }

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
      ".card{font:12px/1.4 system-ui,sans-serif;background:#1c1917;color:#f5f5f4;border-radius:8px;" +
      "padding:8px 10px;box-shadow:0 4px 18px rgba(0,0,0,.35);max-width:340px;cursor:pointer}" +
      ".k{font-size:10px;letter-spacing:.06em;text-transform:uppercase;opacity:.65;margin-top:6px}" +
      ".k:first-child{margin-top:0}" +
      ".v{font-family:ui-monospace,Menlo,monospace;font-size:11px;word-break:break-all;white-space:pre-wrap}" +
      ".you{color:#86efac}.them{color:#fdba74}" +
      ".pill{display:flex;gap:8px;align-items:center}" +
      ".dot{width:8px;height:8px;border-radius:50%}";
    shadow.appendChild(style);
    (document.body || document.documentElement).appendChild(host);
    return { host: host, shadow: shadow };
  }

  function showBadge() {
    if (badge && badge.host.isConnected) { paintBadge(); return; }
    var w = floating("right:14px;bottom:14px;");
    var card = document.createElement("div");
    card.className = "card pill";
    var dot = document.createElement("span"); dot.className = "dot";
    var label = document.createElement("span");
    card.appendChild(dot); card.appendChild(label);
    card.title = "Click to switch what you're looking at";
    card.addEventListener("click", function () { setLens(lens === "plain" ? "site" : "plain"); });
    w.shadow.appendChild(card);
    badge = { host: w.host, dot: dot, label: label };
    paintBadge();
  }
  function paintBadge() {
    if (!badge) return;
    var n = records.filter(function (r) { return r.host.isConnected; }).length;
    if (lens === "plain") {
      badge.dot.style.background = "#4ade80";
      badge.label.textContent = "hyphae · you see the message (" + n + ")";
    } else {
      badge.dot.style.background = "#fb923c";
      badge.label.textContent = "hyphae · the site sees ciphertext (" + n + ")";
    }
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

  function paint(rec) {
    if (lens === "plain") {
      rec.inner.textContent = rec.plain;
      rec.inner.className = "item plain";
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

  /** Reveal now, and keep revealing what the page adds, until it's closed. */
  async function reveal(circlesByKid) {
    revealCircles = circlesByKid;
    var stats = { opened: 0, locked: 0 };
    await revealIn(document.body, circlesByKid, stats);
    if (!observer) {
      observer = new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          m.addedNodes.forEach(function (node) {
            var s = { opened: 0, locked: 0 };
            if (node.nodeType === 3) {
              if (!isInsideEditable(node)) revealNode(node, revealCircles, s).then(paintBadge);
            } else if (node.nodeType === 1 && !node.hasAttribute("data-hyphae") && !node.hasAttribute("data-hyphae-ui")) {
              revealIn(node, revealCircles, s).then(paintBadge);
            }
          });
          if (m.type === "characterData" && m.target.nodeType === 3 && !isInsideEditable(m.target)) {
            revealNode(m.target, revealCircles, { opened: 0, locked: 0 }).then(paintBadge);
          }
        });
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    if (stats.opened || records.length) showBadge();
    return { ok: true, opened: stats.opened, locked: stats.locked, lens: lens };
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

  // ---- every-site mode ------------------------------------------------------

  /** How many text nodes on this page hold something that looks like a sealed token. No keys needed. */
  function detect() {
    var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, null);
    var n, seen = 0, found = 0;
    while ((n = walker.nextNode()) && seen < 20000) {
      seen++;
      var t = n.nodeValue;
      if (t && t.indexOf("~") !== -1 && !isInsideEditable(n) && HyCrypto.hasToken(t)) found++;
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

  window.__hyphae = { sealFocused: sealFocused, reveal: reveal, setLens: setLens, detect: detect, autoStart: autoStart };

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
    });
  }
})();
