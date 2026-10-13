/*
 * Hyphae activity ledger — what gets recorded, at which level, and how.
 *
 * Three levels, each with its own key (a circle named "ledger:<level>"):
 *
 *   receipts   that something happened, where, and when      (kind, host, time)
 *   summaries  what the Fold made of it                      (written by the Fold)
 *   content    the detail behind a receipt                   (URL path, title, text)
 *
 * Sharing a level means giving someone that level's key; withdrawing means
 * making a new key (see README). Every event is sealed to its level's key at
 * the moment it is captured, so what is queued on this device, and later sent
 * anywhere, is already ciphertext.
 *
 * Capture is opt-in and starts at the narrowest setting:
 *
 *   seal-only    only Hyphae's own seal / reveal actions        (default)
 *   visits       also which pages you open (host in receipts; path + title in content)
 *   visits+text  also page text, only on sites you list        (not built yet)
 *
 * Requires HyCrypto (crypto.js). No DOM, no chrome.* — storage is injected so
 * the same code runs in the worker, the popup and Node tests.
 */
(function (root, factory) {
  var api = factory(root.HyCrypto);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HyLedger = api;
})(typeof self !== "undefined" ? self : globalThis, function (HyCrypto) {
  "use strict";

  var LEVELS = ["receipts", "summaries", "content"];
  var MODES = ["seal-only", "visits", "visits+text"];
  var MAX_QUEUE = 5000;

  function defaultPolicy() { return { mode: "seal-only", paused: false, textSites: [] }; }

  function normalizePolicy(p) {
    var d = defaultPolicy();
    if (!p || typeof p !== "object") return d;
    return {
      mode: MODES.indexOf(p.mode) !== -1 ? p.mode : d.mode,
      paused: p.paused === true,
      textSites: Array.isArray(p.textSites)
        ? p.textSites.filter(function (s) { return typeof s === "string"; })
            .map(function (s) { return s.toLowerCase().trim(); }).filter(Boolean).slice(0, 200)
        : [],
    };
  }

  function parseUrl(url) {
    try {
      var u = new URL(url);
      return (u.protocol === "http:" || u.protocol === "https:") ? u : null;
    } catch (e) { return null; }
  }

  /**
   * What one event contributes at each level under this policy.
   * Returns { receipts?: object, content?: object }; {} means record nothing.
   * URLs are cut to origin + path: query strings and fragments carry tokens
   * and session ids, so they are never kept.
   */
  function describe(kind, data, policy, now) {
    var p = normalizePolicy(policy);
    data = data || {};
    var out = {};
    if (p.paused) return out;
    var u = data.url ? parseUrl(data.url) : null;
    var host = data.host || (u && u.hostname.toLowerCase()) || null;

    if (kind === "seal") {
      out.receipts = { k: "seal", t: now, host: host, circle: data.circleKid || null };
      if (p.mode === "visits+text" && host && p.textSites.indexOf(host) !== -1 && typeof data.text === "string") {
        out.content = { k: "seal", t: now, host: host, text: data.text };
      }
    } else if (kind === "reveal") {
      out.receipts = { k: "reveal", t: now, host: host, opened: data.opened | 0, locked: data.locked | 0 };
    } else if (kind === "visit") {
      if (p.mode === "seal-only" || !u) return out;
      out.receipts = { k: "visit", t: now, host: u.hostname.toLowerCase() };
      out.content = { k: "visit", t: now, url: u.origin + u.pathname, title: String(data.title || "").slice(0, 200) };
    }
    return out;
  }

  /** The three level keys, created on first use. */
  async function ensureScopes(storage) {
    var scopes = (await storage.get("scopes")) || {};
    var changed = false;
    LEVELS.forEach(function (level) {
      if (!scopes[level]) { scopes[level] = HyCrypto.newCircle("ledger:" + level); changed = true; }
    });
    if (changed) await storage.set("scopes", scopes);
    return scopes;
  }

  /** Capture one event: describe, seal each part to its level, queue. Returns how many parts were queued. */
  async function record(storage, kind, data, now) {
    var policy = await storage.get("policy");
    var parts = describe(kind, data, policy, now);
    var levels = Object.keys(parts);
    if (!levels.length) return 0;
    var scopes = await ensureScopes(storage);
    var queue = (await storage.get("ledger")) || [];
    for (var i = 0; i < levels.length; i++) {
      var level = levels[i];
      queue.push({ level: level, t: now, token: await HyCrypto.seal(scopes[level], JSON.stringify(parts[level])) });
    }
    if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);
    await storage.set("ledger", queue);
    return levels.length;
  }

  /** Read the queue back with the level keys (for the Fold and the UI). */
  async function readQueue(storage, level) {
    var scopes = await ensureScopes(storage);
    var byKid = {};
    LEVELS.forEach(function (l) { byKid[scopes[l].kid] = scopes[l]; });
    var queue = (await storage.get("ledger")) || [];
    var out = [];
    for (var i = 0; i < queue.length; i++) {
      if (level && queue[i].level !== level) continue;
      var r = await HyCrypto.revealText(queue[i].token, byKid);
      if (r.opened) { try { out.push(JSON.parse(r.text)); } catch (e) { /* skip malformed */ } }
    }
    return out;
  }

  return {
    LEVELS: LEVELS, MODES: MODES, defaultPolicy: defaultPolicy, normalizePolicy: normalizePolicy,
    describe: describe, ensureScopes: ensureScopes, record: record, readQueue: readQueue,
  };
});
