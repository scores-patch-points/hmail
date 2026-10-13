/*
 * hyphae contacts — the Google Contacts source.
 *
 * Turns Google contacts into the shape contacts/core.js imports:
 *
 *     { name: string, emails: [string], source: "csv" | "api" }
 *
 * ("csv" means "read from an export file"; .vcf files are reported as "csv" too,
 * because core only distinguishes file from API.)
 *
 * TWO ROUTES — they differ in what they cost the user, not in what they return:
 *
 *   1. FILE route (the default; needs NO Google permission at all).
 *      The user exports from contacts.google.com (Export → "Google CSV", "Outlook
 *      CSV" or "vCard") and drops the file in. hyphae never talks to Google.
 *        HyGoogleContacts.parseExport(text, opts)        whole string
 *        HyGoogleContacts.createParser(opts)             push(chunk) … end()   (streaming)
 *        HyGoogleContacts.parseFile(file, opts)          File/Blob, async, streams
 *        HyGoogleContacts.parseCsv / parseVcf            when the format is known
 *
 *   2. API route (optional; needs an OAuth access token with a SENSITIVE scope).
 *        HyGoogleContacts.fetchContacts({ accessToken, fetch, include, … })  async
 *      Scope: https://www.googleapis.com/auth/contacts.readonly  (connections)
 *             https://www.googleapis.com/auth/contacts.other.readonly  (otherContacts)
 *      Both are Google "sensitive" scopes. An app other than the project owner's
 *      own listed test users needs Google's OAuth verification before it may use
 *      them. See GOOGLE-WIRING.md. This module never obtains, stores or refreshes
 *      a credential: the caller passes a token (or a function that returns one),
 *      and a fetch function, per call.
 *
 * Contacts never leave the device: this file makes no network call of its own
 * (the API route calls the `fetch` it is handed, to people.googleapis.com only),
 * has no analytics, and never logs — not even counts of what it parsed.
 *
 * Input is hostile by assumption: every size is capped, malformed e-mails are
 * dropped, e-mails are trimmed and lower-cased, duplicates inside one input are
 * collapsed, and no key from the input is ever used as an object property name
 * (Maps only), so a column called "__proto__" is just a column.
 *
 * Dependency-free; the same file loads in the worker, a page and Node tests.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HyGoogleContacts = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  var LIMITS = {
    maxChars: 64 * 1024 * 1024,   // characters read from one file; the rest is ignored
    maxBytes: 64 * 1024 * 1024,   // File size accepted by parseFile
    maxContacts: 100000,          // contacts returned
    maxEmailsPerContact: 50,
    maxFieldChars: 4096,          // one CSV cell; longer cells are cut (and so ignored as e-mails)
    maxColumns: 1000,
    maxLineChars: 16384,          // one logical vCard line; PHOTO etc. are skipped before this matters
    maxNameChars: 200,
    maxPages: 200,                // API pages per source (1000 each)
    maxRetries: 5,
    retryBaseMs: 500,
    retryMaxMs: 30000
  };

  var SCOPES = {
    contacts: "https://www.googleapis.com/auth/contacts.readonly",
    other: "https://www.googleapis.com/auth/contacts.other.readonly"
  };
  var PEOPLE_ORIGIN = "https://people.googleapis.com";

  function limitsFor(opts) {
    var out = {};
    for (var k in LIMITS) {
      if (Object.prototype.hasOwnProperty.call(LIMITS, k)) {
        var v = opts && opts.limits && opts.limits[k];
        out[k] = typeof v === "number" && isFinite(v) && v > 0 ? v : LIMITS[k];
      }
    }
    return out;
  }

  // --- normalisation ---------------------------------------------------------

  var CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
  // zero-width, bidi embedding/override/isolate controls and the BOM: invisible
  // characters that could make a contact's name read as something it is not.
  var INVISIBLE_RE = /[​-‏‪-‮⁠-⁩﻿]/g;
  var INVISIBLE_ANY = /[​-‏‪-‮⁠-⁩﻿\u0080-\u009f]/;
  var LOCAL_RE = /^[a-z0-9!#$%&'*+\/=?^_`{|}~ -￿.\-]+$/;
  var LABEL_RE = /^[a-z0-9 -￿](?:[a-z0-9 -￿\-]*[a-z0-9 -￿])?$/;

  function cleanName(s, max) {
    if (typeof s !== "string" || !s) return "";
    s = s.replace(CONTROL_RE, " ").replace(INVISIBLE_RE, "").replace(/\s+/g, " ").replace(/^ | $/g, "");
    if (s.normalize) { try { s = s.normalize("NFC"); } catch (e) { /* keep */ } }
    var cap = max || LIMITS.maxNameChars;
    if (s.length > cap) s = s.slice(0, cap).replace(/ $/, "");
    return s;
  }

  // One address, or "Name <addr>", or "mailto:addr". Returns the lower-cased
  // address or null. Deliberately stricter than RFC 5322: quoted local parts,
  // comments, IP-literal domains and single-label domains are refused, because
  // none of them is something a person reaches over Matrix and all of them are
  // easier to abuse than to use.
  function normalizeEmail(raw) {
    if (typeof raw !== "string") return null;
    var s = raw;
    if (s.length > 1024) return null;
    s = s.replace(/^\s+|\s+$/g, "");
    var lt = s.lastIndexOf("<"), gt = s.lastIndexOf(">");
    if (lt !== -1 && gt > lt) s = s.slice(lt + 1, gt);
    s = s.replace(/^\s+|\s+$/g, "").replace(/^mailto:/i, "").replace(/^\s+|\s+$/g, "");
    if (s.length > 1 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') s = s.slice(1, -1);
    s = s.toLowerCase();
    if (s.length < 3 || s.length > 254) return null;
    var at = s.indexOf("@");
    if (at < 1 || at !== s.lastIndexOf("@")) return null;
    if (INVISIBLE_ANY.test(s)) return null;
    var local = s.slice(0, at), domain = s.slice(at + 1);
    if (local.length > 64 || !LOCAL_RE.test(local)) return null;
    if (local.charAt(0) === "." || local.charAt(local.length - 1) === "." || local.indexOf("..") !== -1) return null;
    var labels = domain.split(".");
    if (labels.length < 2) return null;
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].length < 1 || labels[i].length > 63 || !LABEL_RE.test(labels[i])) return null;
    }
    if (/^[0-9]+$/.test(labels[labels.length - 1])) return null;
    return s;
  }

  // --- collector: dedup + merge inside one input ------------------------------

  function Collector(lim, source) {
    this.lim = lim;
    this.source = source;
    this.contacts = [];
    this.byEmail = new Map();
    this.truncated = false;
    this.stats = { records: 0, contacts: 0, withoutEmail: 0, invalidEmails: 0, duplicates: 0, merged: 0 };
  }

  // cands: array of raw strings that may be addresses. name/org: raw strings.
  Collector.prototype.add = function (name, org, cands) {
    var st = this.stats, lim = this.lim;
    st.records++;
    var emails = [], i;
    for (i = 0; i < cands.length && emails.length < lim.maxEmailsPerContact; i++) {
      var raw = cands[i];
      if (typeof raw !== "string") continue;
      raw = raw.replace(/^\s+|\s+$/g, "");
      if (!raw) continue;
      var e = normalizeEmail(raw);
      if (e === null) {
        if (raw.indexOf("@") !== -1) st.invalidEmails++;
        continue;
      }
      if (emails.indexOf(e) === -1) emails.push(e);
    }
    if (!emails.length) { st.withoutEmail++; return; }

    // no name and no organisation: the name stays "" so core.js can take the Matrix
    // display name instead of showing an address as if it were a name
    var nm = cleanName(name, lim.maxNameChars) || cleanName(org, lim.maxNameChars);

    var allSeen = true, shared = null;
    for (i = 0; i < emails.length; i++) {
      var hit = this.byEmail.get(emails[i]);
      if (hit) { if (!shared) shared = hit; } else allSeen = false;
    }

    if (allSeen) {            // nothing new in this record
      st.duplicates++;
      if (shared && shared.name === "" && nm) shared.name = nm;
      return;
    }
    if (shared && nm && shared.name.toLowerCase() === nm.toLowerCase()) {
      // same person listed twice with partly different addresses: one contact
      for (i = 0; i < emails.length && shared.emails.length < lim.maxEmailsPerContact; i++) {
        if (!this.byEmail.has(emails[i])) { shared.emails.push(emails[i]); this.byEmail.set(emails[i], shared); }
      }
      st.merged++;
      return;
    }
    if (this.contacts.length >= lim.maxContacts) { this.truncated = true; return; }
    var c = { name: nm, emails: emails, source: this.source };
    this.contacts.push(c);
    for (i = 0; i < emails.length; i++) if (!this.byEmail.has(emails[i])) this.byEmail.set(emails[i], c);
    st.contacts = this.contacts.length;
  };

  function finish(col, extra) {
    col.stats.contacts = col.contacts.length;
    var warnings = extra.warnings || [];
    if (col.truncated) warnings.push("contact-cap: stopped at " + col.lim.maxContacts + " contacts");
    if (col.stats.invalidEmails) warnings.push(col.stats.invalidEmails + " malformed address(es) were ignored");
    return {
      ok: !extra.error,
      error: extra.error || null,
      format: extra.format,
      contacts: col.contacts,
      stats: col.stats,
      truncated: !!(col.truncated || extra.truncated),
      warnings: warnings
    };
  }

  // --- CSV ---------------------------------------------------------------------

  function detectDelimiter(text) {
    var counts = { ",": 0, ";": 0, "\t": 0 }, inQ = false;
    for (var i = 0; i < text.length && i < 65536; i++) {
      var ch = text.charAt(i);
      if (ch === '"') inQ = !inQ;
      else if (!inQ) {
        if (ch === "\n" || ch === "\r") break;
        if (ch in counts) counts[ch]++;
      }
    }
    var best = ",", n = counts[","];
    if (counts[";"] > n) { best = ";"; n = counts[";"]; }
    if (counts["\t"] > n) { best = "\t"; }
    return best;
  }

  function hnorm(h) {
    return String(h).replace(INVISIBLE_RE, "").replace(/\s+/g, " ").replace(/^ | $/g, "").toLowerCase();
  }

  var ROLE_NAMES = new Map([
    ["name", "full"], ["display name", "full"], ["full name", "full"],
    ["given name", "given"], ["first name", "given"],
    ["additional name", "mid"], ["middle name", "mid"],
    ["family name", "fam"], ["last name", "fam"],
    ["nickname", "nick"],
    ["organization 1 - name", "org"], ["organization name", "org"], ["organization", "org"], ["company", "org"]
  ]);

  function analyseHeader(rec) {
    var h = { emailCols: [], full: -1, given: -1, mid: -1, fam: -1, nick: -1, org: -1, format: "csv" };
    var hasGiven = false, hasFirst = false;
    for (var i = 0; i < rec.length; i++) {
      var n = hnorm(rec[i]);
      if (!n) continue;
      if (n === "given name") hasGiven = true;
      if (n === "first name") hasFirst = true;
      if (n.indexOf("mail") !== -1 || n.indexOf("correo") === 0 || n.indexOf("courriel") === 0) {
        // "E-mail 1 - Type", "E-mail Display Name", "E-mail 1 - Label" hold labels, not addresses
        if (!/display name|\btype\b|\blabel\b/.test(n)) h.emailCols.push(i);
        continue;
      }
      var role = ROLE_NAMES.get(n);
      if (role && h[role] === -1) h[role] = i;
    }
    if (hasGiven) h.format = "google-csv";
    else if (hasFirst) h.format = "outlook-csv";
    return h;
  }

  function splitCell(cell, out) {
    if (!cell) return;
    var parts = cell.split(":::");
    for (var i = 0; i < parts.length; i++) {
      var sub = parts[i].split(/[;,]/);
      for (var j = 0; j < sub.length; j++) out.push(sub[j]);
    }
  }

  function createCsvParser(opts) {
    opts = opts || {};
    var lim = limitsFor(opts);
    var col = new Collector(lim, opts.source === "api" ? "api" : "csv");
    var header = null, halted = false, error = null, sizeCut = false, capped = false;
    var consumed = 0, bomChecked = false;
    var delim = null, pend = "";
    var field = "", fieldEmpty = true, fieldOver = false, row = [], inQ = false, pq = false, cr = false;
    var warnings = [];

    // a cell longer than the cap is dropped whole: a cut cell could hold half an address
    function endField() {
      if (row.length < lim.maxColumns) row.push(fieldOver ? "" : field);
      field = ""; fieldEmpty = true; fieldOver = false;
    }
    function addChar(ch) {
      if (field.length < lim.maxFieldChars) field += ch; else fieldOver = true;
    }
    function endRecord() {
      endField();
      var r = row;
      row = [];
      if (r.length === 1 && r[0] === "") return;     // blank line
      onRecord(r);
    }
    function onRecord(r) {
      if (!header) {
        header = analyseHeader(r);
        if (!header.emailCols.length) {
          halted = true;
          error = "no-email-column: the first row has no e-mail column, so this does not look like a Google or Outlook contacts export";
        }
        return;
      }
      var cands = [], i;
      for (i = 0; i < header.emailCols.length; i++) splitCell(r[header.emailCols[i]], cands);
      var nm = header.full !== -1 ? r[header.full] : "";
      if (!cleanName(nm)) {
        var parts = [];
        if (header.given !== -1 && r[header.given]) parts.push(r[header.given]);
        if (header.mid !== -1 && r[header.mid]) parts.push(r[header.mid]);
        if (header.fam !== -1 && r[header.fam]) parts.push(r[header.fam]);
        nm = parts.join(" ");
      }
      if (!cleanName(nm) && header.nick !== -1) nm = r[header.nick];
      col.add(nm, header.org !== -1 ? r[header.org] : "", cands);
    }

    function feed(s) {
      if (halted || capped || !s) return;
      if (!bomChecked) {
        bomChecked = true;
        if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
      }
      var room = lim.maxChars - consumed;
      if (room <= 0) { capped = true; sizeCut = true; return; }
      if (s.length > room) { s = s.slice(0, room); sizeCut = true; capped = true; }
      consumed += s.length;
      var d = delim;
      for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (inQ) {
          if (pq) {
            if (c === '"') { addChar('"'); pq = false; continue; }
            inQ = false; pq = false;           // the quote closed the field; handle c unquoted
          } else if (c === '"') { pq = true; continue; }
          else { addChar(c); continue; }
        }
        if (c === d) { endField(); cr = false; }
        else if (c === "\n") { if (cr) { cr = false; continue; } endRecord(); if (halted) return; }
        else if (c === "\r") { cr = true; endRecord(); if (halted) return; }
        else {
          cr = false;
          if (c === '"' && fieldEmpty) { inQ = true; fieldEmpty = false; }
          else { fieldEmpty = false; addChar(c); }
        }
      }
    }

    return {
      push: function (chunk) {
        if (halted || capped || typeof chunk !== "string" || !chunk) return;
        if (delim === null) {
          pend += chunk;
          if (/[\r\n]/.test(pend) || pend.length > 65536) {
            delim = detectDelimiter(pend.charCodeAt(0) === 0xfeff ? pend.slice(1) : pend);
            var p = pend; pend = ""; feed(p);
          }
          return;
        }
        feed(chunk);
      },
      end: function () {
        if (delim === null) {
          delim = detectDelimiter(pend.charCodeAt(0) === 0xfeff ? pend.slice(1) : pend);
          var p = pend; pend = ""; feed(p);
        }
        // a record cut off by the size cap may hold half an address: never flush it
        if (!halted && !capped && !sizeCut && (row.length || field.length || !fieldEmpty || fieldOver)) endRecord();
        if (sizeCut) warnings.push("size-cap: input was longer than " + lim.maxChars + " characters; the rest was ignored");
        if (!header && !error) error = "empty: no rows";
        return finish(col, { format: header ? header.format : "unknown", error: error, warnings: warnings, truncated: sizeCut });
      }
    };
  }

  // --- vCard 2.1 / 3.0 / 4.0 ----------------------------------------------------

  var VCARD_WANTED = new Map([["BEGIN", 1], ["END", 1], ["FN", 1], ["N", 1], ["EMAIL", 1], ["NICKNAME", 1], ["ORG", 1]]);

  function splitUnescaped(v, sep) {
    var out = [], cur = "";
    for (var i = 0; i < v.length; i++) {
      var c = v.charAt(i);
      if (c === "\\" && i + 1 < v.length) { cur += c + v.charAt(i + 1); i++; }
      else if (c === sep) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }
  function unescapeVal(v) {
    return v.replace(/\\([nN,;\\:])/g, function (_, ch) { return ch === "n" || ch === "N" ? " " : ch; });
  }

  function decodeQuotedPrintable(v, charset) {
    var bytes = [];
    for (var i = 0; i < v.length; i++) {
      var c = v.charAt(i);
      if (c === "=" && i + 2 < v.length && /^[0-9a-fA-F]{2}$/.test(v.substr(i + 1, 2))) {
        bytes.push(parseInt(v.substr(i + 1, 2), 16)); i += 2;
      } else {
        var code = v.charCodeAt(i);
        if (code < 128) bytes.push(code);
        else if (typeof TextEncoder === "function") {
          var enc = new TextEncoder().encode(c);
          for (var j = 0; j < enc.length; j++) bytes.push(enc[j]);
        }
      }
    }
    var cs = (charset || "utf-8").toLowerCase();
    if (typeof TextDecoder === "function") {
      try { return new TextDecoder(cs === "us-ascii" ? "windows-1252" : cs).decode(new Uint8Array(bytes)); } catch (e) { /* fall through */ }
    }
    var out = "";
    for (var k = 0; k < bytes.length; k++) out += String.fromCharCode(bytes[k]);
    return out;
  }

  function createVcfParser(opts) {
    opts = opts || {};
    var lim = limitsFor(opts);
    var col = new Collector(lim, opts.source === "api" ? "api" : "csv");
    var carry = "", cr = false, consumed = 0, bomChecked = false, sizeCut = false;
    var pendActive = false, pendSkip = false, pendQp = false, pendText = "";
    var card = null, sawCard = false, warnings = [];

    function newCard() { return { fn: "", n: "", nick: "", org: "", emails: [] }; }
    function finalize() {
      if (!card) return;
      var nm = card.fn || card.n || card.nick;
      col.add(nm, card.org, card.emails);
      card = null;
    }
    function handleLine(t) {
      var idx = t.indexOf(":");
      if (idx < 1) return;
      var head = t.slice(0, idx), value = t.slice(idx + 1);
      var parts = head.split(";");
      var name = parts[0];
      var dot = name.lastIndexOf(".");
      if (dot !== -1) name = name.slice(dot + 1);
      name = name.toUpperCase();
      var qp = false, charset = "";
      for (var i = 1; i < parts.length; i++) {
        var p = parts[i].toLowerCase();
        if (p === "quoted-printable" || p === "encoding=quoted-printable") qp = true;
        else if (p.indexOf("charset=") === 0) charset = p.slice(8);
      }
      if (name === "BEGIN") {
        if (value.replace(/\s+$/, "").toUpperCase() === "VCARD") { finalize(); card = newCard(); sawCard = true; }
        return;
      }
      if (name === "END") {
        if (value.replace(/\s+$/, "").toUpperCase() === "VCARD") finalize();
        return;
      }
      if (!card) return;
      if (qp) value = decodeQuotedPrintable(value, charset);
      if (name === "FN") { if (!card.fn) card.fn = unescapeVal(value); }
      else if (name === "N") {
        if (!card.n) {
          var c = splitUnescaped(value, ";");        // family;given;additional;prefix;suffix
          var seg = [];
          if (c[1]) seg.push(unescapeVal(c[1]));
          if (c[2]) seg.push(unescapeVal(c[2]));
          if (c[0]) seg.push(unescapeVal(c[0]));
          card.n = seg.join(" ");
        }
      }
      else if (name === "NICKNAME") { if (!card.nick) card.nick = unescapeVal(splitUnescaped(value, ",")[0]); }
      else if (name === "ORG") { if (!card.org) card.org = unescapeVal(splitUnescaped(value, ";")[0]); }
      else if (name === "EMAIL") { if (card.emails.length < lim.maxEmailsPerContact * 2) card.emails.push(unescapeVal(value)); }
    }
    function flushPending() {
      if (pendActive && !pendSkip) handleLine(pendText);
      pendActive = false; pendSkip = false; pendQp = false; pendText = "";
    }
    function physical(L) {
      // vCard 2.1 quoted-printable soft break: the logical line goes on
      if (pendActive && !pendSkip && pendQp && pendText.charAt(pendText.length - 1) === "=") {
        pendText = pendText.slice(0, -1) + L;
        if (pendText.length > lim.maxLineChars) { pendSkip = true; pendText = ""; }
        return;
      }
      var c0 = L.charCodeAt(0);
      if (c0 === 32 || c0 === 9) {                    // RFC 6350 folding
        if (pendActive && !pendSkip) {
          pendText += L.slice(1);
          if (pendText.length > lim.maxLineChars) { pendSkip = true; pendText = ""; }
        }
        return;
      }
      flushPending();
      if (!L) return;
      var colon = L.indexOf(":"), semi = L.indexOf(";");
      var headEnd = colon === -1 ? -1 : (semi !== -1 && semi < colon ? semi : colon);
      if (headEnd < 1) { pendActive = true; pendSkip = true; return; }
      var nm = L.slice(0, headEnd), dot = nm.lastIndexOf(".");
      if (dot !== -1) nm = nm.slice(dot + 1);
      pendActive = true;
      if (!VCARD_WANTED.has(nm.toUpperCase())) { pendSkip = true; return; }
      if (L.length > lim.maxLineChars) { pendSkip = true; return; }
      pendText = L;
      pendQp = /quoted-printable/i.test(L.slice(0, colon));
    }

    function feed(s, final) {
      if (sizeCut) return;
      if (!bomChecked && s) { bomChecked = true; if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); }
      var room = lim.maxChars - consumed;
      if (room <= 0) { sizeCut = true; return; }
      if (s.length > room) { s = s.slice(0, room); sizeCut = true; }
      consumed += s.length;
      var start = 0, n = s.length;
      for (var i = 0; i < n; i++) {
        var c = s.charCodeAt(i);
        if (c === 10 || c === 13) {
          if (c === 10 && cr && i === start) { cr = false; start = i + 1; continue; }
          cr = c === 13;
          var line = carry + s.slice(start, i);
          carry = "";
          physical(line.length > lim.maxLineChars + 1 ? line.slice(0, lim.maxLineChars + 1) : line);
          start = i + 1;
        } else cr = false;
      }
      if (start < n) {
        carry += s.slice(start);
        if (carry.length > lim.maxLineChars + 1) carry = carry.slice(0, lim.maxLineChars + 1);
      }
    }

    return {
      push: function (chunk) { if (typeof chunk === "string" && chunk) feed(chunk, false); },
      end: function () {
        if (carry && !sizeCut) { var l = carry; carry = ""; physical(l); }
        flushPending();
        // a card with no END (truncated file) is still whole lines, so keep what it has —
        // unless the size cap cut it, when the last line may be half an address
        if (card && !sizeCut) finalize();
        if (sizeCut) warnings.push("size-cap: input was longer than " + lim.maxChars + " characters; the rest was ignored");
        var err = sawCard ? null : "no-vcard: no BEGIN:VCARD found";
        return finish(col, { format: "vcard", error: err, warnings: warnings, truncated: sizeCut });
      }
    };
  }

  // --- auto-detect + whole-string + File helpers ------------------------------

  function sniff(text) {
    var s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    s = s.replace(/^\s+/, "").slice(0, 32);
    return /^BEGIN:VCARD/i.test(s) ? "vcard" : "csv";
  }

  // Streaming parser that picks CSV or vCard from the first non-blank bytes.
  function createParser(opts) {
    opts = opts || {};
    var inner = null, buf = "";
    function pick() {
      var f = opts.format === "vcard" || opts.format === "csv" ? opts.format : sniff(buf);
      inner = f === "vcard" ? createVcfParser(opts) : createCsvParser(opts);
      var b = buf; buf = ""; inner.push(b);
    }
    return {
      push: function (chunk) {
        if (typeof chunk !== "string" || !chunk) return;
        if (inner) { inner.push(chunk); return; }
        buf += chunk;
        // "BEGIN:VCARD" is 11 characters: do not decide on fewer (a 1-char chunk
        // "B" must not be read as the start of a CSV header)
        var lead = buf.charCodeAt(0) === 0xfeff ? buf.slice(1) : buf;
        if (lead.replace(/^\s+/, "").length >= 11 || buf.length > 4096) pick();
      },
      end: function () {
        if (!inner) pick();
        return inner.end();
      }
    };
  }

  function parseWith(create, text, opts) {
    var p = create(opts);
    if (typeof text === "string") p.push(text);
    return p.end();
  }
  function parseCsv(text, opts) { return parseWith(createCsvParser, text, opts); }
  function parseVcf(text, opts) { return parseWith(createVcfParser, text, opts); }
  function parseExport(text, opts) { return parseWith(createParser, text, opts); }

  // File/Blob (or anything with .stream() / .text()). Streams in chunks so a
  // large export is never held as one string; recognises UTF-16 exports.
  function parseFile(file, opts) {
    opts = opts || {};
    var lim = limitsFor(opts);
    if (!file) return Promise.reject(new TypeError("parseFile: no file"));
    if (typeof file.size === "number" && file.size > lim.maxBytes) {
      var col = new Collector(lim, "csv");
      return Promise.resolve(finish(col, { format: "unknown", error: "too-large: file is " + file.size + " bytes, limit " + lim.maxBytes, warnings: [] }));
    }
    var parser = createParser(opts);
    if (typeof file.stream !== "function") {
      return Promise.resolve(file.text()).then(function (t) { parser.push(t); return parser.end(); });
    }
    var reader = file.stream().getReader();
    var decoder = null;
    function chooseDecoder(bytes) {
      var label = "utf-8";
      if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) label = "utf-16le";
      else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) label = "utf-16be";
      return new TextDecoder(label, { fatal: false });
    }
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          if (decoder) parser.push(decoder.decode());
          return parser.end();
        }
        if (!decoder) decoder = chooseDecoder(r.value);
        parser.push(decoder.decode(r.value, { stream: true }));
        return pump();
      });
    }
    return pump();
  }

  // --- API route ---------------------------------------------------------------

  function ApiError(code, message, status, retryable) {
    var e = new Error(message);
    e.name = "HyGoogleContactsError";
    e.code = code;
    e.status = status || 0;
    e.retryable = !!retryable;
    return e;
  }

  function defaultSleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function okToken(t) {
    return typeof t === "string" && t.length > 0 && t.length < 4096 && !/[\s\u0000-\u001f\u007f]/.test(t);
  }

  function googleReasons(body) {
    // body is Google's { error: { code, message, status, errors:[{reason}], details:[{reason}] } }
    var out = [];
    var e = body && typeof body === "object" ? body.error : null;
    if (!e || typeof e !== "object") return { text: "", message: "" };
    if (typeof e.status === "string") out.push(e.status);
    var arrs = [e.errors, e.details], i, j;
    for (i = 0; i < arrs.length; i++) {
      if (Array.isArray(arrs[i])) {
        for (j = 0; j < arrs[i].length; j++) {
          var x = arrs[i][j];
          if (x && typeof x.reason === "string") out.push(x.reason);
        }
      }
    }
    var msg = typeof e.message === "string" ? e.message.slice(0, 200) : "";
    return { text: out.join(" ").toLowerCase(), message: msg };
  }

  function retryDelay(attempt, retryAfter, ctx) {
    var base = ctx.lim.retryBaseMs * Math.pow(2, attempt);
    var wait = Math.min(ctx.lim.retryMaxMs, base) * (0.5 + 0.5 * ctx.random());
    if (retryAfter) {
      var secs = parseFloat(retryAfter);
      if (isFinite(secs) && secs >= 0) wait = Math.min(ctx.lim.retryMaxMs, Math.max(wait, secs * 1000));
    }
    return Math.round(wait);
  }

  // One GET with retry. Resolves to the parsed JSON body or rejects with an
  // HyGoogleContactsError whose .code is one of:
  //   unauthorized | insufficient-scope | api-disabled | rate-limited | forbidden |
  //   server | network | bad-response | bad-token | aborted
  function getJson(url, ctx) {
    var attempt = 0, refreshed = false;
    function once() {
      if (ctx.signal && ctx.signal.aborted) return Promise.reject(ApiError("aborted", "request aborted", 0, false));
      return Promise.resolve()
        .then(function () { return typeof ctx.accessToken === "function" ? ctx.accessToken({ refresh: refreshed }) : ctx.accessToken; })
        .then(function (token) {
          if (!okToken(token)) throw ApiError("bad-token", "access token is missing or malformed", 0, false);
          var init = {
            method: "GET",
            headers: { Authorization: "Bearer " + token, Accept: "application/json" },
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "no-referrer"
          };
          if (ctx.signal) init.signal = ctx.signal;
          return ctx.fetch(url, init);
        })
        .then(function (res) { return handle(res); }, function (err) {
          if (err && err.name === "HyGoogleContactsError") throw err;
          if (ctx.signal && ctx.signal.aborted) throw ApiError("aborted", "request aborted", 0, false);
          return retry(ApiError("network", "network error talking to people.googleapis.com", 0, true), null);
        });
    }
    function retry(err, retryAfter) {
      if (attempt >= ctx.lim.maxRetries) return Promise.reject(err);
      var ms = retryDelay(attempt, retryAfter, ctx);
      attempt++;
      return ctx.sleep(ms).then(once);
    }
    function handle(res) {
      var status = res && res.status;
      if (res && res.ok) {
        return res.json().then(function (j) {
          if (!j || typeof j !== "object" || Array.isArray(j)) throw ApiError("bad-response", "People API returned an unexpected body", status, false);
          return j;
        }, function () { throw ApiError("bad-response", "People API returned a body that is not JSON", status, false); });
      }
      var ra = res && res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
      var readBody = res && typeof res.json === "function" ? res.json().then(function (b) { return b; }, function () { return null; }) : Promise.resolve(null);
      return readBody.then(function (body) {
        var g = googleReasons(body);
        if (status === 401) {
          if (typeof ctx.accessToken === "function" && !refreshed) { refreshed = true; return once(); }
          throw ApiError("unauthorized", "Google rejected the access token (expired or revoked). Get a fresh token and retry.", 401, false);
        }
        if (status === 429) return retry(ApiError("rate-limited", "Google rate-limited the request (429); gave up after " + ctx.lim.maxRetries + " retries", 429, true), ra);
        if (status === 403) {
          var t = g.text;
          if (/ratelimit|quota|resource_exhausted/.test(t)) {
            return retry(ApiError("rate-limited", "Google quota/rate limit (403) persisted after " + ctx.lim.maxRetries + " retries", 403, true), ra);
          }
          if (/service_disabled|accessnotconfigured/.test(t)) {
            throw ApiError("api-disabled", "The People API is not enabled for this Google Cloud project", 403, false);
          }
          if (/scope|insufficientpermissions/.test(t)) {
            throw ApiError("insufficient-scope", "The token does not carry the contacts scope this call needs", 403, false);
          }
          throw ApiError("forbidden", "Google refused the request (403)" + (g.message ? ": " + g.message : ""), 403, false);
        }
        if (status >= 500 && status < 600) return retry(ApiError("server", "Google server error (" + status + ")", status, true), ra);
        throw ApiError("bad-response", "Unexpected HTTP " + status + " from People API" + (g.message ? ": " + g.message : ""), status, false);
      });
    }
    return once();
  }

  function pickName(p) {
    var names = p && Array.isArray(p.names) ? p.names : [];
    var chosen = null, i;
    for (i = 0; i < names.length; i++) {
      var n = names[i];
      if (n && n.metadata && n.metadata.primary === true) { chosen = n; break; }
    }
    if (!chosen && names.length) chosen = names[0];
    if (!chosen || typeof chosen !== "object") return "";
    if (typeof chosen.displayName === "string" && chosen.displayName) return chosen.displayName;
    return [chosen.givenName, chosen.familyName].filter(function (x) { return typeof x === "string" && x; }).join(" ");
  }

  function personEmails(p) {
    var out = [], arr = p && Array.isArray(p.emailAddresses) ? p.emailAddresses : [];
    for (var i = 0; i < arr.length; i++) {
      var a = arr[i];
      if (a && typeof a.value === "string") out.push(a.value);
    }
    return out;
  }

  var SOURCES = {
    connections: {
      scope: SCOPES.contacts,
      listKey: "connections",
      url: function (token) {
        return PEOPLE_ORIGIN + "/v1/people/me/connections?personFields=" + encodeURIComponent("names,emailAddresses") +
          "&pageSize=1000" + (token ? "&pageToken=" + encodeURIComponent(token) : "");
      }
    },
    otherContacts: {
      scope: SCOPES.other,
      listKey: "otherContacts",
      url: function (token) {
        return PEOPLE_ORIGIN + "/v1/otherContacts?readMask=" + encodeURIComponent("names,emailAddresses") +
          "&pageSize=1000" + (token ? "&pageToken=" + encodeURIComponent(token) : "");
      }
    }
  };

  function listSource(kind, ctx, col, progress) {
    var src = SOURCES[kind];
    var pageToken = "", seenTokens = new Map(), pages = 0;
    function next() {
      if (pages >= ctx.lim.maxPages) {
        ctx.warnings.push(kind + ": stopped after " + pages + " pages (page cap)");
        ctx.incomplete = true;
        return Promise.resolve();
      }
      return getJson(src.url(pageToken), ctx).then(function (body) {
        pages++;
        var list = body[src.listKey];
        if (list !== undefined && !Array.isArray(list)) throw ApiError("bad-response", "People API '" + src.listKey + "' is not a list", 200, false);
        list = list || [];
        for (var i = 0; i < list.length; i++) {
          var p = list[i];
          if (!p || typeof p !== "object") continue;
          col.add(pickName(p), "", personEmails(p));
          if (col.truncated) break;
        }
        if (progress) { try { progress({ source: kind, pages: pages, contacts: col.contacts.length }); } catch (e) { /* caller's bug, not ours */ } }
        var nt = body.nextPageToken;
        if (col.truncated || typeof nt !== "string" || !nt) return;
        if (seenTokens.has(nt)) {
          ctx.warnings.push(kind + ": server repeated a page token; stopped to avoid looping");
          ctx.incomplete = true;
          return;
        }
        seenTokens.set(nt, true);
        pageToken = nt;
        return next();
      });
    }
    return next();
  }

  // fetchContacts({
  //   accessToken : string | ({refresh}) => string|Promise<string>   required; never stored
  //   fetch       : (url, init) => Promise<Response>                 required
  //   include     : ["connections"] (default) and/or "otherContacts"
  //   signal, sleep(ms), random(), onProgress({source,pages,contacts}), limits
  // })
  // Resolves { ok, format:"people-api", contacts, stats, warnings, complete, truncated }.
  // Rejects with HyGoogleContactsError only if EVERY requested source failed;
  // a failed optional source is reported in warnings and complete:false.
  function fetchContacts(opts) {
    opts = opts || {};
    if (typeof opts.fetch !== "function") return Promise.reject(new TypeError("fetchContacts: opts.fetch must be a function"));
    if (typeof opts.accessToken !== "string" && typeof opts.accessToken !== "function") {
      return Promise.reject(new TypeError("fetchContacts: opts.accessToken must be a string or a function"));
    }
    var include = Array.isArray(opts.include) && opts.include.length ? opts.include : ["connections"];
    var kinds = [];
    for (var i = 0; i < include.length; i++) {
      if (SOURCES[include[i]] && kinds.indexOf(include[i]) === -1) kinds.push(include[i]);
    }
    if (!kinds.length) return Promise.reject(new TypeError("fetchContacts: include must name connections and/or otherContacts"));

    var lim = limitsFor(opts);
    var ctx = {
      lim: lim,
      fetch: opts.fetch,
      accessToken: opts.accessToken,
      signal: opts.signal || null,
      sleep: typeof opts.sleep === "function" ? opts.sleep : defaultSleep,
      random: typeof opts.random === "function" ? opts.random : Math.random,
      warnings: [],
      incomplete: false
    };
    var col = new Collector(lim, "api");
    var failures = [], done = 0;

    function runKind(idx) {
      if (idx >= kinds.length) return Promise.resolve();
      var k = kinds[idx];
      return listSource(k, ctx, col, opts.onProgress).then(function () { done++; }, function (err) {
        failures.push({ source: k, error: err });
        ctx.warnings.push(k + ": " + (err && err.code ? err.code : "error") + " — " + (err && err.message ? err.message : "failed"));
        if (err && (err.code === "aborted" || err.code === "bad-token")) throw err;
      }).then(function () { return runKind(idx + 1); });
    }

    return runKind(0).then(function () {
      if (!done) {
        var e = failures[0].error;
        e.partial = null;
        throw e;
      }
      var r = finish(col, { format: "people-api", warnings: ctx.warnings });
      r.complete = failures.length === 0 && !ctx.incomplete && !r.truncated;
      return r;
    });
  }

  return {
    LIMITS: LIMITS,
    SCOPES: SCOPES,
    normalizeEmail: normalizeEmail,
    cleanName: cleanName,
    createParser: createParser,
    createCsvParser: createCsvParser,
    createVcfParser: createVcfParser,
    parseExport: parseExport,
    parseCsv: parseCsv,
    parseVcf: parseVcf,
    parseFile: parseFile,
    fetchContacts: fetchContacts
  };
});
