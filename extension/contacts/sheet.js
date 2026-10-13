/*
 * hyphae contacts sheet. A classic content script for mail.google.com only.
 *
 * A quiet, text-only table of the people you can write to — the ones from
 * Google Contacts and the ones you have connected with over Matrix — with the
 * one thing to do about each. It is a panel in the page, plainly hyphae's and
 * not Gmail's: the Hyphae Network look (dark ground, lavender text, thin
 * wide-tracked capitals), no icons or graphics, and a mark that is just the
 * letters h and y overlaid.
 *
 * Everything is built with createElement / textContent (Gmail enforces Trusted
 * Types) inside one closed shadow root.
 *
 * This file never holds, shows or sends a key, token or message. It sees ids,
 * names, email addresses, Matrix ids and status words, through a message port:
 *
 *   window.__hyphaeContactsPort = {
 *     all()                 -> Promise<Contact[]>
 *     search(q)             -> Promise<Contact[]>      (optional; adds store-side matches)
 *     link(id, patch)       -> Promise<Contact|void>   patch: {circleKid} | {email}  (core.js's link();
 *                                                      rejects with Error.code not-found|invalid|conflict|limit)
 *     importGoogleCsv(text) -> Promise<summary>
 *     circles()             -> Promise<[{kid, name}]>  (optional; labels only, never key material)
 *   }
 *
 * Contact = { id, name, emails:[string], matrix:null|{mxid,displayName},
 *             circleKid:null|string, sources:[string], status, updated }
 * status: "ready" | "needs-key" | "matrix-only" | "google-only"
 *
 * Exposes window.__hyphaeContacts = { open, close, refresh, composeTo, annotate,
 * annotateText, annotateAsync }. The pure logic is also on
 * window.__hyphaeContactsLogic, which is what the Node test loads.
 */
(function () {
  "use strict";

  var root = typeof window !== "undefined" ? window : globalThis;
  if (root.__hyphaeContacts) return;

  // =========================================================================
  // Pure logic — no DOM, no port. Tested in sheet.test.mjs.
  // =========================================================================

  var STATUSES = ["ready", "needs-key", "matrix-only", "google-only"];
  var WORD = { "ready": "ready", "needs-key": "needs key", "matrix-only": "matrix only", "google-only": "google only" };
  var RANK = { "ready": 0, "needs-key": 1, "matrix-only": 2, "google-only": 3 };

  // The Hyphae Network look. Every text/background pair used is listed in PAIRS
  // so the test can hold it to 4.5:1.
  var C = {
    ground: "#1b1d28",     // panel
    field: "#14161f",      // search / form fields
    select: "#252837",     // the active row
    rule: "#313140",       // hairlines (decorative; not text)
    text: "#cfc8ec",       // primary text
    lav: "#b1a6d4",        // lavender: labels, buttons
    lavHi: "#c9bff0",      // focus ring, ready
    muted: "#8a8a9c",      // quiet notes on the ground
    cell: "#a4a4b6",       // table cells that are secondary
    btn: "#938bb2",        // primary button ground
    amber: "#d9b27c",      // needs key
    slate: "#8fb8c8"       // matrix only
  };
  var STATUS_COLOR = { "ready": C.lavHi, "needs-key": C.amber, "matrix-only": C.slate, "google-only": C.cell };

  var PAIRS = [
    { fg: C.text, bg: C.ground, use: "primary text" },
    { fg: C.text, bg: C.select, use: "primary text, active row" },
    { fg: C.lav, bg: C.ground, use: "labels, buttons, headings" },
    { fg: C.lav, bg: C.select, use: "labels in the active row" },
    { fg: C.muted, bg: C.ground, use: "notes, hints" },
    { fg: C.muted, bg: C.field, use: "placeholder in a field" },
    { fg: C.cell, bg: C.ground, use: "secondary cells" },
    { fg: C.cell, bg: C.select, use: "secondary cells, active row" },
    { fg: C.text, bg: C.field, use: "typed text in a field" },
    { fg: C.ground, bg: C.btn, use: "primary button label" },
    { fg: STATUS_COLOR["ready"], bg: C.ground, use: "status: ready" },
    { fg: STATUS_COLOR["ready"], bg: C.select, use: "status: ready, active row" },
    { fg: STATUS_COLOR["needs-key"], bg: C.ground, use: "status: needs key" },
    { fg: STATUS_COLOR["needs-key"], bg: C.select, use: "status: needs key, active row" },
    { fg: STATUS_COLOR["matrix-only"], bg: C.ground, use: "status: matrix only" },
    { fg: STATUS_COLOR["matrix-only"], bg: C.select, use: "status: matrix only, active row" },
    { fg: STATUS_COLOR["google-only"], bg: C.ground, use: "status: google only" },
    { fg: STATUS_COLOR["google-only"], bg: C.select, use: "status: google only, active row" }
  ];

  function lum(hex) {
    var h = String(hex).replace("#", "");
    var ch = [0, 2, 4].map(function (i) {
      var v = parseInt(h.substr(i, 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  function contrast(a, b) {
    var x = lum(a), y = lum(b);
    var hi = Math.max(x, y), lo = Math.min(x, y);
    return (hi + 0.05) / (lo + 0.05);
  }

  function str(v) { return typeof v === "string" ? v : ""; }

  /** "Maya <Maya@X.org>" and "maya@x.org" both become "maya@x.org". "" if none. */
  function emailKey(s) {
    var t = str(s).trim();
    var m = /<([^<>\s]+@[^<>\s]+)>/.exec(t);
    if (m) t = m[1];
    t = t.replace(/^mailto:/i, "").trim().toLowerCase();
    return /^[^\s@<>]+@[^\s@<>]+$/.test(t) ? t : "";
  }
  function isEmail(s) { return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(str(s).trim()); }

  function fold(s) {
    var t = str(s).toLowerCase();
    try { t = t.normalize("NFD").replace(/[̀-ͯ]/g, ""); } catch (e) { /* old engine */ }
    return t;
  }

  /**
   * Copy only the fields the sheet may hold. Anything else on the object — a key,
   * a token, a message — is dropped here and never stored or rendered.
   */
  function tidyOne(raw) {
    if (!raw || typeof raw !== "object") return null;
    var id = str(raw.id) || (typeof raw.id === "number" ? String(raw.id) : "");
    if (!id) return null;
    var emails = [];
    (Array.isArray(raw.emails) ? raw.emails : []).forEach(function (e) {
      var k = emailKey(e);
      if (k && emails.indexOf(k) < 0) emails.push(k);
    });
    var mx = raw.matrix && typeof raw.matrix === "object" && str(raw.matrix.mxid)
      ? { mxid: str(raw.matrix.mxid), displayName: str(raw.matrix.displayName) } : null;
    var kid = str(raw.circleKid) || null;
    var status = STATUSES.indexOf(raw.status) >= 0 ? raw.status : deriveStatus(emails, mx, kid);
    return {
      id: id,
      name: str(raw.name).trim(),
      emails: emails,
      matrix: mx,
      circleKid: kid,
      sources: (Array.isArray(raw.sources) ? raw.sources : []).filter(function (s) { return typeof s === "string"; }),
      status: status,
      updated: typeof raw.updated === "number" ? raw.updated : 0
    };
  }
  function deriveStatus(emails, mx, kid) {
    if (!mx) return "google-only";
    if (kid) return "ready";
    return emails.length ? "needs-key" : "matrix-only";
  }
  function tidy(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (r) { var c = tidyOne(r); if (c) out.push(c); });
    return out;
  }

  function displayName(c) {
    return c.name || (c.matrix && c.matrix.displayName) || c.emails[0] || (c.matrix && c.matrix.mxid) || "(no name)";
  }
  function wordOf(status) { return WORD[status] || status; }
  function titleWord(status) { var w = wordOf(status); return w.charAt(0).toUpperCase() + w.slice(1); }

  /** Everything a search may match, folded. circleNames maps kid -> name. */
  function haystack(c, circleNames) {
    return fold([
      c.name, c.emails.join(" "),
      c.matrix ? c.matrix.mxid + " " + c.matrix.displayName : "",
      wordOf(c.status),
      c.circleKid ? ((circleNames && circleNames[c.circleKid]) || c.circleKid) : ""
    ].join(" "));
  }
  /** Every whitespace-separated token must appear somewhere. */
  function matches(c, q, circleNames) {
    var toks = fold(q).split(/\s+/).filter(Boolean);
    if (!toks.length) return true;
    var h = haystack(c, circleNames);
    for (var i = 0; i < toks.length; i++) if (h.indexOf(toks[i]) < 0) return false;
    return true;
  }

  function counts(list) {
    var n = { all: list.length, "ready": 0, "needs-key": 0, "matrix-only": 0, "google-only": 0 };
    list.forEach(function (c) { n[c.status]++; });
    return n;
  }

  var SORT_KEYS = ["name", "email", "matrix", "status", "circle"];
  function sortValue(c, key, circleNames) {
    switch (key) {
      case "name": return fold(displayName(c));
      case "email": return c.emails[0] || "";
      case "matrix": return fold(c.matrix ? c.matrix.mxid : "");
      case "status": return RANK[c.status];
      case "circle": return c.circleKid ? fold((circleNames && circleNames[c.circleKid]) || c.circleKid) : "";
    }
    return "";
  }
  /** Stable; an empty value sorts last whichever way the column runs. */
  function sortContacts(list, key, dir, circleNames) {
    var sign = dir === "desc" ? -1 : 1;
    var keyed = list.map(function (c, i) { return { c: c, i: i, v: sortValue(c, key, circleNames), n: fold(displayName(c)) }; });
    keyed.sort(function (a, b) {
      var ea = a.v === "", eb = b.v === "";
      if (ea !== eb) return ea ? 1 : -1;
      var r = 0;
      if (!ea) {
        if (typeof a.v === "number") r = a.v - b.v;
        else r = a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
      }
      if (r) return r * sign;
      if (a.n !== b.n) return a.n < b.n ? -1 : 1;
      return a.i - b.i;
    });
    return keyed.map(function (k) { return k.c; });
  }

  /**
   * The rows to show. Counts are over what the search matched (before the status
   * chip), so each chip says how many rows it would give you.
   */
  function view(contacts, o) {
    o = o || {};
    var extra = o.extraIds || null;
    var searched = contacts.filter(function (c) {
      return !str(o.q).trim() || matches(c, o.q, o.circleNames) || (extra && extra[c.id]);
    });
    var shown = o.status && o.status !== "all"
      ? searched.filter(function (c) { return c.status === o.status; }) : searched;
    return {
      rows: sortContacts(shown, o.sortKey || "name", o.sortDir || "asc", o.circleNames),
      counts: counts(searched),
      total: contacts.length
    };
  }

  /**
   * For each recipient email, the status word, so a compose line can say
   * "to Maya (ready) · to Dev (needs key)". Addresses not in contacts say so.
   */
  function annotate(contacts, emails) {
    var best = {};
    contacts.forEach(function (c) {
      c.emails.forEach(function (e) {
        var cur = best[e];
        if (!cur || RANK[c.status] < RANK[cur.status]) best[e] = c;
      });
    });
    var seen = {}, out = [];
    (Array.isArray(emails) ? emails : []).forEach(function (raw) {
      var k = emailKey(raw);
      var key = k || str(raw).trim();
      if (!key || seen[key]) return;
      seen[key] = 1;
      var c = k ? best[k] : null;
      if (!c) {
        out.push({ email: key, name: null, status: null, word: "not in contacts",
          label: "to " + key + " (not in contacts)" });
        return;
      }
      var name = displayName(c);
      out.push({ email: k, name: name, status: c.status, word: wordOf(c.status),
        label: "to " + name + " (" + wordOf(c.status) + ")" });
    });
    return out;
  }
  function annotateText(contacts, emails) {
    return annotate(contacts, emails).map(function (a) { return a.label; }).join(" · ");
  }

  /** The one thing to do about a contact. Enter in the table runs it. */
  function primaryAction(c) {
    var canMail = c.emails.length > 0;
    if (c.status === "ready" && canMail) return { kind: "compose", label: "Encrypt a message to this person" };
    if (c.status === "ready") return { kind: "add-email", label: "Add an email address" };
    if (c.status === "needs-key") return { kind: "link-key", label: "Link a key" };
    if (c.status === "google-only") return { kind: "invite", label: "Invite to hyphae" };
    return { kind: "add-email", label: "Add an email address" };
  }
  function explain(c) {
    var n = displayName(c);
    switch (primaryAction(c).kind) {
      case "compose": return n + " is connected and you hold a key: a message sealed to them can be sent now.";
      case "link-key": return "Connected on Matrix, but no key yet. The key must be handed over by Signal, in person, or as a file — never by email.";
      case "invite": return n + " is in your Google contacts only. To write to them sealed, they would need hyphae and a key from you.";
      default:
        return c.status === "ready"
          ? n + " has a key but no email address, so Gmail has nowhere to send it."
          : "Connected on Matrix, with no email address on file. Add one to write to them from Gmail.";
    }
  }

  var IMPORT_MAX = 25 * 1024 * 1024;
  /** Is this plausibly a Google contacts export? (name/size only; the parsing is not ours) */
  function checkImportFile(f) {
    if (!f) return { ok: false, why: "No file chosen." };
    var name = str(f.name).toLowerCase();
    if (!/\.(csv|vcf|vcard)$/.test(name)) return { ok: false, why: "Choose the .csv or .vcf file Google Contacts exported." };
    if (!(f.size > 0)) return { ok: false, why: "That file is empty." };
    if (f.size > IMPORT_MAX) return { ok: false, why: "That file is larger than 25 MB." };
    return { ok: true, why: "" };
  }
  function importSummary(r) {
    if (!r || typeof r !== "object") return "Import finished.";
    var parts = [];
    [["added", "new"], ["created", "new"], ["merged", "merged"], ["updated", "updated"], ["skipped", "skipped"], ["conflicts", "left out to avoid joining two people"]].forEach(function (p) {
      if (typeof r[p[0]] === "number" && !parts.some(function (x) { return x.label === p[1]; })) {
        parts.push({ label: p[1], n: r[p[0]] });
      }
    });
    parts = parts.filter(function (p) { return p.n > 0; });
    if (!parts.length) {
      if (typeof r.total === "number" && r.total > 0) return "Imported " + r.total + " contacts.";
      return typeof r.added === "number" ? "Nothing new in that file." : "Import finished.";
    }
    return "Imported: " + parts.map(function (p) { return p.n + " " + p.label; }).join(", ") + ".";
  }

  /** Plain words for a rejected link(); the store changes nothing when it rejects. */
  function linkError(e) {
    var code = e && typeof e === "object" ? str(e.code) : "";
    if (code === "conflict") return "That would join two different people, so nothing was changed.";
    if (code === "not-found") return "That contact is no longer there. Nothing was changed.";
    if (code === "limit") return "This contact is at its limit. Nothing was changed.";
    if (code === "invalid") return "That was not accepted. Nothing was changed.";
    return "That could not be saved. Nothing was changed.";
  }

  root.__hyphaeContactsLogic = {
    STATUSES: STATUSES, WORD: WORD, COLORS: C, STATUS_COLOR: STATUS_COLOR, PAIRS: PAIRS,
    contrast: contrast, emailKey: emailKey, isEmail: isEmail, fold: fold,
    tidyOne: tidyOne, tidy: tidy, displayName: displayName, titleWord: titleWord,
    matches: matches, counts: counts, sortContacts: sortContacts, view: view,
    annotate: annotate, annotateText: annotateText,
    primaryAction: primaryAction, explain: explain,
    checkImportFile: checkImportFile, importSummary: importSummary, linkError: linkError, SORT_KEYS: SORT_KEYS
  };

  // =========================================================================
  // The page part. Only on mail.google.com (or a test page that says so).
  // =========================================================================

  var L = root.__hyphaeContactsLogic;
  var hostOk = typeof document !== "undefined" && typeof location !== "undefined" &&
    (location.hostname === "mail.google.com" || root.__hyphaeContactsTest === true);

  var cache = { contacts: [], loaded: false, circleNames: {}, circleList: null };
  var loading = null;

  function port() { return root.__hyphaeContactsPort || null; }
  function has(fn) { var p = port(); return !!(p && typeof p[fn] === "function"); }

  /** Load (or reload) everything the sheet shows. Resolves to the contact count. */
  function load() {
    if (!has("all")) { cache.loaded = false; return Promise.reject(new Error("no-port")); }
    var mine = loading = Promise.resolve().then(function () { return port().all(); }).then(function (list) {
      cache.contacts = L.tidy(list);
      cache.loaded = true;
      if (!has("circles")) return null;
      return Promise.resolve(port().circles()).then(function (cs) {
        var names = {}, listed = [];
        (Array.isArray(cs) ? cs : []).forEach(function (c) {
          if (c && typeof c.kid === "string") { names[c.kid] = str(c.name) || c.kid; listed.push({ kid: c.kid, name: names[c.kid] }); }
        });
        cache.circleNames = names;
        cache.circleList = listed;
      }, function () { cache.circleList = null; });
    }).then(function () { return cache.contacts.length; });
    mine.then(function () { if (loading === mine) loading = null; }, function () { if (loading === mine) loading = null; });
    return mine;
  }

  // ---- compose --------------------------------------------------------------

  function fire(el) {
    ["mousedown", "mouseup", "click"].forEach(function (t) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
  }
  function openGmailCompose() {
    var open = document.querySelector('div[gh="cm"]') || document.querySelector('div[role="button"][aria-label="Compose"]');
    if (!open) return false;
    fire(open);
    return true;
  }
  function resolveEmail(target) {
    if (typeof target === "string") {
      var k = L.emailKey(target);
      if (k) return k;
      var byId = cache.contacts.filter(function (c) { return c.id === target; })[0];
      return byId ? byId.emails[0] || "" : "";
    }
    if (target && typeof target === "object") {
      return L.emailKey(target.email) || L.emailKey(Array.isArray(target.emails) ? target.emails[0] : "") || "";
    }
    return "";
  }
  /**
   * Open Gmail's compose with this person in To and hyphae encryption on. The
   * filling and the switching-on belong to gmail.js (window.__hyphaeGmail.composeTo);
   * without it, compose is opened and nothing is copied.
   */
  function resolveKid(target, email) {
    var k = target && typeof target === "object" ? str(target.circleKid) : "";
    if (k) return k;
    for (var i = 0; i < cache.contacts.length; i++) {
      var c = cache.contacts[i];
      if (c.circleKid && c.emails.indexOf(email) >= 0) return c.circleKid;
    }
    return "";
  }
  function composeTo(target) {
    var email = resolveEmail(target);
    if (!email) return Promise.resolve({ ok: false, via: null, filled: false, opened: false, email: "", why: "no-email" });
    var g = root.__hyphaeGmail;
    if (g && typeof g.composeTo === "function") {
      // The second argument names the circle this person's key opens, so the
      // message is sealed to them and not to whichever circle is active.
      var kid = resolveKid(target, email);
      return Promise.resolve().then(function () { return kid ? g.composeTo(email, { circleKid: kid }) : g.composeTo(email); }).then(function () {
        return { ok: true, via: "hook", filled: true, opened: true, email: email };
      }, function () {
        var opened = openGmailCompose();
        return { ok: opened, via: "fallback", filled: false, opened: opened, email: email, why: "hook-failed" };
      });
    }
    var opened = openGmailCompose();
    return Promise.resolve({ ok: opened, via: "fallback", filled: false, opened: opened, email: email, why: opened ? "no-hook" : "no-compose-button" });
  }

  // ---- the sheet ------------------------------------------------------------

  var FONT = "'Helvetica Neue','SF Pro Display',ui-sans-serif,system-ui,sans-serif";
  var MAX_ROWS = 250;
  var HEADS = [
    { key: "name", label: "Name", cls: "c-name" },
    { key: "email", label: "Email", cls: "c-email" },
    { key: "matrix", label: "Matrix ID", cls: "c-mx" },
    { key: "status", label: "Status", cls: "c-status" },
    { key: "circle", label: "Circle", cls: "c-circle" }
  ];
  var CHIPS = [
    { key: "all", label: "All" },
    { key: "ready", label: "Ready" },
    { key: "needs-key", label: "Needs key" },
    { key: "matrix-only", label: "Matrix only" },
    { key: "google-only", label: "Google only" }
  ];
  var INVITE_TEXT = [
    "Nothing has been sent, and nothing will be sent from this sheet.",
    "To write to this person sealed, two things have to be true: they use hyphae too, and you hand them a key — by Signal, in person, or as a file, never by email.",
    "Inviting people from here is not built yet. Until it is, tell them about hyphae yourself."
  ];

  var ui = null;        // built on first open
  var st = {
    open: false, q: "", status: "all", sortKey: "name", sortDir: "asc",
    activeId: null, subview: null, limit: MAX_ROWS, extra: null, shown: [],
    error: "", note: "", restoreFocus: null, searchSeq: 0, searchTimer: 0
  };

  function CSS() {
    var c = C;
    return [
      ":host{all:initial}",
      "*{box-sizing:border-box}",
      "[hidden]{display:none!important}",
      ".scrim{position:fixed;inset:0;background:transparent}",
      ".panel{position:fixed;top:64px;right:0;bottom:0;width:min(880px,100vw);display:flex;flex-direction:column;",
      "background:" + c.ground + ";color:" + c.text + ";font:300 13px/1.45 " + FONT + ";",
      "border-left:1px solid " + c.rule + ";border-top:1px solid " + c.rule + ";border-top-left-radius:14px;",
      "box-shadow:-10px 0 34px rgba(0,0,0,.35);transition:opacity .12s ease}",
      ".cap{font-size:10px;font-weight:400;letter-spacing:.28em;text-transform:uppercase;color:" + c.lav + "}",
      ".head{display:flex;align-items:center;gap:14px;padding:14px 18px 10px}",
      ".mark{position:relative;display:inline-block;width:22px;height:18px;color:" + c.lav + ";font:300 17px/18px " + FONT + "}",
      ".mark span{position:absolute;top:0}",
      ".mark .h{left:0}.mark .y{left:6px;opacity:.85}",
      ".word{color:" + c.lav + "}",
      ".title{font-size:14px;font-weight:400;color:" + c.text + "}",
      ".not{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:" + c.muted + "}",
      ".hint{font-size:11px;color:" + c.muted + "}",
      ".grow{flex:1}",
      "button{font:inherit;font-size:12px;color:" + c.lav + ";background:transparent;border:1px solid " + c.rule + ";",
      "border-radius:8px;padding:6px 12px;cursor:pointer}",
      "button:hover{border-color:" + c.btn + "}",
      "button.primary{background:" + c.btn + ";border-color:" + c.btn + ";color:" + c.ground + "}",
      "button.primary:hover{background:#a79fc6}",
      "button:disabled{opacity:.5;cursor:default}",
      ":focus{outline:none}",
      ":focus-visible{outline:2px solid " + c.lavHi + ";outline-offset:1px}",
      ".bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:4px 18px 10px}",
      ".search{flex:1 1 220px;min-width:180px;font:inherit;font-size:13px;color:" + c.text + ";background:" + c.field + ";",
      "border:1px solid " + c.rule + ";border-radius:8px;padding:7px 10px}",
      ".search::placeholder{color:" + c.muted + "}",
      ".chips{display:flex;flex-wrap:wrap;gap:6px}",
      ".chip{border-radius:999px;padding:4px 11px;font-size:12px}",
      ".chip[aria-pressed=true]{background:" + c.select + ";border-color:" + c.lav + ";color:" + c.text + "}",
      ".chip .n{color:" + c.cell + ";margin-left:5px}",
      ".chip[aria-pressed=true] .n{color:" + c.lav + "}",
      ".import{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 12px;padding:0 18px 10px;font-size:12px;color:" + c.muted + "}",
      ".msg{font-size:11px;color:" + c.lav + "}",
      ".msg.err{color:" + c.amber + "}",
      ".wrap{flex:1;min-height:0;overflow:auto;border-top:1px solid " + c.rule + "}",
      "table{border-collapse:separate;border-spacing:0;width:100%;table-layout:fixed}",
      "thead th{position:sticky;top:0;z-index:1;background:" + c.ground + ";border-bottom:1px solid " + c.rule + ";",
      "text-align:left;font-weight:400;padding:0}",
      "thead th button{all:unset;box-sizing:border-box;display:block;width:100%;padding:9px 12px;cursor:pointer;",
      "font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:" + c.lav + "}",
      "thead th button:focus-visible{outline:2px solid " + c.lavHi + ";outline-offset:-2px}",
      "thead th .dir{letter-spacing:.08em;text-transform:none;color:" + c.muted + ";margin-left:8px}",
      ".c-name{width:25%}.c-email{width:29%}.c-mx{width:22%}.c-status{width:12%}.c-circle{width:12%}",
      "td{padding:7px 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-bottom:1px solid " + c.rule + ";color:" + c.cell + "}",
      "td.name{color:" + c.text + "}",
      "tr.row{cursor:default}",
      "tr.row:hover td{background:" + c.select + "}",
      "tr.row[aria-selected=true] td{background:" + c.select + "}",
      "tr.row[aria-selected=true] td:first-child{box-shadow:inset 2px 0 0 " + c.lav + "}",
      "tr.row:focus-visible{outline:2px solid " + c.lavHi + ";outline-offset:-2px}",
      "td.status{letter-spacing:.02em}",
      ".more td{text-align:center;color:" + c.lav + ";border-bottom:0}",
      ".more button{border:0;padding:4px 8px;text-decoration:underline}",
      ".empty{padding:28px 18px;color:" + c.cell + ";max-width:520px}",
      ".foot{display:flex;flex-wrap:wrap;gap:4px 16px;padding:8px 18px;border-top:1px solid " + c.rule + ";font-size:11px;color:" + c.muted + "}",
      ".pane{border-top:1px solid " + c.rule + ";padding:12px 18px 14px;max-height:42%;overflow:auto}",
      ".pane h2{margin:0 0 4px;font-size:13px;font-weight:400;color:" + c.text + "}",
      ".pane p{margin:4px 0;font-size:12px;color:" + c.cell + ";max-width:640px}",
      ".pane .who{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}",
      ".acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center}",
      ".pane label{display:block;font-size:12px;color:" + c.lav + ";margin:8px 0 4px}",
      ".pane input[type=email],.pane select{font:inherit;font-size:13px;color:" + c.text + ";background:" + c.field + ";",
      "border:1px solid " + c.rule + ";border-radius:8px;padding:6px 9px;min-width:260px}",
      "input[type=radio]{accent-color:" + c.btn + ";margin:0}",
      ".radio{display:flex;align-items:center;gap:8px;padding:4px 0;color:" + c.text + ";font-size:13px;margin:0}",
      ".toast{position:fixed;left:16px;bottom:16px;max-width:380px;background:" + c.ground + ";color:" + c.text + ";",
      "border:1px solid " + c.rule + ";border-radius:14px;padding:11px 14px;font:300 12px/1.45 " + FONT + ";",
      "box-shadow:0 10px 34px rgba(0,0,0,.4)}",
      ".toast .cap{display:block;margin-bottom:4px}",
      "@media (max-width:700px){.c-mx,.c-circle{display:none}.c-name{width:36%}.c-email{width:34%}.c-status{width:30%}.panel{top:0;border-radius:0}}",
      "@media (prefers-reduced-motion:reduce){.panel{transition:none}*{scroll-behavior:auto!important}}"
    ].join("");
  }

  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (kid) {
      if (kid === null || kid === undefined) return;
      n.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    });
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function build() {
    var host = document.createElement("div");
    host.setAttribute("data-hyphae-contacts", "");
    host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647";
    var shadow = host.attachShadow({ mode: "closed" });
    shadow.appendChild(el("style", { text: CSS() }));

    var scrim = el("div", { class: "scrim", onmousedown: function () { close(); } });

    var closeBtn = el("button", { type: "button", text: "Close", "aria-label": "Close contacts (Escape)", onclick: function () { close(); } });
    var head = el("div", { class: "head" }, [
      el("span", { class: "mark", "aria-hidden": "true" }, [el("span", { class: "h", text: "h" }), el("span", { class: "y", text: "y" })]),
      el("span", { class: "cap word", text: "hyphae" }),
      el("span", { class: "title", id: "ttl", text: "Contacts" }),
      el("span", { class: "not", text: "not part of Gmail" }),
      el("span", { class: "grow" }),
      closeBtn
    ]);

    var search = el("input", {
      type: "text", class: "search", autocomplete: "off", spellcheck: "false",
      "aria-label": "Search contacts", placeholder: "Search name, email, Matrix ID, status   ( / )",
      oninput: function () { st.q = search.value; st.limit = MAX_ROWS; storeSearch(); render(); }
    });
    var chips = el("div", { class: "chips", role: "group", "aria-label": "Filter by status" });
    var bar = el("div", { class: "bar" }, [search, chips]);

    var fileInput = el("input", {
      type: "file", accept: ".csv,.vcf,.vcard,text/csv,text/vcard,text/x-vcard", hidden: true, tabindex: "-1",
      "aria-label": "Google Contacts export file", onchange: function () { onFile(fileInput); }
    });
    var importBtn = el("button", { type: "button", text: "Import from Google Contacts", onclick: function () { fileInput.click(); } });
    var importBar = el("div", { class: "import" }, [
      importBtn, fileInput,
      el("span", { text: "In Google Contacts, Export, then Google CSV or vCard. The file is read here, on this device; nothing leaves it." })
    ]);

    var msg = el("div", { class: "msg", role: "status", "aria-live": "polite", hidden: true });

    var headRow = el("tr", { role: "row" });
    var thead = el("thead", null, [headRow]);
    var tbody = el("tbody");
    var table = el("table", { role: "grid", "aria-labelledby": "ttl", "aria-describedby": "keys" }, [thead, tbody]);
    var wrap = el("div", { class: "wrap" }, [table]);
    var empty = el("div", { class: "empty", hidden: true });

    var count = el("span", { role: "status", "aria-live": "polite" });
    var foot = el("div", { class: "foot" }, [
      count, msg,
      el("span", { id: "keys", text: "Up and Down move · Enter acts · / searches · Esc closes" })
    ]);
    var pane = el("div", { class: "pane", role: "region", "aria-label": "Selected contact", hidden: true });

    var panel = el("section", { class: "panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "ttl", hidden: true },
      [head, bar, importBar, wrap, empty, pane, foot]);
    var toast = el("div", { class: "toast", role: "status", "aria-live": "polite", hidden: true });

    shadow.appendChild(scrim);
    shadow.appendChild(panel);
    shadow.appendChild(toast);

    // Gmail has single-key shortcuts and its own focus handling: nothing typed
    // or clicked in here is allowed to reach it.
    ["keydown", "keyup", "keypress", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "input", "wheel"]
      .forEach(function (t) { host.addEventListener(t, function (e) { e.stopPropagation(); }); });

    panel.addEventListener("keydown", onKey);
    tbody.addEventListener("click", onRowClick);
    tbody.addEventListener("dblclick", function (e) { var c = rowContact(e.target); if (c) act(c); });

    return {
      host: host, shadow: shadow, panel: panel, scrim: scrim, search: search, chips: chips, tbody: tbody, thead: thead,
      headRow: headRow, wrap: wrap, empty: empty, count: count, pane: pane, msg: msg, toast: toast,
      closeBtn: closeBtn, importBtn: importBtn, fileInput: fileInput, toastTimer: 0
    };
  }

  // ---- state -> DOM ---------------------------------------------------------

  function current() {
    return L.view(cache.contacts, {
      q: st.q, status: st.status, sortKey: st.sortKey, sortDir: st.sortDir,
      extraIds: st.extra, circleNames: cache.circleNames
    });
  }
  function byId(id) {
    for (var i = 0; i < cache.contacts.length; i++) if (cache.contacts[i].id === id) return cache.contacts[i];
    return null;
  }

  function paintChips(counts) {
    clear(ui.chips);
    CHIPS.forEach(function (ch) {
      var b = el("button", {
        type: "button", class: "chip", "aria-pressed": st.status === ch.key ? "true" : "false",
        "aria-label": ch.label + ", " + counts[ch.key],
        onclick: function () { st.status = (st.status === ch.key ? "all" : ch.key); st.limit = MAX_ROWS; render(); }
      }, [ch.label, el("span", { class: "n", text: String(counts[ch.key]) })]);
      ui.chips.appendChild(b);
    });
  }

  function paintHead() {
    clear(ui.headRow);
    HEADS.forEach(function (h) {
      var active = st.sortKey === h.key;
      var dir = active ? (st.sortDir === "asc" ? "a–z" : "z–a") : "";
      if (active && h.key === "status") dir = st.sortDir === "asc" ? "most ready first" : "least ready first";
      var b = el("button", {
        type: "button",
        "aria-label": "Sort by " + h.label + (active ? ", now " + (st.sortDir === "asc" ? "ascending" : "descending") : ""),
        onclick: function () {
          if (st.sortKey === h.key) st.sortDir = st.sortDir === "asc" ? "desc" : "asc";
          else { st.sortKey = h.key; st.sortDir = "asc"; }
          render();
        }
      }, [h.label, active ? el("span", { class: "dir", text: dir }) : null]);
      ui.headRow.appendChild(el("th", {
        class: h.cls, scope: "col", role: "columnheader",
        "aria-sort": active ? (st.sortDir === "asc" ? "ascending" : "descending") : "none"
      }, [b]));
    });
  }

  function paintRows() {
    clear(ui.tbody);
    var rows = st.shown.slice(0, st.limit);
    rows.forEach(function (c, i) {
      var active = c.id === st.activeId;
      var mx = c.matrix ? c.matrix.mxid : "";
      var circle = c.circleKid ? (cache.circleNames[c.circleKid] || c.circleKid.slice(0, 8)) : "";
      var statusCell = el("td", { class: "status c-status", role: "gridcell", text: L.titleWord(c.status) });
      statusCell.style.color = L.STATUS_COLOR[c.status];
      var tr = el("tr", {
        class: "row", role: "row", "data-id": c.id, "aria-rowindex": String(i + 2),
        "aria-selected": active ? "true" : "false", tabindex: active ? "0" : "-1"
      }, [
        el("td", { class: "name c-name", role: "gridcell", text: L.displayName(c), title: L.displayName(c) }),
        el("td", { class: "c-email", role: "gridcell", text: c.emails[0] ? c.emails[0] + (c.emails.length > 1 ? "  +" + (c.emails.length - 1) : "") : "", title: c.emails.join(", ") }),
        el("td", { class: "c-mx", role: "gridcell", text: mx, title: mx }),
        statusCell,
        el("td", { class: "c-circle", role: "gridcell", text: circle, title: circle })
      ]);
      ui.tbody.appendChild(tr);
    });
    if (st.shown.length > rows.length) {
      var more = el("button", {
        type: "button",
        onclick: function () { st.limit += MAX_ROWS; render(); }
      }, ["Show " + Math.min(MAX_ROWS, st.shown.length - rows.length) + " more of " + (st.shown.length - rows.length)]);
      ui.tbody.appendChild(el("tr", { class: "more", role: "row" }, [el("td", { colspan: "5", role: "gridcell" }, [more])]));
    }
  }

  function paintSelection() {
    var rows = ui.tbody.querySelectorAll("tr.row");
    for (var i = 0; i < rows.length; i++) {
      var on = rows[i].getAttribute("data-id") === st.activeId;
      rows[i].setAttribute("aria-selected", on ? "true" : "false");
      rows[i].setAttribute("tabindex", on ? "0" : "-1");
    }
  }

  function rowEl(id) {
    var rows = ui.tbody.querySelectorAll("tr.row");
    for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute("data-id") === id) return rows[i];
    return null;
  }
  function rowContact(node) {
    var n = node;
    while (n && n !== ui.tbody) {
      if (n.getAttribute && n.getAttribute("data-id")) return byId(n.getAttribute("data-id"));
      n = n.parentNode;
    }
    return null;
  }

  function setMessage(text, isErr) {
    st.note = text || "";
    ui.msg.hidden = !text;
    ui.msg.textContent = text || "";
    ui.msg.className = "msg" + (isErr ? " err" : "");
  }

  function render() {
    if (!ui) return;
    var v = current();
    st.shown = v.rows;
    if (!st.shown.some(function (c) { return c.id === st.activeId; })) {
      st.activeId = st.shown.length ? st.shown[0].id : null;
      if (st.subview && (!st.activeId || st.subview.id !== st.activeId)) st.subview = null;
    }
    paintChips(v.counts);
    paintHead();
    paintRows();

    var hasAny = cache.contacts.length > 0;
    ui.wrap.hidden = !hasAny || !st.shown.length;
    ui.empty.hidden = ui.wrap.hidden ? false : true;
    clear(ui.empty);
    if (st.error) {
      ui.empty.textContent = st.error;
    } else if (!cache.loaded) {
      ui.empty.textContent = "Loading contacts…";
    } else if (!hasAny) {
      ui.empty.textContent = "No contacts yet. Import your Google contacts above, or connect with someone over Matrix and they will appear here.";
    } else if (!st.shown.length) {
      ui.empty.textContent = "No one matches that.";
    }
    var shownN = st.shown.length;
    ui.count.textContent = !hasAny ? "" :
      (shownN === v.total ? shownN + " contacts" : shownN + " of " + v.total + " contacts");
    renderPane();
  }

  // ---- the pane: what to do about the active contact ------------------------

  function renderPane() {
    var c = st.activeId ? byId(st.activeId) : null;
    clear(ui.pane);
    if (!c) { ui.pane.hidden = true; return; }
    ui.pane.hidden = false;
    var sv = st.subview && st.subview.id === c.id ? st.subview : null;
    var who = el("div", { class: "who" }, [
      el("h2", { text: L.displayName(c) }),
      el("span", { class: "cap", text: L.titleWord(c.status) }),
      c.matrix ? el("span", { class: "hint", text: c.matrix.mxid }) : null
    ]);
    who.childNodes[1].style.color = L.STATUS_COLOR[c.status];
    ui.pane.appendChild(who);

    if (!sv) { paneDefault(c); return; }
    if (sv.kind === "invite") paneInvite(c);
    else if (sv.kind === "link-key") paneLinkKey(c, sv);
    else if (sv.kind === "add-email") paneAddEmail(c);
  }

  function backBtn() {
    return el("button", { type: "button", "data-back": "", text: "Back", onclick: function () { st.subview = null; renderPane(); focusRow(); } });
  }

  function paneDefault(c) {
    var pa = L.primaryAction(c);
    ui.pane.appendChild(el("p", { text: L.explain(c) }));
    var acts = el("div", { class: "acts" });
    if (pa.kind === "compose") {
      acts.appendChild(el("button", {
        type: "button", class: "primary", text: pa.label,
        onclick: function () { doCompose(c, c.emails[0]); }
      }));
      if (c.emails.length > 1) acts.appendChild(el("span", { class: "hint", text: "To " + c.emails[0] }));
      c.emails.slice(1).forEach(function (addr) {
        acts.appendChild(el("button", { type: "button", text: "Use " + addr, onclick: function () { doCompose(c, addr); } }));
      });
    } else {
      acts.appendChild(el("button", {
        type: "button", class: "primary", text: pa.label,
        onclick: function () { act(c); }
      }));
      if (pa.kind === "invite") {
        acts.appendChild(el("span", { class: "hint", text: "Opens an explanation. Sends nothing." }));
      }
    }
    if (c.status === "ready" && !c.emails.length) { /* the primary is already "Add an email address" */ }
    ui.pane.appendChild(acts);
  }

  function paneInvite(c) {
    INVITE_TEXT.forEach(function (t) { ui.pane.appendChild(el("p", { text: t })); });
    ui.pane.appendChild(el("div", { class: "acts" }, [backBtn()]));
  }

  function paneLinkKey(c, sv) {
    ui.pane.appendChild(el("p", { text: "The key must be handed over by Signal, in person, or as a file — never by email. Once you hold it, choose the circle it opens." }));
    var list = cache.circleList;
    if (!list || !list.length) {
      ui.pane.appendChild(el("p", { text: list ? "No circles on this device yet. Make one in hyphae, or receive one, then come back." : "The circle list is not available here yet." }));
      ui.pane.appendChild(el("div", { class: "acts" }, [backBtn()]));
      return;
    }
    var group = el("div", { role: "radiogroup", "aria-label": "Circle to link to " + L.displayName(c) });
    list.forEach(function (ci, i) {
      var input = el("input", { type: "radio", name: "circle", value: ci.kid, id: "ci" + i });
      if (sv.kid === ci.kid) input.checked = true;
      input.addEventListener("change", function () { sv.kid = ci.kid; linkBtn.disabled = false; });
      group.appendChild(el("label", { class: "radio", for: "ci" + i }, [input, ci.name]));
    });
    ui.pane.appendChild(group);
    var linkBtn = el("button", {
      type: "button", class: "primary", text: "Link this key", disabled: !sv.kid,
      onclick: function () { doLink(c, { circleKid: sv.kid }, "Linked."); }
    });
    ui.pane.appendChild(el("div", { class: "acts" }, [linkBtn, backBtn()]));
  }

  function paneAddEmail(c) {
    var input = el("input", { type: "email", id: "addr", autocomplete: "off", spellcheck: "false", "aria-describedby": "addr-note" });
    var note = el("p", { id: "addr-note", class: "hint", text: "Stored on this device with this contact. Nothing is sent." });
    var save = el("button", {
      type: "button", class: "primary", text: "Save address",
      onclick: function () {
        var v = L.emailKey(input.value);
        if (!L.isEmail(input.value) || !v) { note.textContent = "That does not look like an email address."; input.focus(); return; }
        doLink(c, { email: v }, "Address saved.");
      }
    });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); save.click(); } });
    ui.pane.appendChild(el("label", { for: "addr", text: "Email address for " + L.displayName(c) }));
    ui.pane.appendChild(input);
    ui.pane.appendChild(note);
    ui.pane.appendChild(el("div", { class: "acts" }, [save, backBtn()]));
  }

  // ---- acting ---------------------------------------------------------------

  function act(c) {
    var pa = L.primaryAction(c);
    if (pa.kind === "compose") return doCompose(c, c.emails[0]);
    st.subview = { id: c.id, kind: pa.kind, kid: c.circleKid || null };
    renderPane();
    var first = ui.pane.querySelector("input:not([type=hidden]),button[data-back]");
    if (first) first.focus();
  }

  function doCompose(c, email) {
    return composeTo({ id: c.id, email: email, circleKid: c.circleKid }).then(function (r) {
      close();
      if (r.via === "hook" && r.ok) return;
      if (!r.opened) {
        toast("Gmail's Compose button was not found. Open a new message and add " + email + " to To.");
      } else {
        toast("Compose is open. hyphae could not fill it in: add " + email + " to To, then switch encryption on.");
      }
    });
  }

  function doLink(c, patch, done) {
    if (!has("link")) { setMessage("Saving is not available here yet.", true); return; }
    setMessage("Saving…");
    Promise.resolve().then(function () { return port().link(c.id, patch); }).then(function () {
      st.subview = null;
      return load().then(function () { render(); setMessage(done); focusRow(); });
    }, function (e) { setMessage(L.linkError(e), true); });
  }

  function onFile(input) {
    var f = input.files && input.files[0];
    var chk = L.checkImportFile(f);
    if (!chk.ok) { setMessage(chk.why, true); input.value = ""; return; }
    if (!has("importGoogleCsv")) { setMessage("Import is not available here yet.", true); input.value = ""; return; }
    setMessage("Reading " + f.name + " on this device…");
    var read = typeof f.text === "function" ? f.text() : new Promise(function (res, rej) {
      var r = new FileReader(); r.onload = function () { res(String(r.result)); }; r.onerror = rej; r.readAsText(f);
    });
    read.then(function (text) { return port().importGoogleCsv(text); }).then(function (summary) {
      input.value = "";
      return load().then(function () { render(); setMessage(L.importSummary(summary)); });
    }, function () { input.value = ""; setMessage("That file could not be imported.", true); });
  }

  function toast(text) {
    if (!ui) return;
    clear(ui.toast);
    ui.toast.appendChild(el("span", { class: "cap", text: "hyphae" }));
    ui.toast.appendChild(document.createTextNode(text));
    ui.toast.hidden = false;
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(function () { ui.toast.hidden = true; }, 9000);
  }

  // ---- keyboard, focus ------------------------------------------------------

  function focusRow() {
    var r = st.activeId ? rowEl(st.activeId) : null;
    if (r) r.focus(); else ui.search.focus();
  }
  function move(to) {
    if (!st.shown.length) return;
    var visible = Math.min(st.shown.length, st.limit);
    var i = 0;
    for (var k = 0; k < visible; k++) if (st.shown[k].id === st.activeId) { i = k; break; }
    var n = Math.max(0, Math.min(visible - 1, to(i, visible)));
    var changed = st.shown[n].id !== st.activeId;
    st.activeId = st.shown[n].id;
    if (changed && st.subview && st.subview.id !== st.activeId) st.subview = null;
    paintSelection();
    renderPane();
    var r = rowEl(st.activeId);
    if (r) { r.focus(); if (r.scrollIntoView) r.scrollIntoView({ block: "nearest" }); }
  }

  function focusables() {
    var all = ui.panel.querySelectorAll('button, input, select, [tabindex="0"]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n.disabled || n.type === "hidden" || n.getAttribute("tabindex") === "-1" && n.tagName !== "TR") continue;
      if (n.tagName === "TR" && n.getAttribute("tabindex") !== "0") continue;
      var hiddenUp = false;
      for (var p = n; p && p !== ui.panel; p = p.parentNode) if (p.hidden) { hiddenUp = true; break; }
      if (!hiddenUp) out.push(n);
    }
    return out;
  }

  function onKey(e) {
    var inField = e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") && e.target.type !== "radio";
    if (e.key === "Tab") {
      var f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      var cur = ui.shadow.activeElement;
      var i = f.indexOf(cur);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (st.subview) { st.subview = null; renderPane(); focusRow(); return; }
      if (e.target === ui.search && ui.search.value) { ui.search.value = ""; st.q = ""; render(); return; }
      close();
      return;
    }
    if (e.key === "/" && !inField) { e.preventDefault(); ui.search.focus(); ui.search.select(); return; }
    if (e.target === ui.search) {
      if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault(); focusRow(); }
      return;
    }
    if (e.target && e.target.getAttribute && e.target.getAttribute("data-id") !== null && e.target.tagName === "TR") {
      var handled = true;
      if (e.key === "ArrowDown") move(function (i) { return i + 1; });
      else if (e.key === "ArrowUp") move(function (i) { return i - 1; });
      else if (e.key === "Home") move(function () { return 0; });
      else if (e.key === "End") move(function (i, n) { return n - 1; });
      else if (e.key === "PageDown") move(function (i) { return i + 10; });
      else if (e.key === "PageUp") move(function (i) { return i - 10; });
      else if (e.key === "Enter") { var c = byId(st.activeId); if (c) act(c); }
      else handled = false;
      if (handled) e.preventDefault();
    }
  }

  function onRowClick(e) {
    var c = rowContact(e.target);
    if (!c) return;
    if (st.activeId !== c.id) {
      st.activeId = c.id;
      if (st.subview && st.subview.id !== c.id) st.subview = null;
      paintSelection();
      renderPane();
    }
    var r = rowEl(c.id);
    if (r) r.focus();
  }

  function storeSearch() {
    // Ask the store too, and union its answer: it may match things the sheet
    // cannot see (nicknames, merged records). The local filter stays instant.
    clearTimeout(st.searchTimer);
    var q = st.q.trim();
    if (!q || !has("search")) { st.extra = null; return; }
    var seq = ++st.searchSeq;
    st.searchTimer = setTimeout(function () {
      Promise.resolve().then(function () { return port().search(q); }).then(function (list) {
        if (seq !== st.searchSeq || st.q.trim() !== q) return;
        var found = L.tidy(list), ids = {};
        found.forEach(function (c) {
          ids[c.id] = true;
          if (!byId(c.id)) cache.contacts.push(c);
        });
        st.extra = ids;
        render();
      }, function () { /* the local filter already answered */ });
    }, 140);
  }

  function trapFocus(e) {
    if (!st.open || !ui) return;
    if (e.target === ui.host) return;
    var f = focusables();
    var target = st.activeId && rowEl(st.activeId) || ui.search;
    (target || f[0]).focus();
  }

  // ---- public ---------------------------------------------------------------

  function open() {
    if (!hostOk) return Promise.resolve(false);
    if (!ui) {
      ui = build();
      (document.body || document.documentElement).appendChild(ui.host);
    }
    if (st.open) { ui.search.focus(); return Promise.resolve(true); }
    st.open = true;
    st.restoreFocus = document.activeElement;
    ui.panel.hidden = false;
    ui.scrim.hidden = false;
    document.addEventListener("focusin", trapFocus, true);
    render();
    ui.search.focus();
    return load().then(function () { st.error = ""; render(); return true; }, function () {
      st.error = "Contacts are not available here yet.";
      render();
      return true;
    });
  }

  function close() {
    if (!ui || !st.open) return;
    st.open = false;
    st.subview = null;
    ui.panel.hidden = true;
    ui.scrim.hidden = true;
    document.removeEventListener("focusin", trapFocus, true);
    var back = st.restoreFocus;
    st.restoreFocus = null;
    if (back && back.isConnected && typeof back.focus === "function") { try { back.focus(); } catch (e) { /* page's business */ } }
  }

  function refresh() {
    return load().then(function (n) { st.error = ""; if (st.open) render(); return n; }, function () {
      if (ui && st.open) { st.error = "Contacts are not available here yet."; render(); }
      return 0;
    });
  }

  function annotateSync(emails) { return L.annotate(cache.contacts, emails); }
  function annotateTextSync(emails) { return L.annotateText(cache.contacts, emails); }
  function annotateAsync(emails) {
    var ready = cache.loaded ? Promise.resolve() : load().catch(function () { /* annotate with what we have */ });
    return ready.then(function () { return annotateSync(emails); });
  }

  root.__hyphaeContacts = {
    open: open,
    close: close,
    refresh: refresh,
    composeTo: composeTo,
    annotate: function (emails) {
      // Pure on the cache. A cold cache loads in the background so the next call is warm.
      if (!cache.loaded && !loading && has("all")) load().catch(function () { /* later */ });
      return annotateSync(emails);
    },
    annotateText: function (emails) {
      if (!cache.loaded && !loading && has("all")) load().catch(function () { /* later */ });
      return annotateTextSync(emails);
    },
    annotateAsync: annotateAsync
  };
})();
