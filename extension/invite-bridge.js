/*
 * HyInviteBridge — the worker's side of the invite flow, as a message handler.
 *
 * The page layer (gmail.js) never holds the identity keys or any pair key: it asks
 * this bridge, by message, to do the one thing it needs, and gets back text and
 * small plain objects. Nothing returned here is a key. `invite-create` returns the
 * one-time code, to be shown only in hyphae's own panel and never put in a Gmail
 * field (the send guard refuses it there as well).
 *
 * Plain UMD, no chrome.*: storage is injected, so the same code runs in the service
 * worker and under Node tests.
 *
 *   var bridge = HyInviteBridge.create({ HyInvite, storage, now?, key?, name? });
 *   bridge.handle(op, args) -> Promise<result>        (ops listed in OPS below)
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HyInviteBridge = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  var OPS = [
    "invite-create",   // {to, mode?, explain?}              -> {ok, iid, subject, body, code, setup}
    "invite-read",     // {text, from?}                      -> {ok, invite:{iid,mode,expires,claimsToBe,from}, alreadyPaired?, keyChange?}
    "invite-join",     // {text, from?, code?, label?}       -> {ok, hello, mode} | {ok:false, reason}
    "hello-accept",    // {text}                             -> {ok, welcome, to, status} | {ok:false, reason, alarm?}
    "welcome-accept",  // {text, from?}                      -> {ok, status}
    "who",             // {addrs:[..]}                       -> {ok, who:{addr:{state}}}
    "seal",            // {recipients, text, subject?, allowUnverified?} -> {ok, body, subject} | {ok:false, ...}
    "open",            // {text}                             -> {ok, items:[{ok, authentic, body, subject, from, ...}]}
    "classify",        // {text}                             -> {ok, kinds:["inv"|"hello"|"welcome"...]}
    "safety",          // {addr}                             -> {ok, number}
    "safety-confirm",  // {addr, typed}                      -> {ok, status} | {ok:false, reason}
    "alarms",          // {}                                 -> {ok, alarms:[...]}
    "seal-file",       // {fp|to, b64, meta}                 -> {ok, b64} | {ok:false, reason}   (Drive HYD1 under that contact's circle)
    "open-file",       // {b64}                              -> {ok, b64, meta, fp, via} | {ok:false, reason}
    "directory",       // {q?}                               -> {ok, people:[{name, emails, status, via}]}
  ];

  function create(opts) {
    var HI = opts.HyInvite;
    var DS = opts.DriveSeal || null;
    var key = opts.key || "invite";
    var agentP = null;
    var queue = Promise.resolve();

    function save(a) { return opts.storage.set(key, { identity: a.identity, state: a.state }); }

    // Memoise the promise, not the result: two cold-start callers must not each build an Agent.
    function agent() {
      if (agentP) return agentP;
      agentP = (async function () {
        var d = await opts.storage.get(key);
        var identity = d && d.identity ? d.identity : await HI.newIdentity(opts.name || "");
        var a = new HI.Agent({ identity: identity, state: d && d.state, now: opts.now });
        if (!d || !d.identity) await save(a);
        return a;
      })();
      agentP.catch(function () { agentP = null; });
      return agentP;
    }

    function b64ToBytes(b) {
      if (typeof b !== "string") return null;
      try { var bin = atob(b), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; } catch (e) { return null; }
    }
    function bytesToB64(u) {
      var s = ""; for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      return btoa(s);
    }
    function addrOk(a) { return typeof a === "string" && a.length < 255 && /^[^\s@]+@[^\s@]+$/.test(a); }
    function str(v, max) { return typeof v === "string" && v.length <= max ? v : null; }

    // What a page may be told about a contact: never the circle, never a key.
    function brief(c) {
      return c ? { fp: c.fp, status: c.status, addresses: c.addresses.slice() } : null;
    }

    var impl = {
      "invite-create": async function (a, args) {
        if (!addrOk(args.to)) return { ok: false, reason: "bad-address" };
        var r = await a.createInvite({ to: args.to.toLowerCase(), mode: args.mode === "sas" ? "sas" : "code", explain: args.explain === true });
        await save(a);
        return { ok: true, iid: r.iid, subject: r.email.subject, body: r.email.body, code: r.code, setup: r.setup };
      },

      "invite-read": async function (a, args) {
        var text = str(args.text, 400000); if (text === null) return { ok: false, reason: "bad-text" };
        var r = await a.readInvite(text, { from: args.from || "" });
        if (!r.ok) return { ok: false, reason: r.reason };
        var i = r.invite;
        return {
          ok: true,
          invite: { iid: i.iid, mode: i.mode, expires: i.expires, claimsToBe: i.claimsToBe, from: i.from },
          alreadyPaired: r.alreadyPaired || null, keyChange: r.keyChange || null,
        };
      },

      "invite-join": async function (a, args) {
        var text = str(args.text, 400000); if (text === null) return { ok: false, reason: "bad-text" };
        var r = await a.readInvite(text, { from: args.from || "" });
        if (!r.ok) return { ok: false, reason: r.reason };
        var j = await a.join(r.invite, { code: args.code ? String(args.code).slice(0, 64) : null, label: str(args.label || "", 60) || "" });
        await save(a);
        if (!j.ok) return { ok: false, reason: j.reason };
        return { ok: true, hello: j.hello, mode: j.mode, contact: brief(j.contact) };
      },

      "hello-accept": async function (a, args) {
        var text = str(args.text, 400000); if (text === null) return { ok: false, reason: "bad-text" };
        var r = await a.acceptHello(text);
        await save(a);
        if (!r.ok) return { ok: false, reason: r.reason, alarm: r.alarm || null, failures: r.failures, locked: !!r.locked };
        return { ok: true, welcome: r.welcome, to: r.to, status: r.status || null, contact: brief(r.contact) };
      },

      "welcome-accept": async function (a, args) {
        var text = str(args.text, 400000); if (text === null) return { ok: false, reason: "bad-text" };
        var r = await a.acceptWelcome(text);
        if (r.ok && r.contact && typeof args.from === "string" && addrOk(args.from)) {
          // The code was confirmed, so this key is the person who invited us. The address they
          // wrote from becomes theirs here, which is what lets a reply to it be sealed.
          a.bindAddress(r.contact.fp, args.from.toLowerCase());
        }
        await save(a);
        if (!r.ok) return { ok: false, reason: r.reason, alarm: r.alarm || null };
        return { ok: true, status: r.status, contact: brief(r.contact) };
      },

      "who": async function (a, args) {
        var addrs = Array.isArray(args.addrs) ? args.addrs.slice(0, 50) : [];
        var who = {};
        addrs.forEach(function (addr) {
          if (!addrOk(addr)) return;
          var cf = a.contactForAddress(addr);
          if (cf.ambiguous) who[addr] = { state: "ambiguous" };
          else if (cf.contact && cf.contact.circle) {
            who[addr] = { state: cf.contact.status === "unverified" ? "pair-unverified" : "pair-verified", fp: cf.contact.fp };
          } else who[addr] = { state: "none" };
        });
        return { ok: true, who: who };
      },

      "seal": async function (a, args) {
        var recips = Array.isArray(args.recipients) ? args.recipients.map(function (r) { return String(r).toLowerCase(); }) : [];
        var text = str(args.text, 400000);
        if (!recips.length || text === null || !text) return { ok: false, reason: "nothing-to-seal" };
        var subject = str(args.subject || "", 300) || "";
        var fps = [], missing = [], unverified = [];
        recips.forEach(function (addr) {
          var cf = a.contactForAddress(addr);
          if (cf.ambiguous || !cf.contact || !cf.contact.circle) missing.push(addr);
          else if (cf.contact.status === "unverified" && args.allowUnverified !== true) unverified.push(addr);
          else if (fps.indexOf(cf.contact.fp) === -1) fps.push(cf.contact.fp);
        });
        if (missing.length) return { ok: false, reason: "not-connected", missing: missing };
        if (unverified.length) return { ok: false, reason: "unverified", unverified: unverified };
        var tokens = [];
        for (var i = 0; i < fps.length; i++) {
          tokens.push(await a.sealTo(fps[i], text, { subject: subject, allowUnverified: args.allowUnverified === true }));
        }
        var body = HI.sealedBody(tokens);
        var g = a.guardSend({ recipients: recips, subject: HI.SUBJECT_LABEL, body: body });
        if (!g.allow) return { ok: false, reason: "guard", blocks: g.blocks.map(function (b) { return b.code; }) };
        await save(a);
        return { ok: true, body: body, subject: HI.SUBJECT_LABEL };
      },

      "open": async function (a, args) {
        var text = str(args.text, 400000); if (text === null) return { ok: false, reason: "bad-text" };
        var items = await a.open(text);
        await save(a);
        return {
          ok: true,
          items: items.map(function (it) {
            return {
              ok: !!it.ok, authentic: !!it.authentic, reason: it.reason || null, body: typeof it.body === "string" ? it.body : null,
              subject: it.subject || "", kind: it.kind || null, from: it.from || null, ts: it.ts || null,
              contactStatus: it.contactStatus || null, seenBefore: !!it.seenBefore,
            };
          }),
        };
      },

      "classify": async function (a, args) {
        var text = str(args.text, 400000); if (text === null) return { ok: false, reason: "bad-text" };
        var kinds = HI.parseTokens(text).map(function (t) { return t.kind; });
        return { ok: true, kinds: kinds.filter(function (k, i) { return kinds.indexOf(k) === i; }) };
      },

      "safety": async function (a, args) {
        var cf = a.contactForAddress(String(args.addr || ""));
        if (!cf.contact) return { ok: false, reason: "unknown-contact" };
        return { ok: true, number: await a.safetyNumber(cf.contact.fp) };
      },

      "safety-confirm": async function (a, args) {
        var cf = a.contactForAddress(String(args.addr || ""));
        if (!cf.contact) return { ok: false, reason: "unknown-contact" };
        var r = await a.confirmSafetyNumber(cf.contact.fp, String(args.typed || "").slice(0, 80));
        await save(a);
        return r.ok ? { ok: true, status: r.status } : { ok: false, reason: r.reason };
      },

      // Files. The page sends bytes and gets bytes: the contact's circle never leaves here.
      "seal-file": async function (a, args) {
        if (!DS) return { ok: false, reason: "unavailable" };
        var c = null;
        if (typeof args.fp === "string" && a.state.contacts[args.fp]) c = a.state.contacts[args.fp];
        else if (typeof args.to === "string") { var cf = a.contactForAddress(args.to.toLowerCase()); c = cf.ambiguous ? null : cf.contact; }
        if (!c || !c.circle) return { ok: false, reason: "not-connected" };
        if (c.status === "unverified" && args.allowUnverified !== true) return { ok: false, reason: "unverified" };
        var bytes = b64ToBytes(str(args.b64, 60000000));
        if (!bytes) return { ok: false, reason: "bad-bytes" };
        var meta = args.meta && typeof args.meta === "object" ? args.meta : {};
        var sealed = await DS.sealBytes(c.circle, bytes, {
          name: String(meta.name || "file").slice(0, 255), mime: String(meta.mime || "application/octet-stream").slice(0, 120),
          size: bytes.length, mtime: Number(meta.mtime) || Date.now(), id: "upload", path: null,
        });
        return { ok: true, b64: bytesToB64(sealed) };
      },

      "open-file": async function (a, args) {
        if (!DS) return { ok: false, reason: "unavailable" };
        var bytes = b64ToBytes(str(args.b64, 60000000));
        if (!bytes) return { ok: false, reason: "bad-bytes" };
        var circles = [], owner = {};
        Object.keys(a.state.contacts).forEach(function (fp) {
          var cc = a.state.contacts[fp].circle;
          if (cc) { circles.push(cc); owner[cc.kid] = fp; }
        });
        if (!circles.length) return { ok: false, reason: "no-circle" };
        try {
          var o = await DS.openBytes(circles, bytes);
          var used = o.manifest && o.manifest.kid;
          return { ok: true, b64: bytesToB64(o.bytes), meta: o.meta || {}, fp: used && owner[used] ? owner[used] : null };
        } catch (e) { return { ok: false, reason: (e && e.code) || "cannot-open" }; }
      },

      "directory": async function (a, args) {
        var q = typeof args.q === "string" ? args.q.toLowerCase().slice(0, 100) : "";
        var people = [];
        var cs = a.state.contacts;
        Object.keys(cs).forEach(function (fp) {
          var c = cs[fp];
          if (!c || !c.circle) return;
          var name = c.label || c.claims || "";
          var emails = (c.addresses || []).slice();
          var hay = (name + " " + emails.join(" ")).toLowerCase();
          if (q && hay.indexOf(q) === -1) return;
          people.push({ fp: fp, name: name, emails: emails, status: c.status === "unverified" ? "unverified" : "connected", via: "invite" });
        });
        return { ok: true, people: people };
      },

      "alarms": async function (a) {
        return { ok: true, alarms: (a.state.alarms || []).slice(-20) };
      },
    };

    return {
      ops: OPS.slice(),
      handle: function (op, args) {
        if (!Object.prototype.hasOwnProperty.call(impl, op)) return Promise.resolve({ ok: false, reason: "unknown-op" });
        // One operation at a time: ops that change the agent's state save after, in order.
        var run = queue.then(async function () {
          var a = await agent();
          return impl[op](a, args && typeof args === "object" ? args : {});
        });
        queue = run.catch(function () {});
        return run.catch(function (e) { return { ok: false, reason: "error", message: String(e && e.message ? e.message : e) }; });
      },
    };
  }

  /**
   * Add people connected by invitation to a list of suggestions from the contacts store,
   * skipping anyone already there by address. Pure; used by the worker and by the tests.
   */
  function mergeSuggestions(list, people) {
    var out = Array.isArray(list) ? list.slice() : [];
    (people || []).forEach(function (p) {
      if (!p.emails || !p.emails.length) return;
      var dup = out.some(function (x) { return (x.emails || []).some(function (e) { return p.emails.indexOf(e) !== -1; }); });
      if (!dup) out.push({ name: p.name, emails: p.emails, status: p.status === "connected" ? "ready" : "unverified", circleKid: null });
    });
    return out;
  }

  return { create: create, OPS: OPS, mergeSuggestions: mergeSuggestions };
});
