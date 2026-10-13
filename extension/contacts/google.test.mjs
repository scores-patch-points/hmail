// Tests for contacts/google.js. Run:  node extension/contacts/google.test.mjs
//
// Everything is local: fixtures under ./fixtures and an in-process mock of the
// People API (a fake `fetch`). No network, no OAuth, no real Google data, no
// real credentials — the only "token" here is a made-up string.
//
// NOT PROVEN by this file: that the real People API answers with exactly the
// shapes the mock produces, that Google's real exports match the fixtures
// column-for-column, or that a real OAuth flow yields a token these calls
// accept. See GOOGLE-WIRING.md "What is and isn't proven".
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./google.js";

const G = globalThis.HyGoogleContacts;
const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(join(here, "fixtures", n), "utf8");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra !== undefined ? "  →  " + JSON.stringify(extra) : "")); }
}
function eq(a, b, name) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  ok(sa === sb, name, { got: a, want: b });
}
async function group(name, fn) {
  try { await fn(); } catch (e) { fail++; failures.push(name + " THREW " + (e && e.stack || e)); }
}

// Anything the module writes to the console is a leak of contact data: record it.
const consoleCalls = [];
for (const k of ["log", "info", "warn", "error", "debug", "trace"]) {
  console[k] = ((orig) => (...a) => { if (!insideReport) consoleCalls.push([k, a]); else orig(...a); })(console[k].bind(console));
}
let insideReport = false;
// And any global network call from the FILE route is a leak too.
let strayNetwork = 0;
globalThis.fetch = () => { strayNetwork++; return Promise.reject(new Error("stray fetch")); };
globalThis.XMLHttpRequest = function () { strayNetwork++; };
globalThis.WebSocket = function () { strayNetwork++; };
if (globalThis.navigator) { try { globalThis.navigator.sendBeacon = () => { strayNetwork++; return false; }; } catch (e) { /* read-only */ } }

const shapeOk = (list) => list.every((c) =>
  Object.keys(c).sort().join() === "emails,name,source" &&
  typeof c.name === "string" && Array.isArray(c.emails) && c.emails.length > 0 &&
  c.emails.every((e) => e === e.toLowerCase() && G.normalizeEmail(e) === e) &&
  new Set(c.emails).size === c.emails.length &&
  (c.source === "csv" || c.source === "api"));
const names = (r) => r.contacts.map((c) => c.name);
const byName = (r, n) => r.contacts.find((c) => c.name === n);

// ---------------------------------------------------------------------------
await group("normalizeEmail", () => {
  const n = G.normalizeEmail;
  eq(n("  Bob@Example.COM "), "bob@example.com", "trim + lower");
  eq(n("Bob Smith <BOB@x.example>"), "bob@x.example", "angle form");
  eq(n("mailto:a@b.example"), "a@b.example", "mailto");
  eq(n('"a@b.example"'), "a@b.example", "quoted");
  eq(n("first.last+tag@sub.example.co.uk"), "first.last+tag@sub.example.co.uk", "plus + subdomain");
  eq(n("zoe@xn--ngstrm-bua.example.com"), "zoe@xn--ngstrm-bua.example.com", "punycode domain");
  eq(n("jörg@bücher.example"), "jörg@bücher.example", "unicode kept (not punycoded)");
  for (const bad of ["", "no-at", "a@b", "a@@b.example", "a@b..example", ".a@b.example", "a.@b.example", "a..b@c.example",
    "a b@c.example", "a@-b.example", "a@b-.example", "a@1.2.3.4", "a@[1.2.3.4]", "<>", "@b.example", "a@",
    "a@b.example,c@d.example", "a@b.exa‮mple", "a\u0007@b.example", "x".repeat(65) + "@b.example",
    "a@" + "x".repeat(64) + ".example", "a@" + ("b.".repeat(130)) + "example"]) {
    eq(n(bad), null, "rejects " + JSON.stringify(bad).slice(0, 40));
  }
  eq(n("a@b.example\n"), "a@b.example", "surrounding whitespace is trimmed, not rejected");
  eq(n("a\n@b.example"), null, "embedded newline rejected");
  eq(n(null), null, "null"); eq(n(42), null, "number"); eq(n({}), null, "object");
});

// ---------------------------------------------------------------------------
await group("Google CSV fixture", () => {
  const r = G.parseExport(fx("google.csv"));
  ok(r.ok && r.error === null, "google.csv parses", r.error);
  eq(r.format, "google-csv", "format detected");
  ok(shapeOk(r.contacts), "shape: exactly {name,emails,source}");
  eq(names(r), ["Ada Lovelace", "Smith, Robert", "Grace Brewster Murray Hopper", "Zoë Ångström", "Acme Rocket Co", "Bad Address Bea"], "names (full, given+additional+family, organisation fallback)");
  eq(byName(r, "Ada Lovelace").emails, ["ada@example.com", "ada.lovelace@analytical.example.org"], "two E-mail N columns, lower-cased");
  eq(byName(r, "Smith, Robert").emails, ["bob@example.com", "rsmith@work.example.net"], "' ::: ' multi-value cell");
  eq(byName(r, "Grace Brewster Murray Hopper").emails, ["grace@navy.example.mil"], "empty Name builds from parts");
  eq(byName(r, "Acme Rocket Co").emails, ["nameless@example.com"], "no name -> organisation");
  eq(byName(r, "Bad Address Bea").emails, ["bea@example.com"], "junk cell skipped, good one kept");
  ok(!r.contacts.some((c) => c.emails.indexOf("ada@example.com") !== -1 && c.name === "Ada L."), "same-address row dropped as duplicate");
  eq(r.stats.records, 8, "records");
  eq(r.stats.withoutEmail, 1, "phone-only contact has no e-mail");
  eq(r.stats.duplicates, 1, "one duplicate row");
  ok(r.contacts.every((c) => c.source === "csv"), "source = csv");
  ok(!r.contacts.some((c) => /^\s|\s$|﻿/.test(c.name)), "BOM and spaces gone from names");
});

await group("Outlook CSV fixture", () => {
  const r = G.parseExport(fx("outlook.csv"));
  ok(r.ok, "outlook.csv parses", r.error);
  eq(r.format, "outlook-csv", "format detected");
  ok(shapeOk(r.contacts), "shape");
  eq(names(r), ["Alan Turing", "Katherine Coleman Johnson", "Margaret Hamilton", "Initech"], "names");
  eq(byName(r, "Alan Turing").emails, ["alan@bletchley.example.org", "turing@kings.example.ac.uk"], "same person twice -> one contact, addresses merged");
  eq(byName(r, "Katherine Coleman Johnson").emails, ["kjohnson@nasa.example.gov", "kcj@example.com"], "E-mail 2 Address; Exchange X.500 address dropped");
  eq(byName(r, "Initech").emails, ["info@initech.example.com"], "Company is the name of last resort");
  eq(r.stats.merged, 1, "one merge");
  eq(r.stats.withoutEmail, 1, "no-mail row");
  eq(r.stats.invalidEmails, 0, "Display Name / Type columns are not counted as bad addresses");
});

await group("vCard fixture (3.0, 4.0, 2.1 quoted-printable)", () => {
  const r = G.parseExport(fx("contacts.vcf"));
  ok(r.ok && r.error === null, "contacts.vcf parses", r.error);
  eq(r.format, "vcard", "format");
  ok(shapeOk(r.contacts), "shape");
  eq(names(r), [
    "Ada Lovelace",
    "Robert Smith, Jr. who has a really quite long formatted name so that the line must be folded",
    "Grace Hopper",
    "Zoë Ångström",
    "Acme Rocket Co"
  ], "FN preferred, folded lines rejoined, \\, unescaped, QP decoded with soft break, ORG fallback");
  eq(byName(r, "Ada Lovelace").emails, ["ada@example.com", "ada.lovelace@analytical.example.org"], "item1.EMAIL group prefix + plain EMAIL");
  eq(r.contacts[1].emails, ["bob@example.com", "rsmith@work.example.net"], "multiple EMAIL");
  eq(byName(r, "Grace Hopper").emails, ["grace@navy.example.mil", "grace@home.example.com"], "4.0 mailto: and upper case");
  eq(byName(r, "Zoë Ångström").emails, ["zoe@example.com"], "2.1 card");
  eq(r.stats.records, 7, "cards");
  eq(r.stats.withoutEmail, 1, "card without e-mail");
  eq(r.stats.duplicates, 1, "duplicate card");
  ok(r.contacts.every((c) => c.source === "csv"), "file source");
  // N alone (no FN)
  const n = G.parseVcf("BEGIN:VCARD\r\nVERSION:3.0\r\nN:Hopper;Grace;Brewster;Rear Admiral;\r\nEMAIL:g@example.com\r\nEND:VCARD\r\n");
  eq(n.contacts[0].name, "Grace Brewster Hopper", "N only: given additional family");
  // missing END at EOF keeps whole lines
  const t = G.parseVcf("BEGIN:VCARD\nFN:No End\nEMAIL:ne@example.com\n");
  eq(t.contacts.map((c) => c.emails[0]), ["ne@example.com"], "card without END at EOF still imported");
  // nested garbage / not a vcard
  const x = G.parseVcf("hello\nworld\n");
  ok(!x.ok && /no-vcard/.test(x.error) && x.contacts.length === 0, "non-vcard is an error, not a crash", x);
});

await group("hostile CSV fixture", () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort().join();
  const r = G.parseExport(fx("hostile.csv"));
  ok(r.ok, "parses", r.error);
  ok(shapeOk(r.contacts), "shape");
  eq(Object.getOwnPropertyNames(Object.prototype).sort().join(), before, "Object.prototype untouched");
  ok(({}).polluted === undefined && ({}).proto === undefined, "no pollution");
  const first = r.contacts[0];
  eq(first.name, "__proto__", "a contact named __proto__ is just a name");
  eq(first.emails, ["proto@example.com", "constructor@example.com"], "columns named __proto__/constructor are ignored, not interpreted");
  ok(Object.getPrototypeOf(first) === Object.prototype && first.constructor === Object, "result objects are plain");
  ok(r.contacts.some((c) => c.name === "evilname.exe"), "bidi override and zero-width stripped from names", names(r));
  ok(!r.contacts.some((c) => c.emails.some((e) => /halfaddr/.test(e))), "over-long cell dropped whole, never cut into a half-address");
  const quoted = r.contacts.find((c) => c.name === "Quoted Comma");
  eq(quoted && quoted.emails, ["one@example.com", "two@example.com", "three@example.com"], "comma/semicolon separated addresses in one cell");
  ok(r.contacts.some((c) => c.name === "Ok After Huge"), "parsing continues after a huge cell");
  ok(!r.contacts.some((c) => ["Bad One", "Bad Two", "Control"].indexOf(c.name) !== -1), "malformed addresses give no contact");
  ok(r.stats.invalidEmails >= 4, "malformed addresses counted", r.stats);
  ok(!JSON.stringify(r.contacts).includes("nobody@example.com"), "unterminated quote swallowed its record, no half-parse");
});

// ---------------------------------------------------------------------------
await group("line endings, BOM, delimiters", () => {
  const base = fx("google.csv").replace(/\r\n/g, "\n");
  const ref = JSON.stringify(G.parseExport(base).contacts);
  eq(JSON.stringify(G.parseExport(base.replace(/\n/g, "\r\n")).contacts), ref, "CRLF == LF");
  // CR-only row ends only valid where no cell has an embedded newline: use outlook minus its multiline note
  const simple = "Name,E-mail 1 - Value\nA,a@example.com\nB,b@example.com\n";
  eq(G.parseCsv(simple.replace(/\n/g, "\r")).contacts.length, 2, "CR-only endings");
  eq(G.parseCsv("﻿" + simple).contacts.length, 2, "BOM");
  eq(G.parseCsv(simple.replace(/,/g, ";")).contacts.length, 2, "semicolon delimiter (European Excel)");
  eq(G.parseCsv(simple.replace(/,/g, "\t")).contacts.length, 2, "tab delimiter");
  eq(G.parseCsv(simple + "\n\n\n").contacts.length, 2, "blank lines");
  eq(G.parseCsv('Name,E-mail 1 - Value\n"Multi\r\nLine, ""Q""",m@example.com\n').contacts[0].name, 'Multi Line, "Q"', "quoted newline, comma and doubled quote");
  const noFinalNewline = G.parseCsv("Name,E-mail 1 - Value\nA,a@example.com");
  eq(noFinalNewline.contacts.length, 1, "no trailing newline");
  const r = G.parseCsv("Phone,Notes\n555,hi\n");
  ok(!r.ok && /no-email-column/.test(r.error) && r.contacts.length === 0, "csv with no e-mail column is an honest error", r);
  const e = G.parseExport("");
  ok(!e.ok && e.contacts.length === 0, "empty input is an error not a crash", e);
  eq(G.parseExport(null).contacts, [], "null input");
});

await group("streaming: any chunking gives the same answer", async () => {
  for (const name of ["google.csv", "outlook.csv", "contacts.vcf", "hostile.csv"]) {
    const text = fx(name);
    const whole = JSON.stringify(G.parseExport(text).contacts);
    for (const size of [1, 2, 3, 7, 64, 1000]) {
      const p = G.createParser();
      for (let i = 0; i < text.length; i += size) p.push(text.slice(i, i + size));
      eq(JSON.stringify(p.end().contacts), whole, name + " in " + size + "-char chunks");
    }
  }
  // File/Blob route, including UTF-16LE with BOM and a File too large
  const blob = new Blob([fx("google.csv")]);
  const viaFile = await G.parseFile(blob);
  eq(JSON.stringify(viaFile.contacts), JSON.stringify(G.parseExport(fx("google.csv")).contacts), "parseFile(Blob) == parseExport");
  const u16 = new Uint8Array(2 + fx("outlook.csv").length * 2);
  u16[0] = 0xff; u16[1] = 0xfe;
  for (let i = 0; i < fx("outlook.csv").length; i++) { const c = fx("outlook.csv").charCodeAt(i); u16[2 + i * 2] = c & 255; u16[3 + i * 2] = c >> 8; }
  const viaU16 = await G.parseFile(new Blob([u16]));
  eq(names(viaU16), names(G.parseExport(fx("outlook.csv"))), "UTF-16LE export (Outlook) read");
  const big = await G.parseFile(new Blob(["Name,Email\n"]), { limits: { maxBytes: 4 } });
  ok(!big.ok && /too-large/.test(big.error), "file over maxBytes refused before reading", big);
  const v = await G.parseFile(new Blob([fx("contacts.vcf")]), { format: "vcard" });
  eq(v.contacts.length, 5, "parseFile vcard");
});

await group("limits", () => {
  let csv = "Name,E-mail 1 - Value\n";
  for (let i = 0; i < 50; i++) csv += "P" + i + ",p" + i + "@example.com\n";
  const r = G.parseCsv(csv, { limits: { maxContacts: 10 } });
  eq(r.contacts.length, 10, "maxContacts cap");
  ok(r.truncated && r.warnings.some((w) => /contact-cap/.test(w)), "cap is reported", r.warnings);

  // a cut mid-address must not yield a half-address contact
  const text = "Name,E-mail 1 - Value\nA,a@example.com\nB,b@longdomain.example.com\n";
  const cutAt = text.indexOf("b@longdomain") + "b@longdo".length;
  const c = G.parseCsv(text, { limits: { maxChars: cutAt } });
  eq(c.contacts.map((x) => x.name), ["A"], "size cap never flushes a half record");
  ok(c.truncated && c.warnings.some((w) => /size-cap/.test(w)), "size cap reported");
  const vtext = "BEGIN:VCARD\nFN:A\nEMAIL:a@example.com\nEND:VCARD\nBEGIN:VCARD\nFN:B\nEMAIL:b@longdomain.example.com\nEND:VCARD\n";
  const vcut = vtext.indexOf("b@longdomain") + 8;
  eq(G.parseVcf(vtext, { limits: { maxChars: vcut } }).contacts.map((x) => x.name), ["A"], "vcard size cap never flushes a half card");

  const many = "Name,E-mail 1 - Value,E-mail 2 - Value\nA," + Array.from({ length: 80 }, (_, i) => "e" + i + "@example.com").join(" ::: ") + "\n";
  eq(G.parseCsv(many).contacts[0].emails.length, 50, "maxEmailsPerContact");
  const longName = G.parseCsv("Name,E-mail 1 - Value\n" + "n".repeat(3000) + ",a@example.com\n").contacts[0].name;
  ok(longName.length <= 200, "name capped", longName.length);
  const cols = Array.from({ length: 1500 }, (_, i) => "c" + i);
  const wide = G.parseCsv("Name,E-mail 1 - Value," + cols.join(",") + "\nx,x@example.com," + cols.join(",") + "\n");
  ok(wide.ok && wide.contacts.length === 1, "1500 columns tolerated (extras beyond maxColumns ignored)");
  // a vCard with a megabyte of PHOTO is skipped without being accumulated
  const photo = "BEGIN:VCARD\r\nFN:P\r\nPHOTO;ENCODING=b:" + "A".repeat(75) + "\r\n" + (" " + "A".repeat(74) + "\r\n").repeat(20000) + "EMAIL:p@example.com\r\nEND:VCARD\r\n";
  eq(G.parseVcf(photo).contacts.map((c) => c.emails[0]), ["p@example.com"], "huge PHOTO skipped, contact kept");
  // a huge EMAIL line is dropped, not truncated
  const hugeLine = "BEGIN:VCARD\nFN:H\nEMAIL:" + "x".repeat(40000) + "@example.com\nEMAIL:ok@example.com\nEND:VCARD\n";
  eq(G.parseVcf(hugeLine).contacts[0].emails, ["ok@example.com"], "over-long vCard line dropped whole");
});

await group("performance: 200k rows", () => {
  const rows = ["Name,Given Name,Family Name,E-mail 1 - Type,E-mail 1 - Value,Notes"];
  for (let i = 0; i < 200000; i++) rows.push("Person " + i + ",P,Q" + i + ",Home,person" + i + "@example.com,\"note " + i + ", with comma\"");
  const text = rows.join("\r\n") + "\r\n";
  const t0 = Date.now();
  const r = G.parseExport(text);
  const ms = Date.now() - t0;
  eq(r.contacts.length, 100000, "capped at 100000 contacts");
  ok(r.truncated, "reported as truncated");
  ok(ms < 20000, "parsed " + (text.length / 1e6).toFixed(1) + " MB in " + ms + " ms", ms);
  globalThis.__perfMs = ms; globalThis.__perfMb = (text.length / 1e6).toFixed(1);
});

// ---------------------------------------------------------------------------
// API route against a mock People API
function person(i, extra) {
  return Object.assign({
    resourceName: "people/c" + i,
    names: [{ displayName: "Person " + i, givenName: "Person", familyName: String(i), metadata: { primary: true } }],
    emailAddresses: [{ value: "Person" + i + "@Example.com", type: "home" }]
  }, extra || {});
}
function json(status, body, headers) {
  const h = new Map(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => h.get(String(k).toLowerCase()) || null }, json: async () => body };
}
// script: array of responders consumed in order; each is (url, init, i) => response | throws
function mockFetch(script) {
  const calls = [];
  const f = async (url, init) => {
    const i = calls.length;
    calls.push({ url, init });
    const r = script[Math.min(i, script.length - 1)];
    return typeof r === "function" ? r(url, init, i) : r;
  };
  f.calls = calls;
  return f;
}
const noSleep = () => { const s = async (ms) => { s.delays.push(ms); }; s.delays = []; return s; };
const TOKEN = "ya29.test-token-not-real";
const pagesOf = (total, per) => {
  const out = [];
  for (let s = 0; s < total; s += per) out.push({ connections: Array.from({ length: Math.min(per, total - s) }, (_, k) => person(s + k)), nextPageToken: s + per < total ? "tok" + (s + per) : undefined, totalItems: total });
  return out;
};

await group("API: pagination, request shape, token handling", async () => {
  const pages = pagesOf(2500, 1000);
  const f = mockFetch([
    (u) => json(200, pages[0]),
    (u) => json(200, pages[1]),
    (u) => json(200, pages[2])
  ]);
  const r = await G.fetchContacts({ accessToken: TOKEN, fetch: f, sleep: noSleep() });
  eq(f.calls.length, 3, "three pages fetched");
  eq(r.contacts.length, 2500, "2500 contacts");
  ok(shapeOk(r.contacts) && r.contacts.every((c) => c.source === "api"), "shape + source=api");
  eq(r.contacts[0], { name: "Person 0", emails: ["person0@example.com"], source: "api" }, "normalised (lower-cased)");
  ok(r.complete && r.ok && r.format === "people-api", "complete");
  const u0 = new URL(f.calls[0].url), u1 = new URL(f.calls[1].url);
  eq(u0.origin + u0.pathname, "https://people.googleapis.com/v1/people/me/connections", "endpoint");
  eq(u0.searchParams.get("personFields"), "names,emailAddresses", "personFields");
  eq(u0.searchParams.get("pageSize"), "1000", "pageSize");
  eq(u0.searchParams.get("pageToken"), null, "first page has no token");
  eq(u1.searchParams.get("pageToken"), "tok1000", "second page carries nextPageToken");
  ok(f.calls.every((c) => c.init.headers.Authorization === "Bearer " + TOKEN), "token in Authorization header");
  ok(f.calls.every((c) => c.url.indexOf(TOKEN) === -1), "token never in a URL");
  ok(f.calls.every((c) => c.init.credentials === "omit" && c.init.method === "GET"), "GET, credentials omitted");
  ok(f.calls.every((c) => new URL(c.url).host === "people.googleapis.com"), "only people.googleapis.com is ever called");
  ok(!JSON.stringify(r).includes(TOKEN), "token not echoed in the result");
});

await group("API: otherContacts is opt-in, uses readMask, and dedupes against connections", async () => {
  const f = mockFetch([
    (u) => json(200, { connections: [person(1), person(2)] }),
    (u) => json(200, { otherContacts: [person(2), { names: [{ displayName: "Rando" }], emailAddresses: [{ value: "rando@example.com" }] }], totalSize: 2 })
  ]);
  const r = await G.fetchContacts({ accessToken: TOKEN, fetch: f, include: ["connections", "otherContacts"], sleep: noSleep() });
  const u = new URL(f.calls[1].url);
  eq(u.origin + u.pathname, "https://people.googleapis.com/v1/otherContacts", "endpoint");
  eq(u.searchParams.get("readMask"), "names,emailAddresses", "readMask");
  eq(r.contacts.map((c) => c.name), ["Person 1", "Person 2", "Rando"], "merged + de-duplicated");
  const d = mockFetch([(u) => json(200, { connections: [] })]);
  await G.fetchContacts({ accessToken: TOKEN, fetch: d, sleep: noSleep() });
  eq(d.calls.length, 1, "default is connections only");
  ok(/contacts\.readonly$/.test(G.SCOPES.contacts) && /contacts\.other\.readonly$/.test(G.SCOPES.other), "scopes exported");
});

await group("API: empty and odd bodies", async () => {
  const r = await G.fetchContacts({ accessToken: TOKEN, fetch: mockFetch([json(200, {})]), sleep: noSleep() });
  ok(r.ok && r.contacts.length === 0 && r.complete, "empty account is a success");
  const odd = await G.fetchContacts({ accessToken: TOKEN, sleep: noSleep(), fetch: mockFetch([json(200, { connections: [
    null, 7, "x", {}, { names: [], emailAddresses: [] },
    { names: [{ displayName: "No Primary" }, { displayName: "Primary", metadata: { primary: true } }], emailAddresses: [{ value: "np@example.com" }, { value: 5 }, null, { value: "bad" }] },
    { names: [{ givenName: "Only", familyName: "Parts" }], emailAddresses: [{ value: "op@example.com" }] }
  ] })]) });
  eq(odd.contacts, [{ name: "Primary", emails: ["np@example.com"], source: "api" }, { name: "Only Parts", emails: ["op@example.com"], source: "api" }], "primary name preferred; junk skipped");
  const bad = await G.fetchContacts({ accessToken: TOKEN, sleep: noSleep(), fetch: mockFetch([json(200, { connections: "nope" })]) }).catch((e) => e);
  eq(bad.code, "bad-response", "non-list 'connections' is a bad-response");
  const nj = await G.fetchContacts({ accessToken: TOKEN, sleep: noSleep(), fetch: mockFetch([{ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error("x"); } }]) }).catch((e) => e);
  eq(nj.code, "bad-response", "invalid JSON is a bad-response");
  const before = Object.getOwnPropertyNames(Object.prototype).join();
  const polluted = JSON.parse('{"connections":[{"names":[{"displayName":"__proto__"}],"emailAddresses":[{"value":"p@example.com"}],"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":2}}}]}');
  const pr = await G.fetchContacts({ accessToken: TOKEN, sleep: noSleep(), fetch: mockFetch([json(200, polluted)]) });
  eq(pr.contacts, [{ name: "__proto__", emails: ["p@example.com"], source: "api" }], "hostile JSON keys ignored");
  ok(({}).polluted === undefined && Object.getOwnPropertyNames(Object.prototype).join() === before, "no pollution via API body");
});

await group("API: 429 / 5xx / network retry with backoff", async () => {
  const s = noSleep();
  const f = mockFetch([json(429, { error: { status: "RESOURCE_EXHAUSTED" } }, { "Retry-After": "7" }), json(503, {}), json(200, { connections: [person(1)] })]);
  const r = await G.fetchContacts({ accessToken: TOKEN, fetch: f, sleep: s, random: () => 1 });
  eq(r.contacts.length, 1, "succeeds after 429 then 503");
  eq(f.calls.length, 3, "three attempts");
  ok(s.delays[0] >= 7000, "Retry-After honoured", s.delays);
  ok(s.delays[1] >= s.delays[0] || s.delays[1] >= 1000, "backoff grows / stays >= base", s.delays);
  ok(s.delays.every((d) => d <= G.LIMITS.retryMaxMs), "waits capped");

  const s2 = noSleep();
  const always = mockFetch([json(429, {})]);
  const e = await G.fetchContacts({ accessToken: TOKEN, fetch: always, sleep: s2 }).catch((x) => x);
  eq(e.code, "rate-limited", "gives up with rate-limited");
  ok(e.retryable === true && e.status === 429, "error is marked retryable, status kept");
  eq(always.calls.length, G.LIMITS.maxRetries + 1, "bounded retries");

  const s3 = noSleep();
  const net = mockFetch([() => { throw new TypeError("Failed to fetch"); }, json(200, { connections: [person(9)] })]);
  const nr = await G.fetchContacts({ accessToken: TOKEN, fetch: net, sleep: s3 });
  eq(nr.contacts.length, 1, "recovers from a network error");
  const dead = await G.fetchContacts({ accessToken: TOKEN, sleep: noSleep(), fetch: mockFetch([() => { throw new TypeError("offline"); }]) }).catch((x) => x);
  eq(dead.code, "network", "persistent network error -> network");
  ok(!/offline/.test(dead.message), "underlying error text not echoed");
});

await group("API: 401 / 403 are classified, not retried blindly", async () => {
  const s = noSleep();
  const f401 = mockFetch([json(401, { error: { code: 401, status: "UNAUTHENTICATED", message: "Invalid Credentials" } })]);
  const e1 = await G.fetchContacts({ accessToken: TOKEN, fetch: f401, sleep: s }).catch((x) => x);
  eq(e1.code, "unauthorized", "401 -> unauthorized");
  eq(f401.calls.length, 1, "401 with a fixed token is not retried");
  ok(e1.retryable === false, "not retryable");

  // token provider: asked to refresh exactly once
  const asks = [];
  const f = mockFetch([json(401, {}), json(200, { connections: [person(1)] })]);
  const r = await G.fetchContacts({ accessToken: async (o) => { asks.push(!!(o && o.refresh)); return o && o.refresh ? "fresh-token" : "stale-token"; }, fetch: f, sleep: s });
  eq(r.contacts.length, 1, "refreshed token works");
  eq(asks, [false, true], "provider asked once normally, once with refresh");
  eq(f.calls[1].init.headers.Authorization, "Bearer fresh-token", "second call uses refreshed token");
  const f2 = mockFetch([json(401, {})]);
  const e2 = await G.fetchContacts({ accessToken: async () => "t", fetch: f2, sleep: s }).catch((x) => x);
  eq(e2.code, "unauthorized", "still 401 after refresh -> unauthorized");
  eq(f2.calls.length, 2, "only one refresh attempt");

  const scope = await G.fetchContacts({ accessToken: TOKEN, sleep: s, fetch: mockFetch([json(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "Request had insufficient authentication scopes.", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } })]) }).catch((x) => x);
  eq(scope.code, "insufficient-scope", "403 scope -> insufficient-scope");
  const off = await G.fetchContacts({ accessToken: TOKEN, sleep: s, fetch: mockFetch([json(403, { error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } })]) }).catch((x) => x);
  eq(off.code, "api-disabled", "403 SERVICE_DISABLED -> api-disabled");
  const rl = mockFetch([json(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }), json(200, { connections: [person(5)] })]);
  const rr = await G.fetchContacts({ accessToken: TOKEN, fetch: rl, sleep: noSleep() });
  eq(rr.contacts.length, 1, "403 rateLimitExceeded is retried");
  const plain = mockFetch([json(403, { error: { message: "nope" } })]);
  const pe = await G.fetchContacts({ accessToken: TOKEN, fetch: plain, sleep: s }).catch((x) => x);
  eq(pe.code, "forbidden", "other 403 -> forbidden");
  eq(plain.calls.length, 1, "other 403 not retried");
  ok(pe.name === "HyGoogleContactsError", "error has a stable name");
});

await group("API: partial results, loops, caps, abort, bad input", async () => {
  const f = mockFetch([
    (u) => json(200, { connections: [person(1)] }),
    (u) => json(403, { error: { status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } })
  ]);
  const r = await G.fetchContacts({ accessToken: TOKEN, fetch: f, include: ["connections", "otherContacts"], sleep: noSleep() });
  ok(r.ok && r.contacts.length === 1 && r.complete === false, "other contacts denied -> connections kept, complete:false");
  ok(r.warnings.some((w) => /otherContacts: insufficient-scope/.test(w)), "denial reported", r.warnings);
  const allBad = await G.fetchContacts({ accessToken: TOKEN, include: ["otherContacts"], sleep: noSleep(), fetch: mockFetch([json(403, { error: { details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } })]) }).catch((x) => x);
  eq(allBad.code, "insufficient-scope", "every source failed -> rejects");

  const loop = mockFetch([(u) => json(200, { connections: [person(1)], nextPageToken: "same" })]);
  const lr = await G.fetchContacts({ accessToken: TOKEN, fetch: loop, sleep: noSleep() });
  ok(loop.calls.length <= 3 && lr.warnings.some((w) => /repeated a page token/.test(w)), "repeated page token stops the loop", loop.calls.length);

  let n = 0;
  const endless = mockFetch([(u) => json(200, { connections: [person(n++)], nextPageToken: "t" + n })]);
  const er = await G.fetchContacts({ accessToken: TOKEN, fetch: endless, sleep: noSleep(), limits: { maxPages: 5 } });
  eq(endless.calls.length, 5, "page cap");
  ok(er.warnings.some((w) => /page cap/.test(w)) && !er.complete, "page cap reported, not complete");

  const ac = new AbortController();
  const g = mockFetch([async () => { ac.abort(); throw new Error("aborted"); }]);
  const ab = await G.fetchContacts({ accessToken: TOKEN, fetch: g, signal: ac.signal, sleep: noSleep() }).catch((x) => x);
  eq(ab.code, "aborted", "abort signal");

  const spy = mockFetch([json(200, {})]);
  for (const bad of ["", "a b", "tok\r\nX-Evil: 1", "x".repeat(5000)]) {
    const be = await G.fetchContacts({ accessToken: bad, fetch: spy, sleep: noSleep() }).catch((x) => x);
    eq(be.code, "bad-token", "refuses token " + JSON.stringify(bad).slice(0, 20));
  }
  eq(spy.calls.length, 0, "no request made with a malformed token");
  const te = await G.fetchContacts({ accessToken: TOKEN }).catch((x) => x);
  ok(te instanceof TypeError, "missing fetch is a TypeError");
  const te2 = await G.fetchContacts({ fetch: spy }).catch((x) => x);
  ok(te2 instanceof TypeError, "missing token is a TypeError");
  const te3 = await G.fetchContacts({ accessToken: TOKEN, fetch: spy, include: ["directory"] }).catch((x) => x);
  ok(te3 instanceof TypeError, "unknown include is a TypeError");
  const prog = [];
  await G.fetchContacts({ accessToken: TOKEN, fetch: mockFetch(pagesOf(1500, 1000).map((p) => json(200, p))), sleep: noSleep(), onProgress: (p) => prog.push(p) });
  eq(prog.map((p) => p.pages), [1, 2], "progress callback gets counts only");
  ok(prog.every((p) => Object.keys(p).sort().join() === "contacts,pages,source"), "progress carries no contact data");
});

// ---------------------------------------------------------------------------
await group("hand-off to contacts/core.js importGoogle", async () => {
  let core;
  try { await import("./core.js"); core = globalThis.HyContacts; } catch (e) { core = null; }
  if (!core) { ok(true, "core.js not present: skipped"); return; }
  const mem = new Map();
  const store = core.create({ storage: { get: async (k) => mem.get(k), set: async (k, v) => { mem.set(k, JSON.parse(JSON.stringify(v))); } } });
  const r = G.parseExport(fx("google.csv"));
  const res = await store.importGoogle(r.contacts);
  eq(res.added, r.contacts.length, "core accepts every contact we produce (added == produced)");
  const again = await store.importGoogle(r.contacts);
  eq(again.added, 0, "re-import adds nothing");
  const all = await store.all();
  ok(all.length === r.contacts.length, "directory has them", all.length);
  const vres = await store.importGoogle(G.parseExport(fx("contacts.vcf")).contacts);
  ok(vres.added + vres.merged === 5, "vCard contacts accepted too", vres);
});

await group("privacy: no logging, no stray network", () => {
  eq(consoleCalls.length, 0, "module never wrote to the console");
  eq(strayNetwork, 0, "file route and API route made no global fetch/XHR/WebSocket/beacon call");
});

insideReport = true;
console.log("");
if (globalThis.__perfMs) console.log("perf: " + globalThis.__perfMb + " MB CSV in " + globalThis.__perfMs + " ms");
for (const f of failures) console.log("FAIL  " + f);
console.log("google.test.mjs  pass " + pass + "  fail " + fail);
process.exit(fail ? 1 : 0);
