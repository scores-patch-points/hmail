/*
 * hyphae tripwire, page half. Runs in the page's own JavaScript world at document_start,
 * before the site's scripts, and only OBSERVES: it reports what leaves the page and who
 * listens to keys, and passes every call through unchanged. It holds no key and no
 * plaintext; it hands what it saw to tripwire.js (the isolated half), which knows what
 * you wrote and does the comparing. A page can forge these reports, which can only cause
 * a false warning, never hide a real one that was observed.
 *
 * What it cannot see: other browser extensions, the browser itself, the OS, scripts in
 * cross-origin iframes, and anything a site did before this script ran.
 */
(function () {
  "use strict";
  if (window.__hyphaeWatch) return;
  Object.defineProperty(window, "__hyphaeWatch", { value: true });
  var EV = "hyphae-watch";
  var pageHost = location.hostname;

  function emit(d) { try { window.dispatchEvent(new CustomEvent(EV, { detail: d })); } catch (e) { /* ignore */ } }

  /** Host of the script that made this call: the first stack frame that is not this file. */
  function who() {
    try {
      var lines = String(new Error().stack || "").split("\n");
      for (var i = 2; i < lines.length; i++) {
        var m = /(https?:\/\/[^\s)]+)/.exec(lines[i]);
        if (m) { try { return new URL(m[1]).hostname; } catch (e) { /* next */ } }
      }
    } catch (e) { /* ignore */ }
    return pageHost;
  }
  function host(u) { try { return new URL(String(u), location.href).hostname; } catch (e) { return ""; } }
  function text(b) {
    try {
      if (b == null) return "";
      if (typeof b === "string") return b.slice(0, 8192);
      if (b instanceof URLSearchParams) return b.toString().slice(0, 8192);
      if (b instanceof FormData) { var o = []; b.forEach(function (v, k) { if (typeof v === "string") o.push(k + "=" + v); }); return o.join("&").slice(0, 8192); }
      if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new TextDecoder().decode(b).slice(0, 8192);
    } catch (e) { /* ignore */ }
    return "";
  }
  function out(kind, url, body) {
    emit({ t: "out", kind: kind, to: host(url), by: who(), url: String(url || "").slice(0, 400), body: text(body) });
  }

  // ---- what leaves the page ------------------------------------------------------------
  var _fetch = window.fetch;
  if (_fetch) window.fetch = function (input, init) {
    try { out("fetch", input && input.url ? input.url : input, (init && init.body) || ""); } catch (e) { /* pass */ }
    return _fetch.apply(this, arguments);
  };
  var _open = XMLHttpRequest.prototype.open, _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__hyU = u; return _open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    try { out("xhr", this.__hyU, b); } catch (e) { /* pass */ }
    return _send.apply(this, arguments);
  };
  var _beacon = navigator.sendBeacon;
  if (_beacon) navigator.sendBeacon = function (u, d) {
    try { out("beacon", u, d); } catch (e) { /* pass */ }
    return _beacon.apply(this, arguments);
  };
  var _ws = window.WebSocket && WebSocket.prototype.send;
  if (_ws) {
    var _wsOpen = window.WebSocket;
    WebSocket.prototype.send = function (d) {
      try { out("websocket", this.url, d); } catch (e) { /* pass */ }
      return _ws.apply(this, arguments);
    };
    void _wsOpen;
  }

  // ---- who listens to what you type ----------------------------------------------------
  var KEYS = { keydown: 1, keyup: 1, keypress: 1, input: 1, beforeinput: 1, paste: 1, copy: 1, cut: 1, change: 1, compositionend: 1 };
  var seen = {};
  var _add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    try {
      if (KEYS[type]) {
        var t = this, scope = (t === window || t === document || t === document.documentElement || t === document.body) ? "page" : "field";
        var by = who(), k = type + "|" + scope + "|" + by;
        if (!seen[k]) { seen[k] = 1; emit({ t: "listen", type: type, scope: scope, by: by }); }
      }
    } catch (e) { /* pass */ }
    return _add.apply(this, arguments);
  };

  // ---- known recorders -----------------------------------------------------------------
  function sweepScripts() {
    var s = document.getElementsByTagName("script"), hosts = {};
    for (var i = 0; i < s.length; i++) { if (s[i].src) hosts[host(s[i].src)] = 1; }
    try { performance.getEntriesByType("resource").forEach(function (e) { hosts[host(e.name)] = 1; }); } catch (e) { /* ignore */ }
    emit({ t: "hosts", hosts: Object.keys(hosts).filter(Boolean).slice(0, 200) });
  }
  window.addEventListener("load", function () { setTimeout(sweepScripts, 800); setInterval(sweepScripts, 15000); });
})();
