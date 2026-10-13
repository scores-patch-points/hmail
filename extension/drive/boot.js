/*
 * hyphae drive — the auto mode and the glue the worker calls.
 *
 *   var runner = HyDriveBoot.runner({ getToken, getCircles, storage });
 *   HyDriveBoot.arm(chrome, runner);            // fresh boot + a periodic alarm
 *   runner.auto({ dryRun: true })               // what would it do? (no writes at all)
 *   runner.sweep({ folderId })                  // the whole backlog, now
 *
 * Auto mode is OFF until the user turns it on (settings.enabled), because it
 * rewrites files in their Drive. When on, a run is:
 *
 *   first run / weekly / forced   a full sweep (walk the scope, seal what is unsealed)
 *   every other run               the Drive changes feed since the last run:
 *                                 new, edited, moved and newly shared files only,
 *                                 plus earlier failures that still have attempts left
 *
 * Both paths use the same sealOne(), so a file is never sealed twice and a run
 * killed anywhere is simply continued by the next. Startup runs are never
 * interactive: with no token on hand they skip and say so.
 *
 * Worker/offscreen/Node only.
 */
(function (root, factory) {
  var deps = { seal: root.HyDriveSeal, client: root.HyDriveClient, sweep: root.HyDriveSweep, catalog: root.HyDriveCatalog };
  if (typeof require === "function") {
    if (!deps.seal) deps.seal = require("./seal.js");
    if (!deps.client) deps.client = require("./client.js");
    if (!deps.sweep) deps.sweep = require("./sweep.js");
    if (!deps.catalog) deps.catalog = require("./catalog.js");
  }
  var api = factory(deps);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HyDriveBoot = api;
})(typeof self !== "undefined" ? self : globalThis, function (D) {
  "use strict";

  var SETTINGS_KEY = "hyphae.drive.settings";
  var ALARM = "hyphae-drive-auto";
  var DAY = 86400000;
  var DEFAULT_SETTINGS = {
    enabled: false,        // auto mode is opt-in
    circleKid: null,       // which circle seals the Drive; null = the only circle, else refuse
    folderId: null,        // null = the whole Drive (files you own)
    names: "opaque",
    mode: "inplace",
    purge: false,
    includeShared: false,
    native: "skip",
    fullEveryDays: 7,
  };

  function pickCircle(circles, kid) {
    var list = Object.keys(circles || {}).map(function (k) { return circles[k]; }).filter(Boolean);
    if (kid) return circles[kid] || null;
    return list.length === 1 ? list[0] : null;
  }

  function runner(deps) {
    if (!deps || typeof deps.getToken !== "function" || typeof deps.getCircles !== "function") throw new Error("drive boot: getToken and getCircles are required");
    var storage = deps.storage || D.sweep.memoryStorage();
    var running = null;

    async function settings() {
      var s = await storage.get(SETTINGS_KEY);
      var o = {};
      Object.keys(DEFAULT_SETTINGS).forEach(function (k) { o[k] = (s && s[k] !== undefined) ? s[k] : DEFAULT_SETTINGS[k]; });
      return o;
    }
    async function setSettings(patch) {
      var cur = await settings();
      Object.keys(patch || {}).forEach(function (k) { if (k in DEFAULT_SETTINGS) cur[k] = patch[k]; });
      await storage.set(SETTINGS_KEY, cur);
      return cur;
    }

    /** Build the client + engine for one run. Returns { skipped } when it can't. */
    async function open(o) {
      var st = await settings();
      var circles = await deps.getCircles();
      var circle = pickCircle(circles, st.circleKid);
      if (!circle) return { skipped: "no-circle" };
      var tokenFn = function (t) { return Promise.resolve(deps.getToken({ interactive: false, refresh: !!(t && t.refresh) })); };
      try { if (!(await tokenFn({}))) return { skipped: "no-token" }; } catch (e) { return { skipped: "no-token" }; }
      var client = D.client.create({
        token: tokenFn, fetch: deps.fetch, sleep: deps.sleep, now: deps.now, qps: deps.qps || 6, signal: o && o.signal || null,
      });
      var catalog = D.catalog.create({ client: client, circle: circle, circles: circles, parentId: st.folderId || "root" });
      var engine = D.sweep.create({
        client: client, circle: circle, circles: circles, store: storage, catalog: catalog,
        onProgress: deps.onProgress, accountKey: deps.accountKey,
      });
      return { st: st, client: client, engine: engine, catalog: catalog, circle: circle, circles: circles };
    }

    function sweepOpts(st, o) {
      return {
        folderId: st.folderId, names: st.names, mode: st.mode, purge: st.purge, includeShared: st.includeShared,
        native: st.native, dryRun: !!(o && o.dryRun), signal: o && o.signal, concurrency: (o && o.concurrency) || 1,
        maxFiles: o && o.maxFiles, includeNotOwned: false, retryFailed: !!(o && o.retryFailed),
      };
    }

    // Is `file` inside the configured folder? Memoized parent walk.
    function scopeTester(client, folderId) {
      if (!folderId) return async function () { return true; };
      var memo = {}; memo[folderId] = true;
      async function inside(id, depth) {
        if (memo[id] !== undefined) return memo[id];
        if (depth > 24) return false;
        var p;
        try { p = await client.get(id, "id,parents"); } catch (e) { return (memo[id] = false); }
        var ok = false;
        for (var i = 0; p.parents && i < p.parents.length && !ok; i++) ok = await inside(p.parents[i], depth + 1);
        return (memo[id] = ok);
      }
      return async function (f) {
        for (var i = 0; f.parents && i < f.parents.length; i++) if (await inside(f.parents[i], 0)) return true;
        return false;
      };
    }

    async function viaChanges(ctx, token, sopts) {
      var files = {}, next = token, newStart = null, page;
      var inScope = scopeTester(ctx.client, ctx.st.folderId);
      do {
        page = await ctx.client.changes(next);
        for (var i = 0; i < page.changes.length; i++) {
          var c = page.changes[i];
          if (c.removed || !c.file) continue;
          if (!(await inScope(c.file))) continue;
          files[c.file.id] = { f: c.file };
        }
        next = page.nextPageToken || null;
        newStart = page.newStartPageToken || newStart;
      } while (next);
      // earlier failures with attempts left
      var L = await ctx.engine.ledger();
      var retry = L.ids().filter(function (id) {
        var e = L.get(id);
        return e.s === "failed" && (e.n || 0) < D.sweep.DEFAULTS.maxAttempts && !files[id];
      });
      for (var r = 0; r < retry.length; r++) {
        try { var g = await ctx.client.get(retry[r]); files[g.id] = { f: g }; } catch (e) { /* gone */ }
      }
      var list = Object.keys(files).map(function (k) { return files[k]; });
      var report = await ctx.engine.sweepFiles(list, sopts);
      report.via = "changes";
      return { report: report, newStart: newStart };
    }

    async function runAuto(o) {
      var ctx = await open(o);
      if (ctx.skipped) return { ran: false, skipped: ctx.skipped };
      var L = await ctx.engine.ledger();
      await ctx.catalog.load();
      var sopts = sweepOpts(ctx.st, o);
      var now = (deps.now || Date.now)();
      var token = L.meta("changesToken"), lastFull = L.meta("lastFullAt") || 0;
      var needFull = !!(o && o.full) || !token || (now - lastFull) > ctx.st.fullEveryDays * DAY;
      var report = null, newStart = null;
      if (!needFull) {
        try {
          var r = await viaChanges(ctx, token, sopts);
          report = r.report; newStart = r.newStart;
        } catch (e) {
          if (e.status === 400 || e.status === 404 || e.status === 410) needFull = true; // stale or invalid token
          else throw e;
        }
      }
      if (needFull) {
        // take the token BEFORE the walk so nothing changed during it is missed
        var startTok = await ctx.client.startPageToken();
        report = await ctx.engine.sweep(sopts);
        report.via = "full";
        newStart = startTok;
        if (!sopts.dryRun && !report.aborted) L.meta("lastFullAt", now);
      }
      if (!sopts.dryRun && !report.aborted && newStart) L.meta("changesToken", newStart);
      if (!sopts.dryRun) {
        L.meta("lastRun", { at: now, via: report.via, sealed: report.sealed, purged: report.purged, failed: report.failed.length, skipped: report.skipped, aborted: report.aborted });
        await L.flush();
      }
      return { ran: true, via: report.via, report: report };
    }

    function exclusive(fn) {
      if (running) return Promise.resolve({ ran: false, skipped: "busy" });
      running = Promise.resolve().then(fn).then(function (r) { running = null; return r; }, function (e) { running = null; throw e; });
      return running;
    }

    return {
      settings: settings,
      setSettings: setSettings,

      /** The boot/alarm entry point. No-op unless enabled (or force). Never interactive. */
      auto: function (o) {
        return exclusive(async function () {
          var st = await settings();
          if (!st.enabled && !(o && o.force) && !(o && o.dryRun)) return { ran: false, skipped: "disabled" };
          return runAuto(o);
        });
      },
      /** Seal the whole backlog now (a full sweep), regardless of the enabled switch. */
      sweep: function (o) {
        return exclusive(async function () {
          var ctx = await open(o);
          if (ctx.skipped) return { ran: false, skipped: ctx.skipped };
          await ctx.catalog.load();
          var report = await ctx.engine.sweep(sweepOpts(ctx.st, o));
          report.via = "full";
          return { ran: true, via: "full", report: report };
        });
      },
      unsealAll: function (o) {
        return exclusive(async function () {
          var ctx = await open(o);
          if (ctx.skipped) return { ran: false, skipped: ctx.skipped };
          await ctx.catalog.load();
          return { ran: true, report: await ctx.engine.unsealAll(sweepOpts(ctx.st, o)) };
        });
      },
      purgeAll: function (o) {
        return exclusive(async function () {
          var ctx = await open(o);
          if (ctx.skipped) return { ran: false, skipped: ctx.skipped };
          return { ran: true, report: await ctx.engine.purgeAll(sweepOpts(ctx.st, o)) };
        });
      },
      unsealOne: async function (id) {
        var ctx = await open({});
        if (ctx.skipped) return { ran: false, skipped: ctx.skipped };
        return { ran: true, result: await ctx.engine.unsealOne(id, sweepOpts(ctx.st, {})) };
      },
      /** Open one sealed file for display/download: { meta, bytes } — to extension pages only. */
      read: async function (id) {
        var ctx = await open({});
        if (ctx.skipped) return { ran: false, skipped: ctx.skipped };
        var r = await ctx.engine.readSealed(id);
        return { ran: true, meta: r.meta, bytes: r.bytes };
      },
      rebuildIndex: async function () {
        var ctx = await open({});
        if (ctx.skipped) return { ran: false, skipped: ctx.skipped };
        await ctx.catalog.load();
        var n = await ctx.catalog.rebuild();
        await ctx.catalog.save();
        return { ran: true, entries: n };
      },
      status: async function () {
        var st = await settings();
        var ctx = await open({});
        if (ctx.skipped) return { settings: st, skipped: ctx.skipped, busy: !!running };
        var L = await ctx.engine.ledger();
        return { settings: st, ledger: L.counts(), lastRun: L.meta("lastRun") || null, lastFullAt: L.meta("lastFullAt") || null, busy: !!running };
      },
    };
  }

  /**
   * getToken for Chrome: chrome.identity.getAuthToken (the manifest needs an
   * "oauth2" block and the "identity" permission). Does not work in Brave.
   */
  function chromeIdentityToken(chromeApi) {
    var last = null;
    return function (o) {
      o = o || {};
      return new Promise(function (resolve, reject) {
        function get() {
          chromeApi.identity.getAuthToken({ interactive: !!o.interactive }, function (t) {
            var err = chromeApi.runtime.lastError;
            if (err || !t) reject(new Error(err ? err.message : "no token"));
            else { last = t; resolve(t); }
          });
        }
        if (o.refresh && last) chromeApi.identity.removeCachedAuthToken({ token: last }, get); else get();
      });
    };
  }

  /**
   * getToken for browsers without getAuthToken: an implicit-grant
   * chrome.identity.launchWebAuthFlow with your own web OAuth client id. Tokens
   * last about an hour; a non-interactive call (startup) asks with prompt=none
   * and fails quietly if the user has not already consented.
   */
  function webAuthFlowToken(chromeApi, cfg) {
    var cached = null, expires = 0;
    return function (o) {
      o = o || {};
      if (cached && !o.refresh && Date.now() < expires - 60000) return Promise.resolve(cached);
      return new Promise(function (resolve, reject) {
        var q = new URLSearchParams({
          client_id: cfg.clientId, response_type: "token", redirect_uri: chromeApi.identity.getRedirectURL(),
          scope: (cfg.scopes || ["https://www.googleapis.com/auth/drive"]).join(" "),
        });
        if (!o.interactive) q.set("prompt", "none");
        chromeApi.identity.launchWebAuthFlow({ url: "https://accounts.google.com/o/oauth2/v2/auth?" + q.toString(), interactive: !!o.interactive }, function (redirect) {
          var err = chromeApi.runtime.lastError;
          if (err || !redirect) return reject(new Error(err ? err.message : "no redirect"));
          var frag = new URLSearchParams(String(redirect).split("#")[1] || "");
          var t = frag.get("access_token");
          if (!t) return reject(new Error("no access_token in redirect"));
          cached = t; expires = Date.now() + (parseInt(frag.get("expires_in"), 10) || 3000) * 1000;
          resolve(t);
        });
      });
    };
  }

  /** Register fresh-boot and periodic runs. Call at the top level of the worker, so listeners exist when it wakes. */
  function arm(chromeApi, r, o) {
    o = o || {};
    function go() { r.auto().catch(function () { /* the next boot or alarm tries again */ }); }
    chromeApi.runtime.onStartup.addListener(function () { setTimeout(go, o.startupDelayMs === undefined ? 15000 : o.startupDelayMs); });
    if (chromeApi.alarms) {
      chromeApi.alarms.create(ALARM, { delayInMinutes: 5, periodInMinutes: o.periodMinutes || 180 });
      chromeApi.alarms.onAlarm.addListener(function (a) { if (a && a.name === ALARM) go(); });
    }
  }

  /**
   * Message router for the worker's onMessage listener. Returns a Promise, or
   * null when `msg` is not a drive message. Only extension pages (no tab) of
   * this extension may use it: a content script runs beside a page, and
   * nothing here — least of all opened plaintext — may reach one.
   */
  function route(r, msg, sender, selfId) {
    if (!msg || msg.hyphae !== "drive") return null;
    if (!sender || sender.tab || (selfId && sender.id !== selfId)) return Promise.resolve({ error: "refused: not an extension page" });
    var op = msg.op, a = msg.args || {};
    var table = {
      status: function () { return r.status(); },
      settings: function () { return r.settings(); },
      "set-settings": function () { return r.setSettings(a); },
      auto: function () { return r.auto(a); },
      "dry-run": function () { return r.auto({ dryRun: true, force: true, full: true }); },
      sweep: function () { return r.sweep(a); },
      "unseal-all": function () { return r.unsealAll(a); },
      "purge-all": function () { return r.purgeAll(a); },
      "unseal-one": function () { return r.unsealOne(a.id); },
      read: function () { return r.read(a.id); },
      "rebuild-index": function () { return r.rebuildIndex(); },
    };
    if (!table[op]) return Promise.resolve({ error: "unknown drive op" });
    return Promise.resolve().then(table[op]);
  }

  return { runner: runner, arm: arm, route: route, chromeIdentityToken: chromeIdentityToken, webAuthFlowToken: webAuthFlowToken, DEFAULT_SETTINGS: DEFAULT_SETTINGS, ALARM: ALARM, pickCircle: pickCircle };
});
