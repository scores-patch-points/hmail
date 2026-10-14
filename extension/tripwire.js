/*
 * hyphae tripwire, extension half. It keeps what watch.js reports for a few minutes and
 * checks it against what hyphae is about to seal (crypto.js tells it). It never stores
 * plaintext beyond two minutes, never sends anything anywhere, and shows its findings
 * on the page and through window.__hyphaeTrip.state().
 *
 * Three findings:
 *   leak      your plaintext was in a request this page made (to which host, by which script)
 *   listener  a script from another host listens to key / input / paste events
 *   recorder  a known session-replay or keystroke-analytics service is loaded
 */
(function () {
  "use strict";
  if (window.__hyphaeTrip) return;
  var TTL = 2 * 60 * 1000, RING = 150;
  var pageHost = location.hostname.toLowerCase();
  var plains = [];          // { s, t }
  var ring = [];            // { body, to, by, t }
  var findings = [];        // { kind, ... }
  var hosts = {};
  var RECORDERS = /(^|\.)(fullstory\.com|hotjar\.com|hotjar\.io|clarity\.ms|logrocket\.(com|io)|lr-ingest\.io|mouseflow\.com|smartlook\.com|inspectlet\.com|luckyorange\.(com|net)|crazyegg\.com|heapanalytics\.com|quantummetric\.com|contentsquare\.(com|net)|sessioncam\.com|fullstory\.com|glassbox\.com|decibelinsight\.net|pendo\.io|appdynamics\.com|datadoghq-browser-agent\.com|sentry-cdn\.com)$/i;

  function etld(h) { var p = String(h || "").toLowerCase().split("."); return p.slice(-2).join("."); }
  function first(h) { return etld(h) === etld(pageHost); }
  function variants(s) {
    var v = [s];
    try { v.push(encodeURIComponent(s)); } catch (e) { /* ignore */ }
    try { v.push(JSON.stringify(s).slice(1, -1)); } catch (e) { /* ignore */ }
    return v;
  }
  function add(f) {
    var key = f.kind + "|" + (f.to || "") + "|" + (f.by || "") + "|" + (f.type || "") + "|" + (f.host || "");
    for (var i = 0; i < findings.length; i++) if (findings[i].key === key) return;
    f.key = key; f.t = Date.now(); findings.push(f);
    show();
  }
  function prune() {
    var now = Date.now();
    plains = plains.filter(function (p) { return now - p.t < TTL; });
    ring = ring.filter(function (r) { return now - r.t < TTL * 2; });
  }
  function scan(body, to, by) {
    if (!body) return;
    for (var i = 0; i < plains.length; i++) {
      var vs = variants(plains[i].s);
      for (var j = 0; j < vs.length; j++) {
        if (vs[j].length >= 6 && body.indexOf(vs[j]) !== -1) { add({ kind: "leak", to: to, by: by }); return; }
      }
    }
  }

  window.addEventListener("hyphae-watch", function (e) {
    var d = e.detail; if (!d || typeof d !== "object") return;
    if (d.t === "out") {
      prune();
      ring.push({ body: String(d.body || ""), to: String(d.to || ""), by: String(d.by || ""), t: Date.now() });
      if (ring.length > RING) ring.shift();
      scan(String(d.body || "") + " " + String(d.url || ""), String(d.to || ""), String(d.by || ""));
    } else if (d.t === "listen") {
      if (d.by && !first(d.by) && d.scope === "page") add({ kind: "listener", type: String(d.type), by: String(d.by) });
    } else if (d.t === "hosts" && Array.isArray(d.hosts)) {
      d.hosts.forEach(function (h) {
        h = String(h); if (hosts[h]) return; hosts[h] = 1;
        if (RECORDERS.test(h)) add({ kind: "recorder", host: h });
      });
    }
  });

  /** crypto.js calls this with each text it is about to seal. */
  function note(plain) {
    plain = String(plain || "");
    if (plain.length < 6) return;
    prune();
    plains.push({ s: plain.slice(0, 2000), t: Date.now() });
    // what already left the page before we knew the text
    for (var i = 0; i < ring.length; i++) scan(ring[i].body, ring[i].to, ring[i].by);
  }

  // ---- the warning --------------------------------------------------------------------
  var ui = null;
  function line(f) {
    if (f.kind === "leak") return "Your text was sent to " + (f.to || "a server") + (f.by && f.by !== f.to ? " by a script from " + f.by : "") + " before it was sealed.";
    if (f.kind === "listener") return "A script from " + f.by + " is listening to your " + f.type + " events.";
    return f.host + " records what people do on pages.";
  }
  function show() {
    try {
      if (!ui || !ui.host.isConnected) {
        var host = document.createElement("div");
        host.setAttribute("data-hyphae-ui", "1");
        host.style.cssText = "all:initial;position:fixed;left:14px;bottom:14px;z-index:2147483647;pointer-events:none;";
        var sh = host.attachShadow({ mode: "closed" });
        var st = document.createElement("style");
        st.textContent = ".c{pointer-events:auto;max-width:340px;background:#2a2118;color:#f0d9b5;border:1px solid #c9a06a;border-radius:12px;" +
          "padding:10px 12px;font:300 12px/1.45 'Helvetica Neue',system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.4)}" +
          ".h{font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:#e0b878;margin-bottom:4px}" +
          ".l{margin-top:4px;color:#f0d9b5}.x{float:right;cursor:pointer;color:#c9a06a;border:0;background:none;font:inherit}";
        var c = document.createElement("div"); c.className = "c";
        sh.appendChild(st); sh.appendChild(c);
        (document.body || document.documentElement).appendChild(host);
        ui = { host: host, c: c };
      }
      while (ui.c.firstChild) ui.c.removeChild(ui.c.firstChild);
      var x = document.createElement("button"); x.className = "x"; x.textContent = "×"; x.title = "Hide";
      x.addEventListener("click", function () { ui.host.remove(); ui = null; });
      var h = document.createElement("div"); h.className = "h";
      h.textContent = "hyphae · this page can see what you type";
      ui.c.appendChild(x); ui.c.appendChild(h);
      findings.slice(-4).forEach(function (f) { var l = document.createElement("div"); l.className = "l"; l.textContent = line(f); ui.c.appendChild(l); });
    } catch (e) { /* the state() read still has it */ }
  }

  window.__hyphaeTrip = {
    note: note,
    state: function () { return { findings: findings.map(function (f) { return Object.assign({}, f); }), watching: ring.length, recorders: Object.keys(hosts).filter(function (h) { return RECORDERS.test(h); }) }; },
  };
  window.__hyphaeTripNote = note;
})();
