/*
 * Hyphae page layer. Injected on demand into the active tab only (activeTab),
 * never on a schedule, and it knows nothing about any particular site: it
 * works on whatever text field has focus and whatever text is on the page.
 *
 * Needs HyCrypto (crypto.js) loaded first in the same isolated world.
 */
(function () {
  "use strict";
  if (window.__hyphae) return; // already injected into this page

  var observer = null;
  var revealCircles = null;

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

  /** Seal the selection in the focused field, or the whole field. */
  async function sealFocused(circle) {
    var el = focusedElement();
    if (!el) return { ok: false, reason: "Click into the field you want to seal first." };

    if (el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password") {
      return { ok: false, reason: "Hyphae never touches password fields." };
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
      return { ok: true, sealed: text.length };
    }

    return { ok: false, reason: "The focused element isn't a text field." };
  }

  function isInsideEditable(node) {
    for (var n = node.parentNode; n; n = n.parentNode) {
      if (n.nodeType !== 1) continue;
      if (n.isContentEditable || n.tagName === "TEXTAREA" || n.tagName === "INPUT" ||
          n.tagName === "SCRIPT" || n.tagName === "STYLE") return true;
    }
    return false;
  }

  async function revealNode(textNode, circlesByKid, stats) {
    var text = textNode.nodeValue;
    if (!text || text.indexOf("hy1.") === -1 || !HyCrypto.hasToken(text)) return;
    var r = await HyCrypto.revealText(text, circlesByKid);
    stats.opened += r.opened; stats.locked += r.locked;
    if (r.opened && textNode.nodeValue === text) {
      textNode.nodeValue = r.text;
      if (textNode.parentElement) textNode.parentElement.setAttribute("data-hyphae", "revealed");
    }
  }

  async function revealIn(root, circlesByKid, stats) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [], n;
    while ((n = walker.nextNode())) {
      if (n.nodeValue && n.nodeValue.indexOf("hy1.") !== -1 && !isInsideEditable(n)) nodes.push(n);
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
              if (!isInsideEditable(node)) revealNode(node, revealCircles, s);
            } else if (node.nodeType === 1) {
              revealIn(node, revealCircles, s);
            }
          });
          if (m.type === "characterData" && m.target.nodeType === 3 && !isInsideEditable(m.target)) {
            revealNode(m.target, revealCircles, { opened: 0, locked: 0 });
          }
        });
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    return { ok: true, opened: stats.opened, locked: stats.locked };
  }

  window.__hyphae = { sealFocused: sealFocused, reveal: reveal };

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
    });
  }
})();
