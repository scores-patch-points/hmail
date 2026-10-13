/*
 * HyContacts — the contacts directory core for hyphae.
 *
 * A contact is a person you can reach two ways: an email address (Google
 * Contacts, a CSV) and a Matrix account you have connected with. The directory
 * joins the two so the extension can tell, per person, whether it can send
 * them encrypted content right now.
 *
 * This file is the model only: no DOM, no chrome.*, no network, no timers.
 * Storage is injected, so the same code runs in the service worker, a content
 * script and Node tests. Plain ES5-style UMD; registers `HyContacts` on `self`.
 *
 * ---------------------------------------------------------------------------
 * API (the contract the importer and the sheet code against)
 * ---------------------------------------------------------------------------
 *
 *   var store = HyContacts.create({ storage, now, key });
 *
 *     storage  { get(key) -> Promise<any>, set(key, value) -> Promise }
 *              Values are plain JSON. chrome.storage.local itself is NOT this
 *              shape (get returns {key: value}, set takes an object) — wrap it
 *              with HyContacts.fromChrome(chrome.storage.local).
 *     now      optional () => ms since epoch (default Date.now); injected for tests.
 *     key      optional storage key (default "hyContacts"). All state lives under
 *              this one key, so every write is atomic. Never "circles".
 *
 *   store.all()              Promise<Contact[]>       sorted by name (then id)
 *   store.byEmail(email)     Promise<Contact|null>    see "Email matching" below
 *   store.search(q)          Promise<Contact[]>       name, emails, mxid, Matrix
 *                                                     display name; every
 *                                                     whitespace-separated word
 *                                                     must match (case-insensitive,
 *                                                     substring). Empty q = all().
 *   store.importGoogle(list) Promise<ImportResult>    list: [{ name, emails:[string],
 *                                                     source?: "csv"|"api" }]
 *   store.importMatrix(list) Promise<ImportResult>    list: [{ mxid, displayName?,
 *                                                     emails?:[string] }]
 *   store.link(id, patch)    Promise<Contact>         patch: { mxid?, circleKid?,
 *                                                     email?, removeEmail? }.
 *                                                     A string sets, null clears.
 *                                                     REJECTS (Error with .code:
 *                                                     "not-found" | "invalid" |
 *                                                     "conflict" | "limit") rather
 *                                                     than guess; on rejection
 *                                                     nothing was changed.
 *   store.setHeldCircles(kids) Promise<{held, ignored}>  kids: array of circle ids
 *                                                     the user holds a key for.
 *                                                     Ids only — keys are never
 *                                                     passed in and never stored.
 *   store.remove(id)         Promise<boolean>         true if a contact was removed
 *
 *   ImportResult = { added, merged, skipped, conflicts }
 *     added      entries that created a new contact
 *     merged     entries that matched an existing contact (changed or not — an
 *                unchanged re-import reports merged == n, added == 0)
 *     skipped    entries ignored: malformed, no usable address/mxid, over the cap
 *     conflicts  entries where something was left out rather than merged because
 *                it would have joined two different people (see "Merging")
 *
 *   Contact = {
 *     id, name, emails: [string],
 *     matrix:    null | { mxid, displayName },
 *     circleKid: null | string,
 *     sources:   ["google" | "matrix" | "manual", ...],
 *     status,                       // computed on every read, never stored
 *     addressable,                  // computed: has at least one email
 *     updated                       // ms; only moves when the contact really changed
 *   }
 *
 *   name is derived: the name from Google if there is one, else the Matrix
 *   display name, else the first email, else the mxid.
 *
 *   status (first match wins; computed against the held circles at read time):
 *     "ready"       Matrix link AND circleKid is a circle the user holds
 *     "matrix-only" Matrix link, no email known (cannot address an email to them)
 *     "needs-key"   Matrix link, an email known, but no held circle for them
 *     "google-only" an email, no Matrix link (would need an invite)
 *
 *   NOTE the order: the contract defines "ready" by key + Matrix link alone, so
 *   a Matrix contact with no email but a held circle is "ready" with
 *   addressable === false. Check `addressable` before filling a To: field.
 *   "ready" means a key is HELD for this person's circle. It does not mean the
 *   person was verified, that the email address is theirs, or that the key
 *   reached them — see CORE-WIRING.md.
 *
 * ---------------------------------------------------------------------------
 * Rules enforced here
 * ---------------------------------------------------------------------------
 *
 * Email matching. Addresses are trimmed and lower-cased, nothing more. Gmail
 * dots and +tags are deliberately NOT collapsed (j.doe@, jdoe@, jdoe+x@) and
 * googlemail.com is not folded into gmail.com. Those rules hold only for
 * consumer Gmail; on any other host (or a Workspace domain) j.doe and jdoe can
 * be two people. Collapsing would merge strangers, and a wrong merge sends
 * encrypted content to the wrong person. A missed merge only costs a duplicate
 * row, which link() resolves explicitly.
 *
 * Merging. By normalised email first, then by exact mxid (server part
 * lower-cased, local part exact). Never by name: two people called "Alex Kim"
 * stay two contacts. A Matrix contact with no email joins a Google contact
 * only through a shared email in an import or an explicit link(). Two contacts
 * are never joined if they carry different mxids or different circleKids; the
 * entry is counted in `conflicts` and the offending field is left out.
 * An email belongs to at most one contact at a time.
 *
 * Idempotent imports. Re-importing a list changes nothing, `updated` included,
 * and writes nothing. Names are updated in place. Emails are only ever added
 * by imports, not removed — use link(id, { removeEmail }) for that.
 *
 * link() safety. Re-pointing a contact at a different Matrix account, or
 * unlinking it, also clears circleKid: the circle was assigned to that
 * identity, and keeping it would hand the old person's circle to the new one
 * unless the same patch sets circleKid again.
 *
 * Stores only: ids, names, emails, mxids, circle ids, timestamps. Never a key,
 * a token or message content. Text that looks like a hyphae token ("hy1.",
 * "hy1key.") or a key (a 43-char base64url run) is dropped on input, and
 * circle ids longer than 32 chars are refused (a kid is 11). Every stored
 * record is rebuilt field by field on load, so extra fields in storage are
 * scrubbed on the next write.
 *
 * Local only: no fetch, no XHR, no beacon, no timers, no analytics.
 *
 * Defensive input: malformed emails/mxids ignored; lists capped at
 * LIMITS.contacts; indexes are Maps (ids like "__proto__" are inert data).
 * Operations on one store are serialised. Two stores on the same storage
 * (worker + content script) each re-read before every operation, but
 * chrome.storage has no transactions: a write that lands between another
 * context's read and write can be lost. Do imports from one place (the worker).
 *
 * remove() is not sticky: importing the same person again re-adds them.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HyContacts = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  var LIMITS = {
    contacts: 20000,
    emailsPerContact: 10,
    emailsPerEntry: 50,
    name: 200,
    email: 254,
    mxid: 255,
    kid: 32,
    held: 5000,
    query: 200,
  };
  var SOURCES = ["google", "matrix", "manual"];
  var STATUS = { ready: "ready", needsKey: "needs-key", matrixOnly: "matrix-only", googleOnly: "google-only" };
  var DEFAULT_KEY = "hyContacts";
  var STATE_VERSION = 1;

  // ---- input hygiene -------------------------------------------------------

  var LOOKS_LIKE_SECRET = /hy1(?:key)?\.|[A-Za-z0-9_-]{43,}/;
  var EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
  var MXID_RE = /^@([A-Za-z0-9._=\/+-]{1,200}):([A-Za-z0-9.-]{1,200}(?::[0-9]{1,5})?)$/;
  var HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/;
  var KID_RE = /^[A-Za-z0-9_-]{1,32}$/;
  var ID_RE = /^c_[a-z0-9]{6,40}$/;

  function fail(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  /** Display text: control and bidi-override characters out, whitespace collapsed, capped. */
  function cleanText(s, max) {
    if (typeof s !== "string") return "";
    var t = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ").trim();
    if (!t || LOOKS_LIKE_SECRET.test(t)) return "";
    return t.slice(0, max);
  }

  /** trimmed + lower-cased address, or null if malformed. No Gmail dot/plus folding (see header). */
  function normalizeEmail(s) {
    if (typeof s !== "string") return null;
    var t = s.trim();
    if (!t || t.length > LIMITS.email || !EMAIL_RE.test(t) || LOOKS_LIKE_SECRET.test(t)) return null;
    var at = t.lastIndexOf("@");
    var local = t.slice(0, at);
    if (local.length > 64 || local.charAt(0) === "." || local.charAt(local.length - 1) === "." || local.indexOf("..") !== -1) return null;
    return t.toLowerCase();
  }

  /** "@local:server" with the server part lower-cased, or null. The local part is kept exact. */
  function normalizeMxid(s) {
    if (typeof s !== "string") return null;
    var t = s.trim();
    if (!t || t.length > LIMITS.mxid || LOOKS_LIKE_SECRET.test(t)) return null;
    var m = MXID_RE.exec(t);
    if (!m) return null;
    var host = m[2].toLowerCase();
    if (!HOST_RE.test(host)) return null;
    return "@" + m[1] + ":" + host;
  }

  /** circle id, or null. Longer than 32 chars is refused so a key can never pass as an id. */
  function normalizeKid(s) {
    if (typeof s !== "string") return null;
    var t = s.trim();
    return KID_RE.test(t) ? t : null;
  }

  function isObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

  // ---- state ----------------------------------------------------------------

  function newId(taken, now) {
    for (;;) {
      var r = "";
      var c = typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.getRandomValues;
      if (c) {
        var a = new Uint8Array(8);
        globalThis.crypto.getRandomValues(a);
        for (var i = 0; i < a.length; i++) r += (a[i] % 36).toString(36);
      } else {
        for (var j = 0; j < 8; j++) r += Math.floor(Math.random() * 36).toString(36);
      }
      var id = "c_" + r + (now % 46656).toString(36);
      if (!taken.has(id)) return id;
    }
  }

  function uniqueSources(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (s) {
      if (SOURCES.indexOf(s) !== -1 && out.indexOf(s) === -1) out.push(s);
    });
    return out;
  }

  /** Rebuild state from whatever storage returned. Nothing is copied wholesale. */
  function loadState(raw, nowMs) {
    var st = { items: new Map(), byEmail: new Map(), byMxid: new Map(), held: [] };
    if (!isObject(raw)) return st;
    var items = Array.isArray(raw.items) ? raw.items : [];
    for (var i = 0; i < items.length && st.items.size < LIMITS.contacts; i++) {
      var it = items[i];
      if (!isObject(it)) continue;
      var rec = {
        id: typeof it.id === "string" && ID_RE.test(it.id) && !st.items.has(it.id) ? it.id : newId(st.items, nowMs + i),
        name: cleanText(it.name, LIMITS.name),
        emails: [],
        matrix: null,
        circleKid: normalizeKid(it.circleKid),
        sources: uniqueSources(it.sources),
        updated: typeof it.updated === "number" && isFinite(it.updated) ? it.updated : 0,
      };
      (Array.isArray(it.emails) ? it.emails : []).forEach(function (e) {
        var n = normalizeEmail(e);
        if (n && rec.emails.length < LIMITS.emailsPerContact && rec.emails.indexOf(n) === -1 && !st.byEmail.has(n)) rec.emails.push(n);
      });
      if (isObject(it.matrix)) {
        var mx = normalizeMxid(it.matrix.mxid);
        if (mx && !st.byMxid.has(mx)) rec.matrix = { mxid: mx, displayName: cleanText(it.matrix.displayName, LIMITS.name) };
      }
      if (!rec.emails.length && !rec.matrix) continue; // nothing to reach them by
      st.items.set(rec.id, rec);
      rec.emails.forEach(function (e) { st.byEmail.set(e, rec); });
      if (rec.matrix) st.byMxid.set(rec.matrix.mxid, rec);
    }
    var seen = Object.create(null);
    (Array.isArray(raw.held) ? raw.held : []).forEach(function (k) {
      var n = normalizeKid(k);
      if (n && !seen[n] && st.held.length < LIMITS.held) { seen[n] = true; st.held.push(n); }
    });
    return st;
  }

  function serializeRec(r) {
    return {
      id: r.id,
      name: r.name,
      emails: r.emails.slice(),
      matrix: r.matrix ? { mxid: r.matrix.mxid, displayName: r.matrix.displayName } : null,
      circleKid: r.circleKid,
      sources: r.sources.slice(),
      updated: r.updated,
    };
  }

  function serialize(st) {
    var items = [];
    st.items.forEach(function (r) { items.push(serializeRec(r)); });
    return { v: STATE_VERSION, items: items, held: st.held.slice() };
  }

  /** change signature of one record, `updated` excluded */
  function sig(r) {
    return JSON.stringify([r.name, r.emails, r.matrix, r.circleKid, r.sources]);
  }

  // ---- views ------------------------------------------------------------------

  function statusOf(r, heldSet) {
    if (r.matrix) {
      if (r.circleKid && heldSet.has(r.circleKid)) return STATUS.ready;
      if (!r.emails.length) return STATUS.matrixOnly;
      return STATUS.needsKey;
    }
    return STATUS.googleOnly;
  }

  function displayName(r) {
    return r.name || (r.matrix && r.matrix.displayName) || r.emails[0] || (r.matrix && r.matrix.mxid) || "";
  }

  function view(r, heldSet) {
    return {
      id: r.id,
      name: displayName(r),
      emails: r.emails.slice(),
      matrix: r.matrix ? { mxid: r.matrix.mxid, displayName: r.matrix.displayName } : null,
      circleKid: r.circleKid,
      sources: r.sources.slice(),
      status: statusOf(r, heldSet),
      addressable: r.emails.length > 0,
      updated: r.updated,
    };
  }

  function byNameThenId(a, b) {
    var x = a.name.toLowerCase(), y = b.name.toLowerCase();
    if (x < y) return -1;
    if (x > y) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  // ---- merge machinery (operates on one loaded state) ---------------------------

  function compatible(a, b) {
    if (a.matrix && b.matrix && a.matrix.mxid !== b.matrix.mxid) return false;
    if (a.circleKid && b.circleKid && a.circleKid !== b.circleKid) return false;
    return true;
  }

  function addSource(r, s) { if (r.sources.indexOf(s) === -1) r.sources.push(s); }

  function indexRec(st, r) {
    st.items.set(r.id, r);
    r.emails.forEach(function (e) { st.byEmail.set(e, r); });
    if (r.matrix) st.byMxid.set(r.matrix.mxid, r);
  }

  /** Move everything `from` knows into `into`, then drop `from`. Caller has checked compatible(). */
  function absorb(st, into, from) {
    from.emails.forEach(function (e) {
      st.byEmail.delete(e);
      if (into.emails.indexOf(e) === -1 && into.emails.length < LIMITS.emailsPerContact) {
        into.emails.push(e);
        st.byEmail.set(e, into);
      }
    });
    if (from.matrix) {
      st.byMxid.delete(from.matrix.mxid);
      if (!into.matrix) {
        into.matrix = from.matrix;
        st.byMxid.set(into.matrix.mxid, into);
      } else if (!into.matrix.displayName && from.matrix.displayName) {
        into.matrix.displayName = from.matrix.displayName;
      }
    }
    if (!into.name && from.name) into.name = from.name;
    if (!into.circleKid && from.circleKid) into.circleKid = from.circleKid;
    from.sources.forEach(function (s) { addSource(into, s); });
    st.items.delete(from.id);
  }

  /** "added" | "same" | "conflict" | "full" */
  function attachEmail(st, r, email) {
    var owner = st.byEmail.get(email);
    if (owner === r) return "same";
    if (owner) return "conflict";
    if (r.emails.length >= LIMITS.emailsPerContact) return "full";
    r.emails.push(email);
    st.byEmail.set(email, r);
    return "added";
  }

  /**
   * Fold one import entry into the state.
   * entry: { name, emails:[normalised], mxid|null, displayName } ; source: "google" | "matrix"
   * returns { outcome: "added"|"merged"|"skipped", conflict: boolean }
   */
  function upsert(st, entry, source, nowMs) {
    var conflict = false;
    var hits = [];
    entry.emails.forEach(function (e) {
      var r = st.byEmail.get(e);
      if (r && hits.indexOf(r) === -1) hits.push(r);
    });
    if (entry.mxid) {
      var mh = st.byMxid.get(entry.mxid);
      if (mh && hits.indexOf(mh) === -1) hits.push(mh);
    }

    // primary: the first hit that is not a different Matrix account than the entry's
    var primary = null;
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (entry.mxid && h.matrix && h.matrix.mxid !== entry.mxid) continue;
      primary = h;
      break;
    }
    var created = false;
    if (primary) {
      hits.forEach(function (h) {
        if (h === primary) return;
        if (entry.mxid && h.matrix && h.matrix.mxid !== entry.mxid) { conflict = true; return; }
        if (compatible(primary, h)) absorb(st, primary, h);
        else conflict = true;
      });
    } else {
      if (hits.length) conflict = true; // every email hit is a different Matrix account
      if (st.items.size >= LIMITS.contacts) return { outcome: "skipped", conflict: conflict };
      primary = { id: newId(st.items, nowMs), name: "", emails: [], matrix: null, circleKid: null, sources: [], updated: nowMs };
      created = true;
    }

    var before = created ? null : sig(primary);

    if (source === "google" && entry.name && primary.name !== entry.name) primary.name = entry.name;

    entry.emails.forEach(function (e) {
      var res = attachEmail(st, primary, e);
      if (res === "conflict") conflict = true;
    });

    if (entry.mxid) {
      if (!primary.matrix) {
        var owner = st.byMxid.get(entry.mxid);
        if (owner && owner !== primary) {
          conflict = true;
        } else {
          primary.matrix = { mxid: entry.mxid, displayName: entry.displayName || "" };
          st.byMxid.set(entry.mxid, primary);
        }
      } else if (primary.matrix.mxid === entry.mxid && entry.displayName && primary.matrix.displayName !== entry.displayName) {
        primary.matrix.displayName = entry.displayName;
      }
    }

    if (!primary.emails.length && !primary.matrix) {
      return { outcome: "skipped", conflict: conflict }; // only reachable for a fresh, empty record
    }

    addSource(primary, source);

    if (created) {
      primary.updated = nowMs;
      indexRec(st, primary);
      return { outcome: "added", conflict: conflict };
    }
    if (sig(primary) !== before) primary.updated = nowMs;
    return { outcome: "merged", conflict: conflict };
  }

  // ---- store -------------------------------------------------------------------

  function create(opts) {
    opts = opts || {};
    var storage = opts.storage;
    if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
      throw new TypeError("HyContacts.create: storage must have get(key) and set(key, value)");
    }
    var nowFn = typeof opts.now === "function" ? opts.now : function () { return Date.now(); };
    var key = typeof opts.key === "string" && opts.key ? opts.key : DEFAULT_KEY;

    function nowMs() {
      var n = Number(nowFn());
      return isFinite(n) ? n : Date.now();
    }

    var chain = Promise.resolve();
    function run(fn) {
      var p = chain.then(fn);
      chain = p.then(function () {}, function () {});
      return p;
    }

    async function read() {
      var raw = await storage.get(key);
      // tolerate a chrome.storage-shaped result {key: value}
      if (isObject(raw) && Object.prototype.hasOwnProperty.call(raw, key)) raw = raw[key];
      var st = loadState(raw, nowMs());
      st._before = JSON.stringify(serialize(st));
      st._rawWasDirty = raw != null && JSON.stringify(raw) !== st._before;
      return st;
    }

    /** write only if something changed (or a stored record needed scrubbing) */
    async function commit(st) {
      var out = serialize(st);
      if (JSON.stringify(out) === st._before && !st._rawWasDirty) return false;
      await storage.set(key, out);
      return true;
    }

    function heldSet(st) {
      var s = new Set();
      st.held.forEach(function (k) { s.add(k); });
      return s;
    }

    function sortedViews(st, filter) {
      var held = heldSet(st);
      var out = [];
      st.items.forEach(function (r) {
        var v = view(r, held);
        if (!filter || filter(v)) out.push(v);
      });
      return out.sort(byNameThenId);
    }

    function importList(list, source) {
      return run(async function () {
        var st = await read();
        var res = { added: 0, merged: 0, skipped: 0, conflicts: 0 };
        if (!Array.isArray(list)) return res;
        var n = Math.min(list.length, LIMITS.contacts);
        res.skipped += list.length - n;
        var t = nowMs();
        for (var i = 0; i < n; i++) {
          var entry = prepare(list[i], source);
          if (!entry) { res.skipped++; continue; }
          var r = upsert(st, entry, source, t);
          if (r.outcome === "added") res.added++;
          else if (r.outcome === "merged") res.merged++;
          else res.skipped++;
          if (r.conflict) res.conflicts++;
        }
        await commit(st);
        return res;
      });
    }

    function prepare(item, source) {
      if (!isObject(item)) return null;
      var emails = [];
      var rawEmails = Array.isArray(item.emails) ? item.emails.slice(0, LIMITS.emailsPerEntry) : [];
      rawEmails.forEach(function (e) {
        var n = normalizeEmail(e);
        if (n && emails.indexOf(n) === -1) emails.push(n);
      });
      if (source === "google") {
        if (!emails.length) return null;
        return { name: cleanText(item.name, LIMITS.name), emails: emails, mxid: null, displayName: "" };
      }
      var mxid = normalizeMxid(item.mxid);
      if (!mxid) return null;
      return { name: "", emails: emails, mxid: mxid, displayName: cleanText(item.displayName, LIMITS.name) };
    }

    return {
      all: function () {
        return run(async function () { return sortedViews(await read()); });
      },

      byEmail: function (email) {
        return run(async function () {
          var n = normalizeEmail(email);
          if (!n) return null;
          var st = await read();
          var r = st.byEmail.get(n);
          return r ? view(r, heldSet(st)) : null;
        });
      },

      search: function (q) {
        return run(async function () {
          var st = await read();
          var words = (typeof q === "string" ? q.slice(0, LIMITS.query) : "").toLowerCase().split(/\s+/).filter(Boolean);
          if (!words.length) return sortedViews(st);
          var held = heldSet(st);
          var out = [];
          st.items.forEach(function (r) {
            var hay = [r.name, r.matrix ? r.matrix.displayName : "", r.matrix ? r.matrix.mxid : ""]
              .concat(r.emails).join("\n").toLowerCase();
            for (var i = 0; i < words.length; i++) if (hay.indexOf(words[i]) === -1) return;
            out.push(view(r, held));
          });
          return out.sort(byNameThenId);
        });
      },

      importGoogle: function (list) { return importList(list, "google"); },
      importMatrix: function (list) { return importList(list, "matrix"); },

      link: function (id, patch) {
        return run(async function () {
          if (!isObject(patch)) throw fail("invalid", "patch must be an object");
          var st = await read();
          var r = typeof id === "string" ? st.items.get(id) : undefined;
          if (!r) throw fail("not-found", "no such contact");
          var before = sig(r);
          var hasOwn = function (k) { return Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined; };
          var identityChanged = false;
          var manual = false;

          if (hasOwn("mxid")) {
            if (patch.mxid === null) {
              if (r.matrix) {
                st.byMxid.delete(r.matrix.mxid);
                r.matrix = null;
                r.circleKid = null; // the circle was assigned to that identity
                r.sources = r.sources.filter(function (s) { return s !== "matrix"; });
              }
            } else {
              var m = normalizeMxid(patch.mxid);
              if (!m) throw fail("invalid", "malformed mxid");
              if (r.matrix && r.matrix.mxid !== m) {
                st.byMxid.delete(r.matrix.mxid);
                r.matrix = null;
                r.circleKid = null;
                identityChanged = true;
              }
              var owner = st.byMxid.get(m);
              if (owner && owner !== r) {
                if (!compatible(r, owner)) throw fail("conflict", "that Matrix account is already linked to a contact with a different circle");
                absorb(st, r, owner);
              } else if (!r.matrix) {
                r.matrix = { mxid: m, displayName: "" };
                st.byMxid.set(m, r);
              }
              manual = true;
            }
          }

          if (hasOwn("circleKid")) {
            if (patch.circleKid === null) r.circleKid = null;
            else {
              var kid = normalizeKid(patch.circleKid);
              if (!kid) throw fail("invalid", "malformed circle id");
              r.circleKid = kid;
              manual = true;
            }
          }

          if (hasOwn("email")) {
            if (patch.email === null) {
              r.emails.forEach(function (e) { st.byEmail.delete(e); });
              r.emails = [];
            } else {
              var e = normalizeEmail(patch.email);
              if (!e) throw fail("invalid", "malformed email");
              var eo = st.byEmail.get(e);
              if (eo && eo !== r) {
                if (!compatible(r, eo)) throw fail("conflict", "that email belongs to a different Matrix account or circle");
                absorb(st, r, eo);
              } else if (attachEmail(st, r, e) === "full") {
                throw fail("limit", "too many emails on one contact");
              }
              manual = true;
            }
          }

          if (hasOwn("removeEmail")) {
            var re = normalizeEmail(patch.removeEmail);
            if (!re) throw fail("invalid", "malformed email");
            var at = r.emails.indexOf(re);
            if (at !== -1) {
              r.emails.splice(at, 1);
              st.byEmail.delete(re);
            }
          }

          if (!r.emails.length && !r.matrix) throw fail("invalid", "a contact needs an email or a Matrix link; use remove() to delete it");
          if (identityChanged && !hasOwn("circleKid")) r.circleKid = null;
          if (manual) addSource(r, "manual");
          if (sig(r) !== before) r.updated = nowMs();
          await commit(st);
          return view(r, heldSet(st));
        });
      },

      setHeldCircles: function (kids) {
        return run(async function () {
          if (!Array.isArray(kids)) throw fail("invalid", "kids must be an array of circle ids");
          var st = await read();
          var seen = Object.create(null);
          var held = [];
          var ignored = 0;
          kids.forEach(function (k) {
            var n = normalizeKid(k);
            if (!n) { ignored++; return; }
            if (seen[n]) return;
            if (held.length >= LIMITS.held) { ignored++; return; }
            seen[n] = true;
            held.push(n);
          });
          st.held = held;
          await commit(st);
          return { held: held.length, ignored: ignored };
        });
      },

      remove: function (id) {
        return run(async function () {
          var st = await read();
          var r = typeof id === "string" ? st.items.get(id) : undefined;
          if (!r) return false;
          st.items.delete(r.id);
          r.emails.forEach(function (e) { st.byEmail.delete(e); });
          if (r.matrix) st.byMxid.delete(r.matrix.mxid);
          await commit(st);
          return true;
        });
      },
    };
  }

  /**
   * Adapt a chrome.storage area (chrome.storage.local) to the { get, set }
   * shape create() wants. Pass the area, not the whole `chrome`.
   */
  function fromChrome(area) {
    return {
      get: function (key) { return area.get(key).then(function (o) { return o ? o[key] : undefined; }); },
      set: function (key, value) { var o = {}; o[key] = value; return area.set(o); },
    };
  }

  return {
    create: create,
    fromChrome: fromChrome,
    normalizeEmail: normalizeEmail,
    normalizeMxid: normalizeMxid,
    normalizeKid: normalizeKid,
    STATUS: STATUS,
    SOURCES: SOURCES,
    LIMITS: LIMITS,
    DEFAULT_KEY: DEFAULT_KEY,
  };
});
