/*
 * hyphae invite — how a person who has hyphae brings in a Gmail user who does
 * not, without a key, a code, or any capability ever being readable on the
 * channel the invite travels.
 *
 * Plain UMD, WebCrypto only. Needs crypto.js (HyCrypto), p256.js (HyP256) and
 * spake2.js (HySpake2) loaded first. Contains no I/O: every message is a string
 * the caller moves (Gmail, Matrix, paste); every piece of state is a plain
 * object the caller persists.
 *
 * Two ways in, chosen by the inviter, and the invite itself states which:
 *
 *   "code"  The inviter's extension makes a short one-time code and SPAKE2's
 *           first message goes in the invite. The inviter tells the recipient
 *           the code by voice / Signal / in person. SPAKE2 makes that short
 *           code into a strong key, authenticates both identity keys, and the
 *           invite dies after a few wrong tries. Pairing ends "verified".
 *   "sas"   No code. The invite carries the inviter's public identity key, the
 *           recipient answers with theirs, and they compare a 26-character
 *           safety number out of band. Until they do the pairing is
 *           "unverified": safe against someone who only reads the mailbox, NOT
 *           against someone who rewrites it.
 *
 * After pairing, content is an ordinary hy1 token (crypto.js) under a circle
 * both sides derive; inside the token is a signed envelope so that a holder of
 * the circle key still cannot write as someone else.
 *
 * Nothing in an invite, hello or welcome is a secret. See THREATS.md.
 */
(function (root, factory) {
  var wc = (root.crypto && root.crypto.subtle) ? root.crypto : null;
  if (!wc && typeof require === "function") wc = require("node:crypto").webcrypto;
  var H = root.HyCrypto || (typeof require === "function" ? require("../crypto.js") : null);
  var C = root.HyP256 || (typeof require === "function" ? require("./p256.js") : null);
  var S2 = root.HySpake2 || (typeof require === "function" ? require("./spake2.js") : null);
  var api = factory(wc, H, C, S2);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HyInvite = api;
})(typeof self !== "undefined" ? self : globalThis, function (webcrypto, H, C, S2) {
  "use strict";

  var subtle = webcrypto.subtle;
  var te = new TextEncoder(), td = new TextDecoder();
  var lp = S2.lp, concat = S2.concat, sha256 = S2.sha256;

  var PARAMS = {
    kdfIters: 100000,          // PBKDF2 rounds stretching the code into w
    codeBytes: 5,              // 40 bits of code: 8 characters + 2 check characters
    maxFailures: 3,            // wrong tags an invite tolerates before it dies
    ttlMs: 24 * 3600 * 1000,       // one day, single use: a code outlives its usefulness quickly
    installUrl: "https://hyphae.social/",
  };

  // ---- small codecs -------------------------------------------------------------

  function b64u(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unb64u(str) {
    if (typeof str !== "string" || /[^A-Za-z0-9_-]/.test(str)) return null;
    var s = str.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    try {
      var bin = atob(s), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) { return null; }
  }
  function hex(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return s;
  }
  function unhex(s) {
    var out = new Uint8Array(s.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }
  function rand(n) { var b = new Uint8Array(n); webcrypto.getRandomValues(b); return b; }
  function field(s) { return s === "" || s == null ? "-" : s; }
  // Lookups keyed by text from the wire must never reach Object.prototype ("constructor", "toString").
  var hasOwn = Object.prototype.hasOwnProperty;
  function own(obj, key) { return (obj && typeof key === "string" && hasOwn.call(obj, key)) ? obj[key] : undefined; }
  var MAX_TEXT = 32 * 1024 * 1024;   // beyond this a mail is not parsed (and the send guard refuses it)
  function unfield(s) { return s === "-" ? "" : s; }

  // Crockford base32 — no I, L, O, U — so a code can be read aloud.
  var ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  function toBase32(bytes) {
    var out = "", bits = 0, acc = 0;
    for (var i = 0; i < bytes.length; i++) {
      acc = (acc << 8) | bytes[i]; bits += 8;
      while (bits >= 5) { out += ALPHA[(acc >> (bits - 5)) & 31]; bits -= 5; }
      acc &= (1 << bits) - 1;
    }
    if (bits > 0) out += ALPHA[(acc << (5 - bits)) & 31];
    return out;
  }
  function fromBase32(str) {
    var out = [], bits = 0, acc = 0;
    for (var i = 0; i < str.length; i++) {
      var v = ALPHA.indexOf(str[i]);
      if (v < 0) return null;
      acc = (acc << 5) | v; bits += 5;
      if (bits >= 8) { out.push((acc >> (bits - 8)) & 255); bits -= 8; acc &= (1 << bits) - 1; }
    }
    return new Uint8Array(out);
  }
  function crc16(bytes) {
    var crc = 0xffff;
    for (var i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] << 8;
      for (var j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
  }
  function normAlnum(str) {
    return String(str).toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  }
  function groups(s, n) { return s.match(new RegExp(".{1," + n + "}", "g")).join("-"); }

  // ---- codes ----------------------------------------------------------------------

  /** A fresh one-time code: { norm, display, bits }. `bytes` defaults to PARAMS.codeBytes. */
  function newCode(bytes) {
    var cb = bytes || PARAMS.codeBytes;
    var raw = rand(cb), c = crc16(raw);
    var norm = toBase32(raw) + ALPHA[(c >> 11) & 31] + ALPHA[(c >> 6) & 31];
    return { norm: norm, display: groups(norm, 5), bits: cb * 8 };
  }
  /** The normalized form of a typed code, or null if it is mistyped (checked before anything is sent). */
  function parseCode(str, bytes) {
    var cb = bytes || PARAMS.codeBytes;
    var s = normAlnum(str), m = Math.ceil(cb * 8 / 5);
    if (s.length !== m + 2) return null;
    var raw = fromBase32(s.slice(0, m));
    if (!raw) return null;
    raw = raw.subarray(0, cb);
    var c = crc16(raw);
    if (toBase32(raw) + ALPHA[(c >> 11) & 31] + ALPHA[(c >> 6) & 31] !== s) return null;
    return s;
  }
  /** Every code of `bytes` bytes, as normalized strings (test helper: exhaustive search). */
  function* allCodes(bytes) {
    var total = Math.pow(256, bytes);
    for (var i = 0; i < total; i++) {
      var raw = new Uint8Array(bytes), v = i;
      for (var j = bytes - 1; j >= 0; j--) { raw[j] = v & 255; v = Math.floor(v / 256); }
      var c = crc16(raw);
      yield toBase32(raw) + ALPHA[(c >> 11) & 31] + ALPHA[(c >> 6) & 31];
    }
  }

  // ---- identity -------------------------------------------------------------------

  async function newIdentity(name) {
    var dh = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    var sg = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    var a = await subtle.exportKey("jwk", dh.privateKey), b = await subtle.exportKey("jwk", sg.privateKey);
    return {
      name: String(name || "").slice(0, 60),
      dh: { d: a.d, x: a.x, y: a.y },
      sign: { d: b.d, x: b.x, y: b.y },
    };
  }
  function rawPub(j) {
    var x = unb64u(j.x), y = unb64u(j.y), out = new Uint8Array(65);
    out[0] = 4; out.set(x, 1); out.set(y, 33);
    return out;
  }
  /** The public identity bundle: version byte, ECDH public key, ECDSA public key (131 bytes). */
  function bundleOf(identity) {
    return concat(new Uint8Array([1]), rawPub(identity.dh), rawPub(identity.sign));
  }
  /** Validate a bundle's bytes. Returns { bytes, dh, sign, fp } or null. */
  async function readBundle(bytes) {
    if (!bytes || bytes.length !== 131 || bytes[0] !== 1) return null;
    var dh = bytes.slice(1, 66), sg = bytes.slice(66, 131);
    if (!C.decode(dh) || !C.decode(sg)) return null;
    return { bytes: bytes, dh: dh, sign: sg, fp: hex(await sha256(bytes)) };
  }
  function shortFp(fp) { return groups(fp.slice(0, 20).toUpperCase(), 4); }

  // ---- token envelope for invite / hello / welcome -----------------------------------

  /** Drop the leading ">" a mail client adds when it quotes a message. */
  function unquote(text) {
    return String(text).slice(0, MAX_TEXT).split(/\r?\n/).map(function (l) { return l.replace(/^[\s>]+/, ""); }).join("\n");
  }
  var B64U = /[A-Za-z0-9_-]/;
  /**
   * Invite-family tokens (inv / hello / welcome) in already-unquoted `src`:
   * [{ i, len, kind, fields }]. Linear: each candidate scans at most 4096
   * characters and the number of candidates is capped.
   */
  function familyTokens(src) {
    var re = /h\s*y\s*1\s*(i\s*n\s*v|h\s*e\s*l\s*l\s*o|w\s*e\s*l\s*c\s*o\s*m\s*e)\s*\./g;
    var out = [], m, tries = 0;
    while ((m = re.exec(src)) !== null && tries++ < 2048 && out.length < 64) {
      var start = re.lastIndex, end = -1, ok = true;
      for (var j = start; j < src.length && j - start < 4096; j++) {
        var c = src.charAt(j);
        if (c === "~") { end = j; break; }
        if (!(B64U.test(c) || c === "." || c === " " || c === "\n" || c === "\t" || c === "\r")) { ok = false; break; }
      }
      if (!ok || end < 0) continue;
      out.push({
        i: m.index, len: end + 1 - m.index, kind: m[1].replace(/\s+/g, ""),
        fields: src.slice(start, end).replace(/\s+/g, "").split("."),
      });
      re.lastIndex = end + 1;
    }
    return out;
  }
  /** Every invite-family token in `text`: [{ kind, fields }]. */
  function parseTokens(text) { return familyTokens(unquote(text)); }

  /**
   * Content tokens (hy1.<kid>.<iv>.<ct>~) in already-unquoted `src`, found with a
   * linear scan so an adversarial body cannot make the extension spin: crypto.js's
   * own regex is quadratic on "hy1." repeated, so only tokens that already have the
   * right shape are ever handed to it.
   */
  function hy1Tokens(src) {
    var re = /h\s*y\s*1\s*\./g, out = [], m, tries = 0;
    while ((m = re.exec(src)) !== null && tries++ < 8192 && out.length < 512) {
      var part = 0, lens = [0, 0, 0], end = -1, ok = true;
      for (var j = re.lastIndex; j < src.length; j++) {
        var c = src.charAt(j);
        if (c === "~") { end = j; break; }
        if (c === " " || c === "\n" || c === "\t" || c === "\r") continue;
        if (c === ".") { if (++part > 2) { ok = false; break; } continue; }
        if (!B64U.test(c)) { ok = false; break; }
        lens[part]++;
        if ((part === 0 && lens[0] > 11) || (part === 1 && lens[1] > 16)) { ok = false; break; }
      }
      if (!ok || end < 0 || part !== 2 || lens[0] !== 11 || lens[1] !== 16 || lens[2] < 22) continue;
      out.push({ i: m.index, len: end + 1 - m.index });
      re.lastIndex = end + 1;
    }
    return out;
  }
  /** `src` with every token (both families) cut out, and the sealed-mail note. */
  function residueOf(src) {
    var cuts = familyTokens(src).concat(hy1Tokens(src)).sort(function (a, b) { return a.i - b.i; });
    var out = "", at = 0;
    cuts.forEach(function (t) { if (t.i >= at) { out += src.slice(at, t.i); at = t.i + t.len; } });
    out += src.slice(at);
    // the plain note above a token, in any of its phrasings (and the one earlier builds used)
    var notes = H.coverNotes().concat([SEALED_NOTE]);
    for (var n = 0; n < notes.length; n++) out = out.split(notes[n]).join("");
    return out;
  }
  function emit(kind, fields) { return "hy1" + kind + "." + fields.join(".") + "~"; }

  // ---- the words ----------------------------------------------------------------------

  // What Gmail's Subject field holds for a sealed mail. The adapter cannot seal the subject
  // (Gmail uses it in plaintext), so the person's real subject travels inside the signed
  // envelope and Google sees only this label.
  // Neither this label nor the note below names the product or says "encrypted": the mail itself
  // must not tell Google that the recipient is in a private network. How to open it travels on the
  // second channel, with the code (see setupInstructions).
  var SUBJECT_LABEL = "Message";

  var SEALED_NOTE = "Hi, sending this through. If it doesn't open on your end, let me know and I'll sort it another way.";

  /**
   * The invite email. Everything in it is public by construction: no key, no
   * code, no URL that does anything when fetched. `hasCode` only changes which
   * instruction the recipient is given.
   */
  // The plain invitation, in a few phrasings. They avoid "code", "verify" and "one-time", which
  // read as a phishing or password-reset mail, and they name neither hyphae nor encryption.
  // {n} is the inviter's name. [subject, greeting, with-code line, no-code line]
  var INVITE_WORDS = [
    ["A note from {n}", "Hi,", "I've sent you something that's locked. Message me and I'll tell you how to open it. Please don't ask me for it by email.", "I've sent you something that's locked. Message me and I'll walk you through opening it."],
    ["{n} sent you a note", "Hello,", "There's something locked here for you. Message me and I'll give you what you need to open it, another way and not by email.", "There's something locked here for you. Message me and I'll walk you through it."],
    ["From {n}", "Hi there,", "I've left something here that needs one more step to open. Message me and I'll send you that step another way, not by email.", "I've left something here that needs one more step to open. Message me and I'll show you."],
    ["Something from {n}", "Hey,", "This one's locked on purpose. Message me and I'll tell you how to open it, but not over email.", "This one's locked on purpose. Message me and I'll tell you how to open it."],
    ["A note for you", "Hi,", "I've put something here for you that won't open on its own. Message me and I'll tell you what to do, outside of email.", "I've put something here for you that won't open on its own. Message me and I'll tell you what to do."],
    ["{n}: a note for you", "Hello,", "There's a locked note for you below. Message me and I'll explain how to open it, and please don't reply here for that part.", "There's a locked note for you below. Message me and I'll explain how to open it."],
  ];

  function inviteEmail(o) {
    var name = o.name || "A friend";
    if (o.explain !== true) {
      // Default: a plain note. It does not name hyphae, encryption or a URL; how to open it
      // follows on the second channel, together with the code.
      var k = typeof o.variant === "number" ? o.variant % INVITE_WORDS.length : Math.floor(rand(1)[0] % INVITE_WORDS.length);
      var w = INVITE_WORDS[k];
      return {
        subject: w[0].split("{n}").join(name),
        body: [
          w[1],
          "",
          o.hasCode ? w[2] : w[3],
          "",
          "-- the part below is not meant to be read --",
          o.token,
        ].join("\n"),
        variant: k,
      };
    }
    return { subject: name + " wants to send you private messages (hyphae)", body: explainBody(o, name) };
  }

  /** The plain words for the second channel: what to install and do, to go with the code. */
  function setupInstructions(o) {
    o = o || {};
    var name = o.name || "I";
    return [
      "To open what " + name + " sent:",
      "1. Install hyphae, a free browser extension (Chrome, Brave, Edge): " + PARAMS.installUrl,
      "2. Open the email again; hyphae shows a \"Join\" button on it.",
      o.hasCode === false
        ? "3. hyphae shows a 26-character number. Read it back by phone or in person and check it matches."
        : "3. Type the one-time code when hyphae asks. Use it within a day. It works once.",
      "If you can't find my email, look in Spam and press \"Not spam\": it can land there at first.",
    ].join("\n");
  }

  function explainBody(o, name) {
    var steps = o.hasCode
      ? ["3. " + name + " will tell you a short code by phone, in person or on Signal. Not by email, and not by any chat",
         "   that Google runs. Type it in when hyphae asks."]
      : ["3. hyphae will show you a 26-character number. Read it to " + name + " by phone or in person and check that",
         "   it matches theirs. Until you have done that, anyone who can read your mailbox could be pretending to be one of you."];
    return [
      name + " has invited you to exchange private messages with hyphae.",
      "",
      "hyphae is a free browser extension (Chrome, Brave, Edge). It locks what " + name + " sends you so that Google,",
      "and anyone else who can see your mailbox, only ever sees scrambled characters.",
      "",
      "This email contains no password and no key, on purpose: anything in an email, Google can read.",
      "",
      "To set up:",
      "1. Install hyphae. Search for \"hyphae\" in your browser's extension store, or go to " + PARAMS.installUrl,
      "2. Open this email again. hyphae will show a \"Join\" button on it.",
      steps[0], steps[1],
      "",
      o.hasCode
        ? "If you were not expecting this, ignore it. Nothing happens unless you type in a code from someone you know."
        : "If you were not expecting this, ignore it, and do not read any number to anyone who calls you about it.",
      "",
      "-- the part below is for hyphae, you do not need to read it --",
      o.token,
    ].join("\n");
  }

  // ---- the agent --------------------------------------------------------------------

  var ENV_KEYS = ["v", "t", "from", "to", "kid", "ts", "id", "kind", "name", "mime", "body"];

  function Agent(opts) {
    opts = opts || {};
    this.identity = opts.identity;
    this.params = Object.assign({}, PARAMS, opts.params || {});
    this.now = opts.now || function () { return Date.now(); };
    this.state = opts.state || { invites: {}, pending: {}, contacts: {}, groups: {}, alarms: [], seen: {}, outbox: [] };
    this._keys = null;
    this._bundle = null;
    this._q = null;
  }

  /** Run state-changing work one at a time: the try budget is only a budget if checks and writes cannot interleave. */
  Agent.prototype._serial = function (fn) {
    var run = (this._q || Promise.resolve()).then(fn);
    this._q = run.catch(function () {});
    return run;
  };
  Agent.prototype._alarm = function (a) {
    this.state.alarms.push(a);
    if (this.state.alarms.length > 100) this.state.alarms.splice(0, this.state.alarms.length - 100);
  };
  /** Drop what has aged out: spent invite secrets, unanswered pending joins. */
  Agent.prototype._gc = function () {
    var now = this.now(), k;
    for (k in this.state.invites) {
      var inv = this.state.invites[k];
      if (now > inv.expires + 24 * 3600 * 1000) { killSecrets(inv); if (inv.state === "open") inv.state = "dead"; }
    }
    for (k in this.state.pending) if (now > this.state.pending[k].expires) delete this.state.pending[k];
  };

  Agent.prototype.bundle = async function () {
    if (!this._bundle) this._bundle = await readBundle(bundleOf(this.identity));
    return this._bundle;
  };
  Agent.prototype.fp = async function () { return (await this.bundle()).fp; };

  Agent.prototype._priv = async function () {
    if (!this._keys) {
      var id = this.identity;
      var dhJ = { kty: "EC", crv: "P-256", d: id.dh.d, x: id.dh.x, y: id.dh.y };
      var sgJ = { kty: "EC", crv: "P-256", d: id.sign.d, x: id.sign.x, y: id.sign.y };
      this._keys = {
        dh: await subtle.importKey("jwk", dhJ, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
        sign: await subtle.importKey("jwk", sgJ, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
      };
    }
    return this._keys;
  };
  Agent.prototype._sign = async function (msg) {
    var k = (await this._priv()).sign;
    return new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k, msg));
  };
  async function verifySig(signPubRaw, sig, msg) {
    try {
      var k = await subtle.importKey("raw", signPubRaw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, sig, msg);
    } catch (e) { return false; }
  }
  Agent.prototype._dh = async function (peerDhRaw) {
    var pk = await subtle.importKey("raw", peerDhRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
    return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: pk }, (await this._priv()).dh, 256));
  };

  /** The circle both sides derive. `ke` is the SPAKE2 key in code mode, empty in sas mode. */
  Agent.prototype._pairCircle = async function (peerBundle, ke, label) {
    var mine = await this.bundle();
    var dh = await this._dh(peerBundle.dh);
    var a = mine.fp < peerBundle.fp ? mine : peerBundle, b = a === mine ? peerBundle : mine;
    var salt = await sha256(concat(te.encode("hyphae/pair/salt/v1\0"), a.bytes, b.bytes));
    var okm = await S2.hkdf(concat(dh, ke || new Uint8Array(0)), salt, "hyphae/pair/circle/v1", 40);
    return { kid: b64u(okm.slice(0, 8)), key: b64u(okm.slice(8)), name: String(label || "pair").slice(0, 60) };
  };

  // ---- inviter ------------------------------------------------------------------------

  /**
   * Make an invite for `to` (an address — a label for the human, never trusted
   * as proof of anything). mode "code" returns the code in `code` for the
   * inviter to SAY or Signal; it is not in `email`.
   */
  Agent.prototype.createInvite = async function (o) {
    var mode = o.mode === "sas" ? "sas" : "code";
    var mine = await this.bundle();
    var iid = b64u(rand(8));
    var inv = {
      iid: iid, to: String(o.to || "").toLowerCase(), mode: mode, label: o.label || "",
      created: this.now(), expires: this.now() + (o.ttlMs || this.params.ttlMs),
      state: "open", failures: 0, responders: [],
    };
    var X = null, code = null;
    if (mode === "code") {
      code = newCode(this.params.codeBytes);
      var w = await S2.deriveW(code.norm, lp(["hyphae/invite/ctx/v1", b64u(unb64u(iid)), mine.bytes]), this.params.kdfIters);
      var st = await S2.start("A", w);
      X = st.msg;
      inv.x = st.x.toString(16);
      inv.w = w.toString(16);
      inv.code = code.norm;
    }
    this.state.invites[iid] = inv;
    var token = emit("inv", [
      "1", iid, b64u(mine.bytes), X ? b64u(X) : "-", field(b64u(te.encode(this.identity.name || ""))),
      Math.floor(inv.expires / 1000).toString(36),
    ]);
    return {
      iid: iid, token: token, code: code ? code.display : null,
      email: inviteEmail({ name: this.identity.name, hasCode: mode === "code", token: token, explain: !!o.explain }),
      setup: setupInstructions({ name: this.identity.name, hasCode: mode === "code" }),
    };
  };

  function killSecrets(inv) { delete inv.x; delete inv.w; delete inv.code; }

  /**
   * Handle a hello (R's answer). Returns { ok, reason?, welcome?, contact?, alarm? }.
   * Only a guess that is structurally a guess (valid point, valid bundle) is
   * counted against the invite's tries; junk is simply dropped.
   */
  Agent.prototype.acceptHello = function (text) {
    var self = this;
    return this._serial(async function () {
      self._gc();
      var toks = parseTokens(text).filter(function (t) { return t.kind === "hello"; });
      if (!toks.length) return { ok: false, reason: "no-hello" };
      var results = [];
      for (var i = 0; i < toks.length; i++) results.push(await self._acceptOne(toks[i].fields));
      if (results.length === 1) return results[0];
      var firstOk = results.filter(function (r) { return r.ok; })[0];
      return Object.assign({ ok: !!firstOk, results: results }, firstOk || {});
    });
  };

  Agent.prototype._acceptOne = async function (f) {
    if (f.length !== 6) return { ok: false, reason: "malformed" };
    var iid = f[0], inv = own(this.state.invites, iid);
    if (!inv) return { ok: false, reason: "unknown-invite" };
    if (!Array.isArray(inv.responders)) inv.responders = [];
    var bR = unb64u(f[1]) && await readBundle(unb64u(f[1]));
    var Y = f[2] === "-" ? null : unb64u(f[2]);
    var sig = unb64u(f[3]), tagR = f[4] === "-" ? null : unb64u(f[4]);
    var label = unb64u(unfield(f[5]) || "");
    if (!bR || !sig || sig.length !== 64) return { ok: false, reason: "malformed" };
    var rClaims = label ? td.decode(label).slice(0, 60) : "";
    var mine = await this.bundle();
    var now = this.now();

    if (inv.state === "locked" || inv.state === "dead") return { ok: false, reason: inv.state };
    if (now > inv.expires) { inv.state = "dead"; killSecrets(inv); return { ok: false, reason: "expired" }; }

    var sigMsg = lp(["hyphae/hello/v1", b64u(unb64u(iid)), mine.bytes, bR.bytes, Y || new Uint8Array(0)]);

    if (inv.mode === "code") {
      // The invite promised a code. A hello that does not prove it is not a downgrade
      // we accept — and it is not a guess either, so it costs the invite nothing.
      if (!Y || !tagR || Y.length !== 33) return { ok: false, reason: "no-code-proof" };
      var w = BigInt("0x" + inv.w), x = BigInt("0x" + inv.x);
      var K = await S2.finish("A", w, x, Y);
      if (!K) return { ok: false, reason: "bad-point" };
      var X = C.encode(C.add(C.mul(x, C.G), C.mul(w, (await S2.points()).M)));
      var tt = lp(["hyphae/invite/tt/v1", b64u(unb64u(iid)), mine.bytes, bR.bytes, X, Y, K, C.i2b(w, 32)]);
      var sch = await S2.schedule(tt);
      var want = await S2.tag(sch.kcB, sch.h, "hello");
      var good = S2.ctEq(want, tagR);
      if (inv.state === "used") {
        if (good && inv.responderFp === bR.fp && inv.helloY === b64u(Y)) {
          // The very same hello again (a retry, a duplicate delivery, a replay): nothing new
          // is learned or granted, and a lost welcome is simply sent again.
          var again = emit("welcome", [
            b64u(unb64u(iid)), b64u(await S2.tag(sch.kcA, sch.h, "welcome")),
            b64u(await this._sign(lp(["hyphae/welcome/v1", sch.h]))),
          ]);
          return { ok: true, duplicate: true, welcome: again, to: inv.to };
        }
        // The same device answering again with a fresh hello: not a second party.
        if (good && inv.responderFp === bR.fp) return { ok: false, reason: "used", note: "same-responder" };
        // Someone else who knows the code answered after the invite was already used.
        if (good) {
          this._alarm({ type: "code-used-twice", iid: iid, at: now });
          return { ok: false, reason: "used", alarm: "code-used-twice" };
        }
        return { ok: false, reason: "used" };
      }
      if (inv.state !== "open") return { ok: false, reason: inv.state };
      if (!good) {
        inv.failures++;
        if (inv.failures >= this.params.maxFailures) { inv.state = "locked"; killSecrets(inv); }
        return { ok: false, reason: "bad-tag", failures: inv.failures, locked: inv.state === "locked" };
      }
      if (!(await verifySig(bR.sign, sig, sigMsg))) return { ok: false, reason: "bad-signature" };
      var circle = await this._pairCircle(bR, sch.ke, inv.to);
      var contact = this._addContact(bR, "verified-code", circle, inv.to, rClaims, iid);
      inv.state = "used";
      inv.usedAt = now;
      inv.responderFp = bR.fp;
      inv.helloY = b64u(Y);
      delete inv.code;                 // the code is spent; x and w stay only to recognise a late second user
      var welcome = emit("welcome", [
        b64u(unb64u(iid)), b64u(await S2.tag(sch.kcA, sch.h, "welcome")),
        b64u(await this._sign(lp(["hyphae/welcome/v1", sch.h]))),
      ]);
      return { ok: true, status: "verified-code", contact: contact, welcome: welcome, to: inv.to };
    }

    // sas mode: nothing proves who R is. Record a candidate; first contact is unverified.
    if (Y || tagR) return { ok: false, reason: "mode-mismatch" };
    if (!(await verifySig(bR.sign, sig, sigMsg))) return { ok: false, reason: "bad-signature" };
    var c2 = await this._pairCircle(bR, null, inv.to);
    var existing = own(this.state.contacts, bR.fp);
    var contact2 = this._addContact(bR, "unverified", c2, inv.to, rClaims, iid);
    if (inv.responders.indexOf(bR.fp) < 0) inv.responders.push(bR.fp);
    var out = { ok: true, status: existing ? existing.status : "unverified", contact: contact2, to: inv.to };
    if (inv.responders.length > 1) {
      out.alarm = "multiple-responders";
      this._alarm({ type: "multiple-responders", iid: iid, fps: inv.responders.slice(), at: now });
    }
    return out;
  };

  /**
   * `address` binds the contact to a mail address and is only passed for addresses the
   * local person typed (the inviter's own `to`). An address read from a received mail's
   * From header is a claim: `claimedAddress`, bound later by bindAddress().
   */
  Agent.prototype._addContact = function (b, status, circle, address, claims, iid, claimedAddress) {
    var c = own(this.state.contacts, b.fp);
    var rank = { unverified: 0, "verified-sas": 1, "verified-code": 2 };
    if (!c) {
      c = this.state.contacts[b.fp] = {
        fp: b.fp, bundle: b64u(b.bytes), label: "", claims: claims || "", addresses: [], addressClaims: [], status: status,
        circle: circle, since: this.now(), via: iid,
      };
    } else if (rank[status] > rank[c.status]) {
      c.status = status; c.circle = circle;
    }
    if (address && c.addresses.indexOf(address) < 0) c.addresses.push(address);
    if (!Array.isArray(c.addressClaims)) c.addressClaims = [];
    if (claimedAddress && c.addressClaims.indexOf(claimedAddress) < 0 && c.addressClaims.length < 8) c.addressClaims.push(claimedAddress);
    return c;
  };
  /** The person confirms "this key is that address". Only this makes an address resolve to a contact on the joiner's side. */
  Agent.prototype.bindAddress = function (fp, addr) {
    var c = own(this.state.contacts, fp);
    addr = String(addr || "").toLowerCase();
    if (!c || !addr) return false;
    if (c.addresses.indexOf(addr) < 0) c.addresses.push(addr);
    return true;
  };

  // ---- joiner -------------------------------------------------------------------------

  /** Parse an invite out of mail text. { ok, invite } — invite is untrusted data. */
  Agent.prototype.readInvite = async function (text, ctx) {
    var toks = parseTokens(text).filter(function (t) { return t.kind === "inv"; });
    if (!toks.length) return { ok: false, reason: "no-invite" };
    var f = toks[0].fields;
    if (f.length !== 6 || f[0] !== "1") return { ok: false, reason: "malformed" };
    var bS = unb64u(f[2]) && await readBundle(unb64u(f[2]));
    if (!bS) return { ok: false, reason: "bad-bundle" };
    var X = f[3] === "-" ? null : unb64u(f[3]);
    if (X && (X.length !== 33 || !C.decode(X))) return { ok: false, reason: "bad-point" };
    var labelBytes = unb64u(unfield(f[4]) || "");
    var inv = {
      iid: f[1], bundle: bS, X: X, mode: X ? "code" : "sas",
      claimsToBe: labelBytes ? td.decode(labelBytes).slice(0, 60) : "",   // self-asserted, never shown as a name
      expires: parseInt(f[5], 36) * 1000, from: ctx && ctx.from ? String(ctx.from).toLowerCase() : "",
    };
    var known = own(this.state.contacts, bS.fp);
    var out = { ok: true, invite: inv };
    if (known) out.alreadyPaired = known.status;
    // A different key arriving from an address that already maps to a contact is a key change.
    if (inv.from) {
      var clash = this._byAddress(inv.from, true).filter(function (c) { return c.fp !== bS.fp; });
      if (clash.length) out.keyChange = clash.map(function (c) { return c.fp; });
    }
    return out;
  };

  /**
   * Answer an invite. `code` is what the person typed (or null). Returns
   * { ok, hello, email? } or { ok:false, reason }.
   */
  Agent.prototype.join = function (invite, o) {
    var self = this;
    return this._serial(function () { return self._join(invite, o); });
  };
  Agent.prototype._join = async function (invite, o) {
    o = o || {};
    this._gc();
    var now = this.now();
    if (now > invite.expires) return { ok: false, reason: "expired" };
    var mine = await this.bundle();
    var iidB = b64u(unb64u(invite.iid));
    var label = field(b64u(te.encode(this.identity.name || "")));
    var typed = o.code ? parseCode(o.code, this.params.codeBytes) : null;
    if (o.code && !typed) return { ok: false, reason: "mistyped-code" };

    if (invite.mode === "code") {
      if (!typed) return { ok: false, reason: "needs-code" };
      var w = await S2.deriveW(typed, lp(["hyphae/invite/ctx/v1", iidB, invite.bundle.bytes]), this.params.kdfIters);
      var wh = b64u(await sha256(C.i2b(w, 32)));
      // Pressing Join twice with the same code must give the same hello, not a second one
      // that strands the first (the inviter would accept one and the joiner expect the other).
      var prev = own(this.state.pending, invite.iid);
      if (prev && prev.wh === wh && prev.hello && now < prev.expires) return { ok: true, hello: prev.hello, mode: "code", again: true };
      // Every code typed in answers one invite, and an invite nobody confirms may be a spoofed
      // one testing a guess. Only a few can be outstanding, so a stream of fake invites
      // cannot be turned into a stream of guesses against the person's real code.
      var outstanding = 0;
      for (var pid in this.state.pending) {
        var pp = this.state.pending[pid];
        if (pid !== invite.iid && pp.mode === "code" && now - pp.created < 24 * 3600 * 1000) outstanding++;
      }
      if (outstanding >= this.params.maxFailures) return { ok: false, reason: "too-many-unconfirmed" };
      var st = await S2.start("B", w);
      var K = await S2.finish("B", w, st.x, invite.X);
      if (!K) return { ok: false, reason: "bad-point" };
      var tt = lp(["hyphae/invite/tt/v1", iidB, invite.bundle.bytes, mine.bytes, invite.X, st.msg, K, C.i2b(w, 32)]);
      var sch = await S2.schedule(tt);
      var sigMsg = lp(["hyphae/hello/v1", iidB, invite.bundle.bytes, mine.bytes, st.msg]);
      this.state.pending[invite.iid] = {
        iid: invite.iid, bundle: b64u(invite.bundle.bytes), mode: "code", created: now,
        expires: invite.expires, tagA: b64u(await S2.tag(sch.kcA, sch.h, "welcome")),
        ke: b64u(sch.ke), h: b64u(sch.h), from: invite.from, claims: invite.claimsToBe, wh: wh,
      };
      var hello = emit("hello", [
        iidB, b64u(mine.bytes), b64u(st.msg), b64u(await this._sign(sigMsg)),
        b64u(await S2.tag(sch.kcB, sch.h, "hello")), label,
      ]);
      this.state.pending[invite.iid].hello = hello;
      return { ok: true, hello: hello, mode: "code" };
    }

    // sas: the invite had no code part. If the person HAS a code, this invite has been altered.
    if (typed) return { ok: false, reason: "downgrade" };
    var sigMsg2 = lp(["hyphae/hello/v1", iidB, invite.bundle.bytes, mine.bytes, new Uint8Array(0)]);
    var circle = await this._pairCircle(invite.bundle, null, invite.from || "contact");
    var c = this._addContact(invite.bundle, "unverified", circle, "", invite.claimsToBe, invite.iid, invite.from);
    var hello2 = emit("hello", [iidB, b64u(mine.bytes), "-", b64u(await this._sign(sigMsg2)), "-", label]);
    return { ok: true, hello: hello2, mode: "sas", contact: c };
  };

  /** Handle the inviter's welcome. Only a valid one changes anything. */
  Agent.prototype.acceptWelcome = function (text) {
    var self = this;
    return this._serial(function () { return self._acceptWelcome(text); });
  };
  Agent.prototype._acceptWelcome = async function (text) {
    this._gc();
    var toks = parseTokens(text).filter(function (t) { return t.kind === "welcome"; });
    if (!toks.length) return { ok: false, reason: "no-welcome" };
    var last = { ok: false, reason: "unknown-invite" };
    for (var i = 0; i < toks.length; i++) {
      var f = toks[i].fields;
      if (f.length !== 3) { last = { ok: false, reason: "malformed" }; continue; }
      var p = own(this.state.pending, f[0]);
      if (!p) {
        // A welcome for an invite this device never answered: somebody else used the code.
        this._alarm({ type: "unsolicited-welcome", iid: String(f[0]).slice(0, 16), at: this.now() });
        last = { ok: false, reason: "unsolicited", alarm: "unsolicited-welcome" };
        continue;
      }
      var tag = unb64u(f[1]), sig = unb64u(f[2]);
      if (!tag || !sig || sig.length !== 64) { last = { ok: false, reason: "malformed" }; continue; }
      if (this.now() > p.expires) { last = { ok: false, reason: "expired" }; continue; }
      var bS = await readBundle(unb64u(p.bundle));
      if (!S2.ctEq(tag, unb64u(p.tagA))) { last = { ok: false, reason: "bad-tag", alarm: "invalid-welcome" }; continue; }
      if (!(await verifySig(bS.sign, sig, lp(["hyphae/welcome/v1", unb64u(p.h)])))) { last = { ok: false, reason: "bad-signature" }; continue; }
      var circle = await this._pairCircle(bS, unb64u(p.ke), p.from || "contact");
      var c = this._addContact(bS, "verified-code", circle, "", p.claims, f[0], p.from);
      delete this.state.pending[f[0]];
      return { ok: true, status: "verified-code", contact: c };
    }
    return last;
  };

  // ---- contacts, safety number -------------------------------------------------------

  Agent.prototype._byAddress = function (addr, withClaims) {
    addr = String(addr || "").toLowerCase();
    var out = [], cs = this.state.contacts;
    for (var k in cs) {
      var c = cs[k];
      if (c.addresses.indexOf(addr) >= 0 || (withClaims && c.addressClaims && c.addressClaims.indexOf(addr) >= 0)) out.push(c);
    }
    return out;
  };
  /**
   * Who an address is. A verified contact wins; a lone unverified one is
   * offered as such; several unverified ones are ambiguous and are never
   * guessed between.
   */
  Agent.prototype.contactForAddress = function (addr) {
    var all = this._byAddress(addr);
    var ver = all.filter(function (c) { return c.status !== "unverified"; });
    if (ver.length === 1) return { contact: ver[0] };
    if (ver.length > 1) return { ambiguous: ver };
    if (all.length === 1) return { contact: all[0] };
    if (all.length > 1) return { ambiguous: all };
    return { contact: null };
  };

  /** The 26-character number both people read to each other (or fewer bits, for tests of why not). */
  async function safetyNumberOf(bundleA, bundleB, bits) {
    var a = bundleA.fp < bundleB.fp ? bundleA : bundleB, b = a === bundleA ? bundleB : bundleA;
    var d = await sha256(lp(["hyphae/safety/v1", a.bytes, b.bytes]));
    var nb = bits || 130, chars = Math.ceil(nb / 5);
    return groups(toBase32(d).slice(0, chars), 5);
  }
  Agent.prototype.safetyNumber = async function (fp, bits) {
    var c = own(this.state.contacts, fp);
    if (!c) return null;
    return safetyNumberOf(await this.bundle(), await readBundle(unb64u(c.bundle)), bits);
  };
  /** The person typed what the other side read out. Only an exact match upgrades the contact. */
  Agent.prototype.confirmSafetyNumber = async function (fp, typed, bits) {
    var c = own(this.state.contacts, fp);
    if (!c) return { ok: false, reason: "unknown-contact" };
    var want = normAlnum(await this.safetyNumber(fp, bits));
    var got = normAlnum(typed);
    if (!S2.ctEq(te.encode(want), te.encode(got))) return { ok: false, reason: "mismatch" };
    if (c.status === "unverified") c.status = "verified-sas";
    c.safetyConfirmed = true;
    return { ok: true, status: c.status };
  };

  Agent.prototype.addGroup = function (circle, memberBundles) {
    this.state.groups[circle.kid] = { circle: circle, members: memberBundles.map(function (b) { return b64u(b.bytes || b); }) };
  };

  // ---- sealing and opening content ------------------------------------------------------

  function orderedEnvelope(e) {
    var o = {};
    for (var i = 0; i < ENV_KEYS.length; i++) o[ENV_KEYS[i]] = e[ENV_KEYS[i]];
    return o;
  }
  function envMessage(e) { return te.encode("hyphae/env/v1\0" + JSON.stringify(orderedEnvelope(e))); }

  Agent.prototype._sealEnvelope = async function (circle, to, payload) {
    var me = await this.fp();
    var e = {
      v: 1, t: "msg", from: me, to: to, kid: circle.kid, ts: this.now(), id: b64u(rand(12)),
      kind: payload.kind || "text", name: payload.name || "", mime: payload.mime || "", body: payload.body,
    };
    var sig = await this._sign(envMessage(e));
    return H.seal(circle, JSON.stringify({ e: orderedEnvelope(e), s: b64u(sig) }));
  };

  /**
   * Seal `text` to a contact. Refuses an unverified contact unless the caller
   * says, in so many words, that it knows what that means.
   */
  Agent.prototype.sealTo = async function (fp, text, o) {
    o = o || {};
    var c = own(this.state.contacts, fp);
    if (!c) throw new Error("no such contact");
    if (c.status === "unverified" && !o.allowUnverified) throw new Error("unverified: compare the safety number first");
    // `subject` is the real subject; it rides inside the envelope (the `name` field, signed).
    return this._sealEnvelope(c.circle, fp, { kind: "text", name: String(o.subject || "").slice(0, 300), body: String(text) });
  };
  Agent.prototype.sealGroup = async function (kid, text) {
    var g = own(this.state.groups, kid);
    if (!g) throw new Error("no such group");
    return this._sealEnvelope(g.circle, "*", { kind: "text", body: String(text) });
  };
  /** A file (Drive upload, attachment): bytes become base64url inside the same envelope. */
  Agent.prototype.sealFile = async function (fp, file, o) {
    o = o || {};
    var c = own(this.state.contacts, fp);
    if (!c) throw new Error("no such contact");
    if (c.status === "unverified" && !o.allowUnverified) throw new Error("unverified: compare the safety number first");
    return this._sealEnvelope(c.circle, fp, { kind: "file", name: file.name, mime: file.mime, body: b64u(file.bytes) });
  };
  /** The body of a sealed email: the note a non-hyphae reader sees, then one token per recipient. */
  function sealedBody(tokens) { return H.coverNote() + "\n\n" + tokens.join("\n\n"); }

  /**
   * For a display path that cannot call Agent.open(): the readable body out of an
   * opened envelope, or the text unchanged. It does NOT check the signature, so
   * whatever it returns must not be shown as "from <person>".
   */
  function unwrap(plain) {
    try {
      var p = JSON.parse(plain);
      if (p && p.e && typeof p.e.body === "string" && p.e.v === 1) return { body: p.e.body, kind: p.e.kind, name: p.e.name, unverified: true };
    } catch (e) { /* not an envelope */ }
    return { body: plain, kind: "text", name: "", unverified: true };
  }

  Agent.prototype._peerSign = async function (fp) {
    var me = await this.fp();
    if (fp === me) return (await this.bundle()).sign;
    var c = own(this.state.contacts, fp);
    if (c) { var cb = await readBundle(unb64u(c.bundle)); return cb ? cb.sign : null; }
    for (var kid in this.state.groups) {
      var ms = this.state.groups[kid].members;
      for (var i = 0; i < ms.length; i++) {
        var b = await readBundle(unb64u(ms[i]));
        if (b && b.fp === fp) return b.sign;
      }
    }
    return null;
  };

  /**
   * Open every sealed token in `text` that we hold a key for. Each result:
   *   { ok, authentic, from, body, kind, ts, id, seenBefore, contactStatus } or { ok:false, reason }.
   * `authentic` is true only when a signature by a pinned key we know checks out
   * AND names this circle and this recipient. One malformed token never costs the
   * others: each is handled on its own.
   */
  Agent.prototype.open = async function (text) {
    var me = await this.fp();
    var byKid = Object.create(null);
    for (var fp in this.state.contacts) { var cc = this.state.contacts[fp].circle; if (cc) byKid[cc.kid] = cc; }
    for (var kid in this.state.groups) byKid[kid] = this.state.groups[kid].circle;
    var src = unquote(text);
    var found = hy1Tokens(src);
    if (!found.length) return [];
    var joined = found.map(function (t) { return src.slice(t.i, t.i + t.len); }).join("\n");
    var segs = await H.revealSegments(joined, byKid);
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (!s.token) continue;
      try { out.push(await this._openOne(s, me)); } catch (e) { out.push({ ok: false, reason: "malformed" }); }
    }
    return out;
  };
  Agent.prototype._openOne = async function (s, me) {
    if (s.plain === null) return { ok: false, reason: "locked" };
    var parsed = null;
    try { parsed = JSON.parse(s.plain); } catch (e) { /* not an envelope */ }
    if (!parsed || typeof parsed !== "object" || !parsed.e || typeof parsed.e !== "object" || typeof parsed.s !== "string") {
      return { ok: true, authentic: false, reason: "unsigned", body: s.plain };
    }
    var e = parsed.e, sane = e.v === 1 && e.t === "msg" && typeof e.from === "string" &&
      typeof e.body === "string" && typeof e.to === "string" && typeof e.kid === "string" && typeof e.id === "string";
    if (!sane) return { ok: false, reason: "malformed-envelope" };
    var signPub = await this._peerSign(e.from);
    var sig = unb64u(parsed.s);
    var sigOk = !!(signPub && sig && await verifySig(signPub, sig, envMessage(e)));
    // The envelope must name the circle it arrived in and be for us (or the group).
    var tokKid = s.token.replace(/\s+/g, "").split(".")[1];
    var named = e.kid === tokKid && (e.to === me || e.to === "*" || e.from === me);
    var peer = own(this.state.contacts, e.from);
    var res = {
      ok: true, authentic: sigOk && named, from: e.from, kind: e.kind, ts: e.ts, id: e.id,
      name: e.name, mime: e.mime, body: e.body, contactStatus: peer ? peer.status : (e.from === me ? "self" : "group-or-unknown"),
    };
    if (sigOk && named && e.kind === "text" && e.name) res.subject = e.name;
    if (!sigOk) res.reason = signPub ? "bad-signature" : "unknown-sender";
    else if (!named) res.reason = "wrong-circle-or-recipient";
    var idOk = /^[A-Za-z0-9_-]{1,32}$/.test(e.id) && e.id !== "__proto__";
    res.seenBefore = idOk && !!own(this.state.seen, e.id);
    if (sigOk && named && idOk && !own(this.state.seen, e.id)) this.state.seen[e.id] = this.now();
    return res;
  };

  // ---- the send guard ---------------------------------------------------------------------

  /**
   * Called by the Gmail adapter on Send, with what is about to go into Gmail's
   * own fields. It can only say no. Returns { allow, blocks:[…], warns:[…] }.
   *
   * It never needs a key: it compares against secrets this agent already holds.
   */
  Agent.prototype.guardSend = function (o) {
    var self = this, blocks = [], warns = [];
    var subject = String(o.subject || ""), body = String(o.body || "");
    if (subject.length + body.length > MAX_TEXT) return { allow: false, blocks: [{ code: "too-large-to-check" }], warns: [] };
    var whole = subject + "\n" + body;
    var norm = normAlnum(whole), compact = whole.replace(/\s+/g, "");
    var src = unquote(body);
    var content = hy1Tokens(src), family = familyTokens(src);
    var residue = residueOf(src);

    // 1. a secret this agent holds, in any text bound for Google
    for (var iid in this.state.invites) {
      var inv = this.state.invites[iid];
      if (!inv.code) continue;
      // the 40 secret bits are the leading characters; the last two are only a check
      var core = inv.code.slice(0, Math.max(1, inv.code.length - 2));
      if (norm.indexOf(core) >= 0) blocks.push({ code: "invite-code-in-text", iid: iid });
    }
    var keyed = {};
    function addKey(b64, what) {
      keyed[b64] = what;
      var raw = unb64u(b64);
      if (raw) keyed[hex(raw)] = what;
    }
    for (var fp in this.state.contacts) addKey(this.state.contacts[fp].circle.key, "pair-key");
    for (var kid in this.state.groups) addKey(this.state.groups[kid].circle.key, "circle-key");
    addKey(this.identity.dh.d, "identity-key");
    addKey(this.identity.sign.d, "identity-key");
    var lower = compact.toLowerCase();
    for (var secret in keyed) {
      if (compact.indexOf(secret) >= 0 || lower.indexOf(secret.toLowerCase()) >= 0) blocks.push({ code: "key-in-text", what: keyed[secret] });
    }
    var resCompact = residue.replace(/\s+/g, "");
    if (/hy1key\./.test(resCompact) || /hy1key\./.test(compact)) blocks.push({ code: "key-in-text", what: "share-string" });
    if (H.fromWritten && residue.length < 2 * 1024 * 1024) {
      var m = residue.match(/([0-9A-Za-z]{4}\s*-\s*){16}[0-9A-Za-z]{4}/);
      if (m && H.fromWritten(m[0])) blocks.push({ code: "key-in-text", what: "written-code" });
    }

    // 2. readable text going to a person we have a sealed relationship with
    var hasToken = content.length > 0;
    var recips = (o.recipients || []).map(function (r) { return String(r).toLowerCase(); });
    var known = [], unknown = [];
    recips.forEach(function (r) {
      var cf = self.contactForAddress(r);
      if (cf.contact || cf.ambiguous) known.push({ addr: r, c: cf.contact, amb: cf.ambiguous }); else unknown.push(r);
    });
    // An invite mail is exempt only when it IS the invite template and nothing else: a
    // reply that quotes an old invite and adds words of its own is ordinary plaintext.
    var inviteOnly = false;
    if (family.some(function (t) { return t.kind === "inv"; }) && !hasToken) {
      var name = this.identity.name;
      inviteOnly = [true, false].some(function (hc) {
        return [true, false].some(function (ex) {
          for (var v = 0; v < INVITE_WORDS.length; v++) {
            var tpl = inviteEmail({ name: name, hasCode: hc, token: "", explain: ex, variant: v }).body.replace(/\s+/g, "");
            if (resCompact === tpl) return true;
            if (ex) break;   // the long explanation has no variants
          }
          return false;
        });
      });
    }
    var resLen = resCompact.length;
    if (known.length && !inviteOnly) {
      if (!hasToken) blocks.push({ code: "plaintext-to-sealed-contact", to: known.map(function (k) { return k.addr; }) });
      else if (resLen) blocks.push({ code: "plaintext-beside-token", to: known.map(function (k) { return k.addr; }) });
    }
    known.forEach(function (k) {
      if (k.amb) blocks.push({ code: "ambiguous-contact", to: k.addr });
      else if (k.c && k.c.status === "unverified" && hasToken) warns.push({ code: "unverified-contact", to: k.addr });
    });
    if (unknown.length && hasToken) warns.push({ code: "recipient-cannot-open", to: unknown, action: "invite" });
    if (unknown.length && !hasToken && !inviteOnly && o.sealRequired) blocks.push({ code: "plaintext-while-sealing", to: unknown });

    // 3. subject: Gmail stores it as plaintext, so a sealed mail carries only the fixed label
    var subjCore = subject.replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i, "").trim();
    if (hasToken && subjCore !== "" && subjCore.toLowerCase() !== SUBJECT_LABEL.toLowerCase()) {
      if (o.allowReadableSubject) warns.push({ code: "subject-readable" });
      else blocks.push({ code: "subject-readable" });
    }
    return { allow: blocks.length === 0, blocks: blocks, warns: warns };
  };

  /** Fields an invite email may contain — everything else found there is a defect (used by tests). */
  function auditPublicText(text, secrets) {
    var found = [], compact = String(text).replace(/\s+/g, ""), norm = normAlnum(text);
    (secrets || []).forEach(function (s) {
      if (!s) return;
      var needle = String(s);
      if (compact.indexOf(needle.replace(/\s+/g, "")) >= 0 || norm.indexOf(normAlnum(needle)) >= 0) found.push(needle.slice(0, 8) + "…");
    });
    return found;
  }

  return {
    PARAMS: PARAMS, Agent: Agent, newIdentity: newIdentity, bundleOf: bundleOf, readBundle: readBundle,
    newCode: newCode, parseCode: parseCode, allCodes: allCodes, normalize: normAlnum,
    parseTokens: parseTokens, inviteEmail: inviteEmail, setupInstructions: setupInstructions, sealedBody: sealedBody, SEALED_NOTE: SEALED_NOTE, SUBJECT_LABEL: SUBJECT_LABEL, unwrap: unwrap, hy1Tokens: hy1Tokens,
    safetyNumberOf: safetyNumberOf, shortFp: shortFp, auditPublicText: auditPublicText, unquote: unquote,
    b64u: b64u, unb64u: unb64u, hex: hex, lp: lp, verifySig: verifySig,
  };
});
