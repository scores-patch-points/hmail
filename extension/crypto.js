/*
 * hyphae sealing — the whole format and cipher in one dependency-free file.
 *
 * A sealed token is plain ASCII, so it survives any app that stores text:
 *
 *     hy1.<circle id>.<iv>.<ciphertext>~
 *
 * AES-256-GCM under the circle's key, with the circle id bound in as
 * additional data (a token can't be re-labelled as another circle's). The
 * trailing "~" ends the token, and whitespace ANYWHERE inside it is ignored,
 * so a token a mail client or editor has line-wrapped — even inside the
 * header — still opens.
 *
 * Loaded as a classic script in the page (content.js), the popup and the
 * worker (global HyCrypto), and with require() in Node for tests.
 */
(function (root, factory) {
  var wc = (root.crypto && root.crypto.subtle) ? root.crypto : null;
  if (!wc && typeof require === "function") wc = require("node:crypto").webcrypto;
  var api = factory(wc);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HyCrypto = api;
})(typeof self !== "undefined" ? self : globalThis, function (webcrypto) {
  "use strict";

  var enc = new TextEncoder();
  var dec = new TextDecoder();

  function b64uEncode(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64uDecode(str) {
    var s = str.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function rand(n) {
    var b = new Uint8Array(n);
    webcrypto.getRandomValues(b);
    return b;
  }

  // A candidate: "hy1" (whitespace allowed anywhere), ".", then base64url + "." + whitespace
  // up to the first "~". The shape (11 . 16 . >=22 chars) is checked in scan().
  var TOKEN_RE = /h\s*y\s*1\s*\.([A-Za-z0-9_.\s-]{34,}?)~/g;

  /** Find every well-formed token in `text`: [{ i, len, kid, iv, ct }]. */
  function scan(text) {
    var re = new RegExp(TOKEN_RE.source, "g");
    var out = [], m;
    while ((m = re.exec(text)) !== null) {
      var parts = m[1].replace(/\s+/g, "").split(".");
      if (parts.length !== 3 || parts[0].length !== 11 || parts[1].length !== 16 || parts[2].length < 22) {
        re.lastIndex = m.index + 1; // not a token; keep looking after this "h"
        continue;
      }
      out.push({ i: m.index, len: m[0].length, kid: parts[0], iv: parts[1], ct: parts[2] });
    }
    return out;
  }

  function newCircle(name) {
    return {
      kid: b64uEncode(rand(8)),
      name: String(name || "circle").slice(0, 60),
      key: b64uEncode(rand(32)),
    };
  }

  async function importKey(circle) {
    return webcrypto.subtle.importKey("raw", b64uDecode(circle.key), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  async function seal(circle, plaintext) {
    var iv = rand(12);
    var key = await importKey(circle);
    var ct = new Uint8Array(await webcrypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv, additionalData: b64uDecode(circle.kid) },
      key,
      enc.encode(plaintext)
    ));
    return "hy1." + circle.kid + "." + b64uEncode(iv) + "." + b64uEncode(ct) + "~";
  }

  /** Open one token with the circles you hold. Returns the plaintext, or null. */
  async function openToken(kid, ivText, ctText, circlesByKid) {
    var circle = circlesByKid[kid];
    if (!circle) return null;
    try {
      var key = await importKey(circle);
      var pt = await webcrypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64uDecode(ivText), additionalData: b64uDecode(kid) },
        key,
        b64uDecode(ctText)
      );
      return dec.decode(pt);
    } catch (e) {
      return null; // wrong key or tampered: GCM refuses
    }
  }

  /** Replace every sealed token in `text` we can open; leave the rest as is. */
  async function revealText(text, circlesByKid) {
    var found = scan(text);
    var out = "", last = 0, opened = 0, locked = 0;
    for (var j = 0; j < found.length; j++) {
      var t = found[j];
      var pt = await openToken(t.kid, t.iv, t.ct, circlesByKid);
      out += text.slice(last, t.i);
      if (pt === null) { out += text.slice(t.i, t.i + t.len); locked++; }
      else { out += pt; opened++; }
      last = t.i + t.len;
    }
    out += text.slice(last);
    return { text: out, opened: opened, locked: locked };
  }

  /**
   * Split `text` into runs: plain text, and sealed tokens (opened when we hold
   * the key). The page layer uses this to put each opened token in its own
   * closed shadow root, so the page's scripts never see the plaintext.
   * Each run is { text } or { token, plain } (plain is null when locked).
   */
  async function revealSegments(text, circlesByKid) {
    var found = scan(text);
    var segs = [], last = 0;
    for (var j = 0; j < found.length; j++) {
      var t = found[j];
      if (t.i > last) segs.push({ text: text.slice(last, t.i) });
      var plain = await openToken(t.kid, t.iv, t.ct, circlesByKid);
      segs.push({ token: text.slice(t.i, t.i + t.len), plain: plain });
      last = t.i + t.len;
    }
    if (last < text.length) segs.push({ text: text.slice(last) });
    return segs;
  }

  function hasToken(text) {
    return scan(text).length > 0;
  }

  /** Portable form of a circle, for handing a key to someone out of band. */
  function shareString(circle) {
    return "hy1key." + circle.kid + "." + b64uEncode(enc.encode(circle.name)) + "." + circle.key;
  }
  function parseShare(str) {
    var m = /^hy1key\.([A-Za-z0-9_-]{11})\.([A-Za-z0-9_-]*)\.([A-Za-z0-9_-]{43})$/.exec(String(str).trim());
    if (!m) return null;
    return { kid: m[1], name: dec.decode(b64uDecode(m[2])), key: m[3] };
  }

  return {
    newCircle: newCircle, seal: seal, revealText: revealText, revealSegments: revealSegments,
    hasToken: hasToken, shareString: shareString, parseShare: parseShare, TOKEN_RE: TOKEN_RE,
  };
});
