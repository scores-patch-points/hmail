// Logic tests for contacts/sheet.js, with no DOM and no browser:
//   node extension/contacts/sheet.test.mjs
// The file is evaluated in a vm sandbox (the repo is "type": "module", and
// sheet.js is a classic content script), so it sees only the globals given here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "sheet.js"), "utf8");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) pass++; else { fail++; failures.push(name); console.log("  FAIL  " + name); }
}
function eq(a, b, name) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x === y) pass++; else { fail++; failures.push(name); console.log("  FAIL  " + name + "\n    got  " + x + "\n    want " + y); }
}
function section(s) { console.log(s); }

function load(extra) {
  const sandbox = Object.assign({ console, setTimeout, clearTimeout, Promise }, extra || {});
  sandbox.window = undefined;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "sheet.js" });
  return sandbox;
}

const people = [
  { id: "1", name: "Maya Lin", emails: ["maya@x.org", "Maya.Lin@work.example"], matrix: { mxid: "@maya:matrix.org", displayName: "maya" }, circleKid: "kid-aaaa1111", sources: ["google", "matrix"], status: "ready", updated: 5 },
  { id: "2", name: "Dev Patel", emails: ["dev@y.org"], matrix: { mxid: "@dev:hs.example", displayName: "Dev" }, circleKid: null, sources: ["matrix"], status: "needs-key", updated: 4 },
  { id: "3", name: "", emails: [], matrix: { mxid: "@ghost:matrix.org", displayName: "Ghost" }, circleKid: null, sources: ["matrix"], status: "matrix-only", updated: 3 },
  { id: "4", name: "Élodie Brun", emails: ["elodie@z.fr"], matrix: null, circleKid: null, sources: ["google"], status: "google-only", updated: 2 },
  { id: "5", name: "Ana Zed", emails: ["ana@zed.io"], matrix: null, circleKid: null, sources: ["google"], status: "google-only", updated: 1 },
  { id: "6", name: "Bo Quinn", emails: ["bo@q.org"], matrix: { mxid: "@bo:matrix.org", displayName: "Bo" }, circleKid: "kid-bbbb2222", sources: ["google", "matrix"], status: "ready", updated: 6 }
];

const sb = load();
const L = sb.__hyphaeContactsLogic;
ok(!!L, "logic is exposed without a DOM");
ok(!sb.__hyphaeContacts.open || typeof sb.__hyphaeContacts.open === "function", "API object exists");
{
  const api = sb.__hyphaeContacts;
  eq(Object.keys(api).sort(), ["annotate", "annotateAsync", "annotateText", "close", "composeTo", "open", "refresh"], "public API names");
}

// ---------------------------------------------------------------- tidy
section("tidy");
{
  const dirty = Object.assign({}, people[0], { key: "AAAA-SECRET", token: "hy1.abc.def.ghi~", body: "dear Maya...", matrix: { mxid: "@m:x", displayName: "m", accessToken: "syt_abc" } });
  const t = L.tidyOne(dirty);
  const s = JSON.stringify(t);
  ok(!/SECRET|hy1\.|dear Maya|syt_abc/.test(s), "tidy drops key/token/body/accessToken fields");
  eq(Object.keys(t).sort(), ["circleKid", "emails", "id", "matrix", "name", "sources", "status", "updated"], "tidy keeps only contract fields");
  eq(t.emails, ["maya@x.org", "maya.lin@work.example"], "tidy lowercases and dedupes emails");
  eq(L.tidyOne({ emails: ["a@b.c"] }), null, "tidy rejects a record with no id");
  eq(L.tidyOne(null), null, "tidy rejects null");
  eq(L.tidyOne({ id: "x", emails: ["a@b.co"], matrix: null, status: "banana" }).status, "google-only", "unknown status is derived, not trusted");
  eq(L.tidyOne({ id: "x", emails: ["a@b.co"], matrix: { mxid: "@a:b", displayName: "" }, circleKid: "k" }).status, "ready", "derive ready");
  eq(L.tidyOne({ id: "x", emails: ["a@b.co"], matrix: { mxid: "@a:b", displayName: "" } }).status, "needs-key", "derive needs-key");
  eq(L.tidyOne({ id: "x", emails: [], matrix: { mxid: "@a:b", displayName: "" } }).status, "matrix-only", "derive matrix-only");
  eq(L.tidy("nope"), [], "tidy of a non-array is empty");
}

const C = L.tidy(people);

// ---------------------------------------------------------------- email keys
section("emailKey");
eq(L.emailKey("Maya <Maya@X.org>"), "maya@x.org", "emailKey from a display-name address");
eq(L.emailKey("  MAYA@x.org "), "maya@x.org", "emailKey trims and lowercases");
eq(L.emailKey("mailto:a@b.co"), "a@b.co", "emailKey strips mailto:");
eq(L.emailKey("not an email"), "", "emailKey rejects non-emails");
ok(L.isEmail("a@b.co") && !L.isEmail("a@b") && !L.isEmail("a b@c.de"), "isEmail");

// ---------------------------------------------------------------- counts
section("counts");
{
  const n = L.counts(C);
  eq(n, { all: 6, ready: 2, "needs-key": 1, "matrix-only": 1, "google-only": 2 }, "counts per status");
  const v = L.view(C, { q: "matrix.org" });
  eq(v.counts, { all: 3, ready: 2, "needs-key": 0, "matrix-only": 1, "google-only": 0 }, "chip counts follow the search, not the chip");
  eq(v.total, 6, "total is all contacts");
}

// ---------------------------------------------------------------- search
section("search");
{
  const ids = (q) => L.view(C, { q }).rows.map((c) => c.id).sort();
  eq(ids("maya"), ["1"], "search by name");
  eq(ids("work.example"), ["1"], "search by a second email");
  eq(ids("@dev:hs"), ["2"], "search by Matrix ID");
  eq(ids("elodie"), ["4"], "search folds diacritics (query without accent)");
  eq(ids("élodie"), ["4"], "search folds diacritics (query with accent)");
  eq(ids("ready"), ["1", "6"], "search matches the status word");
  eq(ids("needs key"), ["2"], "search matches a multi-word status");
  eq(ids("maya matrix"), ["1"], "all tokens must match (AND)");
  eq(ids("maya dev"), [], "tokens from different people match no one");
  eq(ids("   "), ["1", "2", "3", "4", "5", "6"], "blank search shows everyone");
  eq(ids("zzzz"), [], "no match is empty");
  eq(L.view(C, { q: "ghost" }).rows.map((c) => L.displayName(c)), ["Ghost"], "nameless contact shows its Matrix display name");
  // store-side union
  const v = L.view(C, { q: "zzzz", extraIds: { "5": true } });
  eq(v.rows.map((c) => c.id), ["5"], "ids the store matched are added");
  // circle names are searchable
  eq(L.view(C, { q: "family", circleNames: { "kid-aaaa1111": "Family" } }).rows.map((c) => c.id), ["1"], "search matches the circle name");
}

// ---------------------------------------------------------------- filter + sort
section("filter and sort");
{
  const f = (o) => L.view(C, o).rows.map((c) => c.id);
  eq(f({ status: "ready" }), ["6", "1"], "filter ready (sorted by name: Bo, Maya)");
  eq(f({ status: "google-only" }), ["5", "4"], "filter google-only (Ana, Élodie)");
  eq(f({ sortKey: "name", sortDir: "asc" }), ["5", "6", "2", "4", "3", "1"], "name asc: Ana, Bo, Dev, Élodie, Ghost, Maya");
  eq(f({ sortKey: "name", sortDir: "desc" }), ["1", "3", "4", "2", "6", "5"], "name desc");
  eq(f({ sortKey: "status", sortDir: "asc" }), ["6", "1", "2", "3", "5", "4"], "status asc: ready, needs key, matrix only, google only; ties by name");
  eq(f({ sortKey: "status", sortDir: "desc" }), ["5", "4", "3", "2", "6", "1"], "status desc");
  // empty values sort last in both directions
  eq(f({ sortKey: "email", sortDir: "asc" }).slice(-1), ["3"], "empty email last (asc)");
  eq(f({ sortKey: "email", sortDir: "desc" }).slice(-1), ["3"], "empty email last (desc)");
  eq(f({ sortKey: "matrix", sortDir: "asc" }).slice(-2).sort(), ["4", "5"], "no Matrix ID last");
  eq(f({ sortKey: "circle", sortDir: "asc" }).slice(0, 2), ["1", "6"], "circle sort puts held keys first, by name of circle");
  eq(f({ sortKey: "circle", sortDir: "asc", circleNames: { "kid-aaaa1111": "Zeta", "kid-bbbb2222": "Alpha" } }).slice(0, 2), ["6", "1"], "circle sort uses the circle name when known");
  // stability + purity
  const before = JSON.stringify(C);
  L.view(C, { sortKey: "status", sortDir: "desc", q: "a" });
  ok(JSON.stringify(C) === before, "view does not mutate the contact list");
}

// ---------------------------------------------------------------- annotate
section("annotate");
{
  const a = L.annotate(C, ["maya@x.org", "Dev <dev@y.org>", "stranger@q.net", "MAYA@X.ORG", "ana@zed.io"]);
  eq(a.map((x) => x.word), ["ready", "needs key", "not in contacts", "google only"], "status words, duplicates collapsed");
  eq(a.map((x) => x.label), [
    "to Maya Lin (ready)", "to Dev Patel (needs key)", "to stranger@q.net (not in contacts)", "to Ana Zed (google only)"
  ], "labels read as the compose line wants");
  eq(L.annotateText(C, ["maya@x.org", "dev@y.org"]), "to Maya Lin (ready) · to Dev Patel (needs key)", "annotateText joins with a middle dot");
  eq(L.annotate(C, ["maya.lin@work.example"])[0].status, "ready", "second email of a contact resolves");
  eq(L.annotate(C, []), [], "no recipients, no annotations");
  eq(L.annotate(C, null), [], "null recipients, no annotations");
  // the same address on two contacts: the more ready one wins
  const dup = L.tidy([
    { id: "a", name: "Old Card", emails: ["same@x.org"], matrix: null, status: "google-only" },
    { id: "b", name: "Matrix Same", emails: ["same@x.org"], matrix: { mxid: "@s:x", displayName: "" }, circleKid: "k", status: "ready" }
  ]);
  eq(L.annotate(dup, ["same@x.org"])[0].status, "ready", "duplicate address: the most ready contact wins");
  eq(L.annotate(C, ["no-at-sign"])[0].status, null, "non-address passes through as not in contacts");
}

// ---------------------------------------------------------------- actions
section("actions");
{
  const by = (id) => C.find((c) => c.id === id);
  eq(L.primaryAction(by("1")).kind, "compose", "ready with email -> compose");
  eq(L.primaryAction(by("1")).label, "Encrypt a message to this person", "compose label as asked");
  eq(L.primaryAction(by("2")).kind, "link-key", "needs-key -> link a key");
  eq(L.primaryAction(by("2")).label, "Link a key", "link label as asked");
  eq(L.primaryAction(by("3")).kind, "add-email", "matrix-only -> add email");
  eq(L.primaryAction(by("3")).label, "Add an email address", "add label as asked");
  eq(L.primaryAction(by("4")).kind, "invite", "google-only -> invite");
  eq(L.primaryAction(by("4")).label, "Invite to hyphae", "invite label as asked");
  const noMail = L.tidyOne({ id: "z", name: "Keyed", emails: [], matrix: { mxid: "@k:x", displayName: "" }, circleKid: "k", status: "ready" });
  eq(L.primaryAction(noMail).kind, "add-email", "ready without an address cannot compose: add email");
  ok(/Signal, in person, or as a file/.test(L.explain(by("2"))) && /never by email/.test(L.explain(by("2"))), "needs-key explains the hand-over, in one line");
  ok(!/\n/.test(L.explain(by("2"))), "the explanation is a single line");
}

// ---------------------------------------------------------------- import
section("import");
{
  ok(L.checkImportFile({ name: "contacts.csv", size: 1200 }).ok, "csv accepted");
  ok(L.checkImportFile({ name: "Contacts.VCF", size: 1200 }).ok, "vcf accepted (any case)");
  ok(!L.checkImportFile({ name: "contacts.zip", size: 1200 }).ok, "zip refused");
  ok(!L.checkImportFile({ name: "contacts.csv", size: 0 }).ok, "empty refused");
  ok(!L.checkImportFile({ name: "contacts.csv", size: 26 * 1024 * 1024 }).ok, "over 25 MB refused");
  ok(!L.checkImportFile(null).ok, "no file refused");
  eq(L.importSummary({ added: 12, merged: 3, skipped: 1 }), "Imported: 12 new, 3 merged, 1 skipped.", "summary from counts");
  eq(L.importSummary({ added: 1, merged: 0, skipped: 0, conflicts: 2 }), "Imported: 1 new, 2 left out to avoid joining two people.", "conflicts are reported, not hidden");
  eq(L.linkError({ code: "conflict" }), "That would join two different people, so nothing was changed.", "link conflict in plain words");
  ok(/Nothing was changed/.test(L.linkError(new Error("x"))), "unknown link failure still says nothing changed");
  ok(!/\[object|TypeError|Error:/.test(L.linkError({ code: "weird", message: "TypeError: x" })), "raw error text is never shown");
  eq(L.importSummary({ total: 40 }), "Imported 40 contacts.", "summary from total");
  eq(L.importSummary({ added: 2, merged: 0, skipped: 0 }), "Imported: 2 new.", "zero parts are left out");
  eq(L.importSummary({ added: 0, merged: 0 }), "Nothing new in that file.", "an import that changed nothing says so");
  eq(L.importSummary(undefined), "Import finished.", "summary with nothing");
}

// ---------------------------------------------------------------- contrast
section("contrast");
{
  eq(Math.round(L.contrast("#000000", "#ffffff")), 21, "contrast of black on white is 21");
  const rows = [];
  for (const p of L.PAIRS) {
    const r = L.contrast(p.fg, p.bg);
    rows.push(r.toFixed(2) + "  " + p.fg + " on " + p.bg + "  " + p.use);
    ok(r >= 4.5, "contrast >= 4.5: " + p.use + " (" + r.toFixed(2) + ")");
  }
  console.log("  pairs (" + L.PAIRS.length + "):\n    " + rows.join("\n    "));
  // every colour the CSS paints text with is in a listed pair
  const css = /function CSS\(\)[\s\S]*?\n  }\n/.exec(SRC)[0];
  const used = new Set((css.match(/(?:^|[;{"'\s])color:" \+ c\.(\w+)/g) || []).map((s) => s.replace(/.*c\./, "")));
  const inPairs = new Set();
  const byHex = Object.fromEntries(Object.entries(L.COLORS).map(([k, v]) => [v, k]));
  for (const p of L.PAIRS) { inPairs.add(byHex[p.fg]); }
  const missing = [...used].filter((k) => !inPairs.has(k));
  eq(missing, [], "every text colour named in CSS() appears as a foreground in PAIRS");
}

// ---------------------------------------------------------------- source rules
section("source rules");
{
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "createElementNS", "<svg", "<img", "eval(", "new Function"]) {
    ok(code.indexOf(bad) < 0, "no " + bad);
  }
  ok(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|chrome\.|\.postMessage\(/.test(code), "never talks outward: no fetch/XHR/beacon/socket/chrome API/postMessage");
  ok(/attachShadow\(\{ mode: "closed" \}\)/.test(code), "closed shadow root");
  ok(!/localStorage|sessionStorage|indexedDB/.test(code), "stores nothing in the page");
  ok(/prefers-reduced-motion:reduce/.test(code), "honours reduced motion");
  ok(/aria-modal/.test(code) && /role: "dialog"/.test(code), "dialog semantics");
  ok(/hostname === "mail\.google\.com"/.test(code), "page part is gated to mail.google.com");
}

// ---------------------------------------------------------------- composeTo
section("composeTo");
{
  const events = [];
  class FakeMouse { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  const button = { dispatchEvent(e) { events.push(e.type); return true; } };
  function world(opts) {
    events.length = 0;
    const doc = {
      querySelector(sel) { return opts.button && sel === 'div[gh="cm"]' ? button : null; },
      activeElement: null
    };
    const w = {
      document: doc, MouseEvent: FakeMouse, location: { hostname: "mail.google.com" },
      __hyphaeGmail: opts.hook
    };
    w.window = w;
    const box = Object.assign({ console, setTimeout, clearTimeout, Promise }, w);
    vm.createContext(box);
    vm.runInContext(SRC, box, { filename: "sheet.js" });
    return w; // sheet.js attaches to window, which is w
  }

  const calls = [];
  let w = world({ button: true, hook: { composeTo(e) { calls.push(e); return Promise.resolve(); } } });
  let r = await w.__hyphaeContacts.composeTo({ id: "1", emails: ["Maya@X.org"] });
  eq(calls, ["maya@x.org"], "hook gets the bare lowercased address");
  ok(r.ok && r.via === "hook" && r.filled && events.length === 0, "hook path does not touch Gmail's Compose button itself");
  const argsSeen = [];
  w = world({ button: true, hook: { composeTo(e, o) { argsSeen.push([e, o]); return Promise.resolve(); } } });
  await w.__hyphaeContacts.composeTo({ id: "1", emails: ["maya@x.org"], circleKid: "kid-aaaa1111" });
  eq(argsSeen[0], ["maya@x.org", { circleKid: "kid-aaaa1111" }], "hook is told which circle this person's key opens");
  await w.__hyphaeContacts.composeTo("stranger@x.org");
  eq(argsSeen[1], ["stranger@x.org", undefined], "no circle known: the hook gets the address alone");

  w = world({ button: true, hook: undefined });
  r = await w.__hyphaeContacts.composeTo("maya@x.org");
  ok(r.ok && r.via === "fallback" && r.filled === false && r.opened, "no hook: compose opened, nothing filled");
  eq(events, ["mousedown", "mouseup", "click"], "fallback presses Compose the way Gmail needs (mousedown, mouseup, click)");

  w = world({ button: false, hook: undefined });
  r = await w.__hyphaeContacts.composeTo("maya@x.org");
  ok(!r.ok && !r.opened && r.why === "no-compose-button", "no hook and no Compose button: reported, not thrown");

  w = world({ button: true, hook: { composeTo() { throw new Error("boom"); } } });
  r = await w.__hyphaeContacts.composeTo("maya@x.org");
  ok(r.ok && r.via === "fallback" && r.why === "hook-failed", "a throwing hook falls back to opening compose");

  w = world({ button: true, hook: { composeTo() { return Promise.reject(new Error("nope")); } } });
  r = await w.__hyphaeContacts.composeTo("maya@x.org");
  ok(r.via === "fallback" && r.why === "hook-failed", "a rejecting hook falls back");

  w = world({ button: true, hook: { composeTo() { calls.push("should-not"); } } });
  const before = calls.length;
  r = await w.__hyphaeContacts.composeTo({ id: "9", emails: [] });
  ok(!r.ok && r.why === "no-email" && calls.length === before, "no address: nothing opened, hook not called");
}

// ---------------------------------------------------------------- annotateAsync + port
section("port");
{
  let allCalls = 0;
  const port = { all() { allCalls++; return Promise.resolve(people.map((p) => Object.assign({ secretKey: "NOPE" }, p))); } };
  const w = { __hyphaeContactsPort: port, console, setTimeout, clearTimeout, Promise, location: { hostname: "mail.google.com" } };
  w.window = w;
  vm.createContext(w);
  vm.runInContext(SRC, w, { filename: "sheet.js" });
  const api = w.__hyphaeContacts;
  eq(api.annotate(["maya@x.org"])[0].status, null, "annotate on a cold cache says not in contacts (and starts a load)");
  const a = await api.annotateAsync(["maya@x.org", "dev@y.org"]);
  eq(a.map((x) => x.word), ["ready", "needs key"], "annotateAsync waits for the port");
  eq(api.annotate(["maya@x.org"])[0].word, "ready", "annotate is warm afterwards");
  ok(allCalls >= 1 && allCalls <= 2, "the port is asked once or twice, not per call (" + allCalls + ")");
  eq(await api.refresh(), 6, "refresh resolves to the contact count");
  // no port at all
  const bare = load();
  eq(await bare.__hyphaeContacts.refresh(), 0, "refresh with no port resolves 0, does not throw");
  eq(bare.__hyphaeContacts.annotate(["a@b.co"])[0].word, "not in contacts", "annotate with no port is calm");
}

console.log("\nhyphae contacts sheet: " + pass + " passed, " + fail + " failed");
if (fail) { console.log("failures:\n  " + failures.join("\n  ")); process.exit(1); }
