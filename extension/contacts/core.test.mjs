// node extension/contacts/core.test.mjs
// Tests for contacts/core.js (HyContacts). No dependencies; prints pass/fail counts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
await import("./core.js");
const HyContacts = globalThis.HyContacts;

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail !== undefined ? "  -> " + detail : ""));
  console.log("  FAIL " + name + (detail !== undefined ? "  -> " + detail : ""));
}
function eq(a, b, name) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  ok(x === y, name, "got " + x + " want " + y);
}
async function rejects(p, code, name) {
  try { await p; ok(false, name, "did not reject"); }
  catch (e) { ok(e && e.code === code, name, "code " + (e && e.code) + " / " + (e && e.message)); }
}
function section(s) { console.log(s); }

// storage double: JSON round trip like chrome.storage, records what it was asked for
function memStorage(seed) {
  const m = new Map();
  if (seed) for (const k of Object.keys(seed)) m.set(k, JSON.stringify(seed[k]));
  return {
    keysRead: new Set(), keysWritten: new Set(), sets: 0,
    async get(k) { this.keysRead.add(k); return m.has(k) ? JSON.parse(m.get(k)) : undefined; },
    async set(k, v) { this.keysWritten.add(k); this.sets++; m.set(k, JSON.stringify(v)); },
    dump() { const o = {}; for (const [k, v] of m) o[k] = JSON.parse(v); return o; },
    raw() { return [...m.values()].join("\n"); },
  };
}
function clock() { let t = 1_700_000_000_000; const f = () => (t += 1000); f.peek = () => t; return f; }
function fresh(seed) {
  const storage = memStorage(seed);
  const now = clock();
  return { storage, now, store: HyContacts.create({ storage, now }) };
}

// ---------------------------------------------------------------------------
section("contract: shape, sorting, lookup");
{
  const { store } = fresh();
  eq(await store.all(), [], "empty directory");
  const r = await store.importGoogle([
    { name: "Zed Zhang", emails: ["zed@example.com"] },
    { name: "alice Adams", emails: ["Alice@Example.com", "alice.work@example.org"], source: "csv" },
    { name: "Bob Brown", emails: ["bob@example.com"], source: "api" },
  ]);
  eq(r, { added: 3, merged: 0, skipped: 0, conflicts: 0 }, "importGoogle result");
  const all = await store.all();
  eq(all.map((c) => c.name), ["alice Adams", "Bob Brown", "Zed Zhang"], "sorted by name, case-insensitive");
  const a = all[0];
  eq(a.emails, ["alice@example.com", "alice.work@example.org"], "emails normalised, order kept");
  eq(Object.keys(a).sort(), ["addressable", "circleKid", "emails", "id", "matrix", "name", "sources", "status", "updated"], "Contact fields");
  eq([a.matrix, a.circleKid, a.sources, a.status, a.addressable], [null, null, ["google"], "google-only", true], "google contact defaults");
  ok(typeof a.updated === "number" && /^c_[a-z0-9]+$/.test(a.id), "id and updated types");
  eq((await store.byEmail("ALICE@example.COM")).id, a.id, "byEmail is case-insensitive");
  eq((await store.byEmail("  bob@example.com ")).name, "Bob Brown", "byEmail trims");
  eq(await store.byEmail("nobody@example.com"), null, "byEmail miss is null");
  eq(await store.byEmail("not an email"), null, "byEmail malformed is null");
  eq(await store.byEmail(null), null, "byEmail null is null");
  // mutating a returned view does not touch the store
  a.emails.push("x@y.zz"); a.name = "changed";
  eq((await store.all())[0].emails.length, 2, "views are copies");
}

section("email matching does not collapse gmail dots or plus");
{
  const { store } = fresh();
  await store.importGoogle([
    { name: "J Doe", emails: ["j.doe@gmail.com"] },
    { name: "Jay Doe", emails: ["jdoe@gmail.com"] },
    { name: "Jay Tag", emails: ["jdoe+news@gmail.com"] },
    { name: "Googlemail", emails: ["jdoe@googlemail.com"] },
  ]);
  eq((await store.all()).length, 4, "four distinct contacts");
  eq((await store.byEmail("jdoe@gmail.com")).name, "Jay Doe", "byEmail is exact after lowercasing");
  eq(await store.byEmail("JDOE+other@gmail.com"), null, "plus alias is not folded");
}

section("search");
{
  const { store } = fresh();
  await store.importGoogle([{ name: "Maria Lopez", emails: ["maria@acme.example"] }, { name: "Ken Ito", emails: ["ken@acme.example"] }]);
  await store.importMatrix([{ mxid: "@ken:matrix.example", displayName: "Kenji" }]);
  eq((await store.search("acme")).length, 2, "search by email domain");
  eq((await store.search("MARIA")).map((c) => c.name), ["Maria Lopez"], "search by name, case-insensitive");
  eq((await store.search("matrix.example")).map((c) => c.name), ["Kenji"], "search by mxid");
  eq((await store.search("kenji")).length, 1, "search by matrix display name");
  eq((await store.search("maria acme")).length, 1, "all words must match");
  eq((await store.search("maria ken")).length, 0, "words are ANDed");
  eq((await store.search("")).length, 3, "empty query is everything");
  eq((await store.search(undefined)).length, 3, "undefined query is everything");
}

// ---------------------------------------------------------------------------
section("idempotent imports");
{
  const { store, storage } = fresh();
  const g = [
    { name: "Ann Lee", emails: ["ann@example.com", "ann2@example.com"] },
    { name: "Ben Ray", emails: ["ben@example.com"] },
  ];
  const m = [
    { mxid: "@ann:hs.example", displayName: "Ann", emails: ["ann@example.com"] },
    { mxid: "@cy:hs.example", displayName: "Cy" },
  ];
  await store.importGoogle(g);
  await store.importMatrix(m);
  const state1 = JSON.stringify(storage.dump());
  const sets1 = storage.sets;
  const r1 = await store.importGoogle(g);
  const r2 = await store.importMatrix(m);
  eq([r1.added, r1.skipped], [0, 0], "second google import adds nothing");
  eq([r2.added, r2.skipped], [0, 0], "second matrix import adds nothing");
  eq(JSON.stringify(storage.dump()), state1, "state byte-identical after re-import (updated included)");
  eq(storage.sets, sets1, "re-import writes nothing");
  eq((await store.all()).length, 3, "three people, not five");
  // same entry twice inside one list
  const { store: s2 } = fresh();
  const r = await s2.importGoogle([g[0], g[0], g[0]]);
  eq([r.added, r.merged], [1, 2], "duplicates inside a list collapse");
}

section("re-import updates names without duplicating");
{
  const { store, now } = fresh();
  await store.importGoogle([{ name: "Ann Lee", emails: ["ann@example.com"] }]);
  const before = (await store.all())[0];
  await store.importGoogle([{ name: "Ann Lee-Park", emails: ["ann@example.com"] }]);
  const all = await store.all();
  eq(all.length, 1, "no duplicate");
  eq(all[0].name, "Ann Lee-Park", "name updated");
  ok(all[0].updated > before.updated, "updated moved because it changed");
  eq(all[0].id, before.id, "id stable");
  await store.importGoogle([{ name: "", emails: ["ann@example.com"] }]);
  eq((await store.all())[0].name, "Ann Lee-Park", "an empty name never erases one");
  // matrix display name follows the Matrix side, google name wins for `name`
  await store.importMatrix([{ mxid: "@ann:hs.example", displayName: "Annie", emails: ["ann@example.com"] }]);
  await store.importMatrix([{ mxid: "@ann:hs.example", displayName: "Annie L" }]);
  const c = (await store.all())[0];
  eq([c.name, c.matrix.displayName], ["Ann Lee-Park", "Annie L"], "google name kept, matrix displayName updated");
  // a matrix-only contact takes its name from Matrix until Google supplies one
  await store.importMatrix([{ mxid: "@dee:hs.example", displayName: "Dee" }]);
  eq((await store.search("dee"))[0].name, "Dee", "name falls back to matrix displayName");
  await store.importMatrix([{ mxid: "@dee:hs.example", displayName: "Dee Two" }]);
  eq((await store.search("dee"))[0].name, "Dee Two", "and follows it");
}

// ---------------------------------------------------------------------------
section("merging: email first, then exact mxid, never by name");
{
  const { store } = fresh();
  await store.importGoogle([{ name: "Sam Hill", emails: ["sam@example.com"] }]);
  const r = await store.importMatrix([{ mxid: "@sam:hs.example", displayName: "Sam Hill", emails: ["SAM@example.com"] }]);
  eq([r.added, r.merged], [0, 1], "matrix entry with a shared email merges");
  const all = await store.all();
  eq(all.length, 1, "one contact");
  eq([all[0].sources, all[0].matrix.mxid], [["google", "matrix"], "@sam:hs.example"], "sources union, mxid linked");

  // exact mxid merge: a later import carrying a new email joins the same contact
  const r2 = await store.importMatrix([{ mxid: "@sam:hs.example", emails: ["sam.home@example.org"] }]);
  eq([r2.added, r2.merged], [0, 1], "same mxid merges");
  eq((await store.all())[0].emails, ["sam@example.com", "sam.home@example.org"], "new email attached");

  // mxid server is case-insensitive, local part is exact
  const r3 = await store.importMatrix([{ mxid: "@sam:HS.Example" }]);
  eq([r3.added, r3.merged], [0, 1], "server part lower-cased");
  const r4 = await store.importMatrix([{ mxid: "@Sam:hs.example" }]);
  eq([r4.added, r4.merged], [1, 0], "local part is exact: @Sam is another account");
}

section("same display name stays separate");
{
  const { store } = fresh();
  await store.importGoogle([
    { name: "Alex Kim", emails: ["alex.kim@work.example"] },
    { name: "Alex Kim", emails: ["akim@home.example"] },
  ]);
  const r = await store.importMatrix([
    { mxid: "@alex:one.example", displayName: "Alex Kim" },
    { mxid: "@alexk:two.example", displayName: "Alex Kim" },
  ]);
  eq([r.added, r.merged], [2, 0], "matrix 'Alex Kim' entries do not merge into the google ones");
  const all = await store.all();
  eq(all.length, 4, "four separate Alex Kims");
  eq(all.filter((c) => c.matrix).every((c) => c.emails.length === 0), true, "matrix ones gained no email by name");
  eq(all.filter((c) => !c.matrix).every((c) => c.status === "google-only"), true, "google ones got no matrix link by name");
  // and a re-import of the same stays four
  await store.importMatrix([{ mxid: "@alex:one.example", displayName: "Alex Kim" }]);
  eq((await store.all()).length, 4, "still four");
}

section("a matrix contact with no email joins google only by shared email or explicit link()");
{
  const { store } = fresh();
  await store.importGoogle([{ name: "Pat Quinn", emails: ["pat@example.com"] }]);
  await store.importMatrix([{ mxid: "@pat:hs.example", displayName: "Pat Quinn" }]);
  let all = await store.all();
  eq(all.length, 2, "not merged on a matching name");
  const g = all.find((c) => c.emails.length);
  const m = all.find((c) => c.matrix);
  await store.setHeldCircles(["kidAAAAAAAA"]);
  await store.link(m.id, { circleKid: "kidAAAAAAAA" });
  // explicit: attach the matrix account to the google contact
  const linked = await store.link(g.id, { mxid: "@pat:hs.example" });
  all = await store.all();
  eq(all.length, 1, "explicit link merged the two");
  eq([linked.id, linked.emails, linked.matrix.mxid, linked.circleKid, linked.status], [g.id, ["pat@example.com"], "@pat:hs.example", "kidAAAAAAAA", "ready"], "merged contact keeps both identities and the circle");
  eq(linked.sources.slice().sort(), ["google", "manual", "matrix"], "sources include manual");
}

section("conflicts are left out, never merged");
{
  const { store } = fresh();
  await store.importMatrix([{ mxid: "@bob:hs.example", displayName: "Bob", emails: ["shared@example.com"] }]);
  // a different Matrix account claiming the same email must not merge into Bob
  const r = await store.importMatrix([{ mxid: "@robert:hs.example", displayName: "Robert", emails: ["shared@example.com"] }]);
  eq([r.added, r.conflicts], [1, 1], "second account is its own contact and counted as a conflict");
  const all = await store.all();
  eq(all.length, 2, "two contacts");
  eq(all.find((c) => c.matrix.mxid === "@robert:hs.example").emails, [], "robert did not get bob's email");
  eq((await store.byEmail("shared@example.com")).matrix.mxid, "@bob:hs.example", "the email stays with its first owner");
  // a google entry spanning two contacts with different matrix links does not fuse them
  const { store: s2 } = fresh();
  await s2.importMatrix([
    { mxid: "@a:hs.example", emails: ["a@example.com"] },
    { mxid: "@b:hs.example", emails: ["b@example.com"] },
  ]);
  const r2 = await s2.importGoogle([{ name: "Both", emails: ["a@example.com", "b@example.com"] }]);
  eq([r2.merged, r2.conflicts], [1, 1], "google entry joined one, flagged the other");
  eq((await s2.all()).length, 2, "the two matrix people stay two");
  // a google entry spanning two google-only contacts DOES fuse them (user's own address book says same person)
  const { store: s3 } = fresh();
  await s3.importGoogle([{ name: "Robert", emails: ["r1@example.com"] }, { name: "Bob", emails: ["r2@example.com"] }]);
  await s3.importGoogle([{ name: "Rob", emails: ["r1@example.com", "r2@example.com"] }]);
  const f = await s3.all();
  eq([f.length, f[0].emails], [1, ["r1@example.com", "r2@example.com"]], "compatible contacts fuse on a shared entry");
}

// ---------------------------------------------------------------------------
section("status is computed from held circles, never stored");
{
  const { store, storage } = fresh();
  await store.importGoogle([{ name: "Gee", emails: ["gee@example.com"] }]);
  await store.importMatrix([
    { mxid: "@em:hs.example", displayName: "Em", emails: ["em@example.com"] },
    { mxid: "@mo:hs.example", displayName: "Mo" },
    { mxid: "@kay:hs.example", displayName: "Kay", emails: ["kay@example.com"] },
  ]);
  const by = async (q) => (await store.search(q))[0];
  eq((await by("gee")).status, "google-only", "google-only: an email, no matrix link");
  eq((await by("em@")).status, "needs-key", "needs-key: matrix + email, no circle");
  eq((await by("mo")).status, "matrix-only", "matrix-only: matrix, no email, no circle");
  const em = await by("em@");
  await store.link(em.id, { circleKid: "kidEEEEEEEE" });
  eq((await by("em@")).status, "needs-key", "a circleKid that is not held is still needs-key");
  await store.setHeldCircles(["kidEEEEEEEE"]);
  const ready = await by("em@");
  eq([ready.status, ready.addressable], ["ready", true], "ready once the circle is held");
  await store.setHeldCircles([]);
  eq((await by("em@")).status, "needs-key", "status follows the held list down again");
  await store.setHeldCircles(["kidEEEEEEEE"]);
  // circle set on a matrix contact without email is literally 'ready' but not addressable
  const mo = await by("mo");
  await store.link(mo.id, { circleKid: "kidEEEEEEEE" });
  const mo2 = await by("mo");
  eq([mo2.status, mo2.addressable], ["ready", false], "ready per contract, addressable:false");
  // google-only contact with a circle but no matrix link is not ready
  const gee = await by("gee");
  await store.link(gee.id, { circleKid: "kidEEEEEEEE" });
  eq((await by("gee")).status, "google-only", "a circle without a matrix link is not ready");
  ok(!/"status"/.test(storage.raw()), "status never reaches storage");
  eq((await store.setHeldCircles(["kidEEEEEEEE", "kidEEEEEEEE", "bad kid", 5, null, "A".repeat(43)])), { held: 1, ignored: 4 }, "setHeldCircles dedupes and ignores junk and key-shaped ids");
  await rejects(store.setHeldCircles("kidEEEEEEEE"), "invalid", "setHeldCircles rejects non-arrays rather than wiping the list");
  eq((await by("em@")).status, "ready", "a rejected setHeldCircles changed nothing");
}

section("link / unlink");
{
  const { store } = fresh();
  await store.importGoogle([{ name: "Lin", emails: ["lin@example.com"] }]);
  const c = (await store.all())[0];
  let r = await store.link(c.id, { mxid: "@lin:hs.example", circleKid: "kidLLLLLLLL" });
  eq([r.matrix, r.circleKid, r.sources.includes("manual")], [{ mxid: "@lin:hs.example", displayName: "" }, "kidLLLLLLLL", true], "link sets mxid and circle");
  r = await store.link(c.id, { mxid: "@other:hs.example" });
  eq([r.matrix.mxid, r.circleKid], ["@other:hs.example", null], "re-pointing at another account clears the circle");
  r = await store.link(c.id, { mxid: "@lin:hs.example", circleKid: "kidLLLLLLLL" });
  eq(r.circleKid, "kidLLLLLLLL", "same patch may set the circle for the new account");
  r = await store.link(c.id, { circleKid: null });
  eq(r.circleKid, null, "null clears circleKid");
  r = await store.link(c.id, { circleKid: "kidLLLLLLLL" });
  r = await store.link(c.id, { mxid: null });
  eq([r.matrix, r.circleKid, r.status, r.sources.includes("matrix")], [null, null, "google-only", false], "unlink clears matrix AND its circle");
  r = await store.link(c.id, { email: "Lin.Work@Example.com" });
  eq(r.emails, ["lin@example.com", "lin.work@example.com"], "link adds an email");
  r = await store.link(c.id, { removeEmail: "lin@example.com" });
  eq(r.emails, ["lin.work@example.com"], "removeEmail");
  await rejects(store.link(c.id, { email: null }), "invalid", "cannot strip the last way to reach a contact");
  await rejects(store.link(c.id, { email: "nope" }), "invalid", "malformed email rejected");
  await rejects(store.link(c.id, { mxid: "not-an-mxid" }), "invalid", "malformed mxid rejected");
  await rejects(store.link(c.id, { circleKid: "x".repeat(43) }), "invalid", "a key-shaped circle id is rejected");
  await rejects(store.link("c_nosuchid", { mxid: "@a:b.example" }), "not-found", "unknown id");
  await rejects(store.link(c.id, null), "invalid", "non-object patch");
  eq((await store.all())[0].emails, ["lin.work@example.com"], "rejections changed nothing");

  // conflicts on explicit link are refused
  await store.importMatrix([{ mxid: "@zed:hs.example", emails: ["zed@example.com"] }]);
  await store.link((await store.byEmail("zed@example.com")).id, { circleKid: "kidZZZZZZZZ" });
  await store.link(c.id, { circleKid: "kidLLLLLLLL" });
  await rejects(store.link(c.id, { email: "zed@example.com" }), "conflict", "linking an email whose owner has another circle is refused");
  await rejects(store.link(c.id, { mxid: "@zed:hs.example" }), "conflict", "linking an mxid whose owner has another circle is refused");
  eq((await store.all()).length, 2, "nothing merged");
}

section("remove");
{
  const { store } = fresh();
  await store.importGoogle([{ name: "Rem", emails: ["rem@example.com"] }]);
  const c = (await store.all())[0];
  eq(await store.remove("c_nosuchid"), false, "remove unknown");
  eq(await store.remove(c.id), true, "remove known");
  eq([await store.all(), await store.byEmail("rem@example.com")], [[], null], "gone, and the email index is clean");
  const r = await store.importGoogle([{ name: "Rem", emails: ["rem@example.com"] }]);
  eq(r.added, 1, "not sticky: a re-import brings them back (documented)");
}

// ---------------------------------------------------------------------------
section("stores no keys, tokens or message content");
{
  const KEY43 = "dGhpcy1pcy1hLWZha2Uta2V5LTMyLWJ5dGVzLW9mLWR"; // 43 base64url chars
  ok(KEY43.length === 43, "fixture really is 43 chars");
  const TOKEN = "hy1.AAAAAAAAAAA.BBBBBBBBBBBBBBBB.CCCCCCCCCCCCCCCCCCCCCC~";
  const { store, storage } = fresh();
  await store.importGoogle([
    { name: "Secret " + KEY43, emails: ["ok@example.com"], access_token: "ya29.abcdef", key: KEY43, body: "dear diary" },
    { name: TOKEN, emails: ["tok@example.com"] },
    { name: "Fine Name", emails: [KEY43 + "@example.com", "fine@example.com"], refresh_token: "r-1" },
    { name: "Named", emails: ["access_token@example.com"] },
  ]);
  await store.importMatrix([
    { mxid: "@m:hs.example", displayName: "hy1key.abc.def." + KEY43, emails: ["m@example.com"], access_token: "syt_abc" },
    { mxid: "@" + KEY43 + ":hs.example" },
  ]);
  await store.link((await store.byEmail("ok@example.com")).id, { circleKid: "kidSAFESAFE" });
  await store.setHeldCircles(["kidSAFESAFE", KEY43, TOKEN]);
  const text = storage.raw();
  ok(!/[A-Za-z0-9_-]{43,}/.test(text), "no 43+ char base64url run anywhere in storage");
  ok(!/hy1\./.test(text) && !/hy1key\./.test(text), "no hy1. token in storage");
  ok(!/refresh_token/.test(text) && !/ya29/.test(text) && !/syt_/.test(text), "no provider tokens in storage");
  ok(!/dear diary/.test(text), "no message content in storage");
  // allowed top-level fields only
  const st = storage.dump().hyContacts;
  eq(Object.keys(st).sort(), ["held", "items", "v"], "state has only v, items, held");
  const allowed = ["circleKid", "emails", "id", "matrix", "name", "sources", "updated"];
  ok(st.items.every((i) => JSON.stringify(Object.keys(i).sort()) === JSON.stringify(allowed)), "records carry only id/name/emails/matrix/circleKid/sources/updated");
  eq(st.held, ["kidSAFESAFE"], "held holds only the circle id");
  ok((await store.byEmail("ok@example.com")).name === "ok@example.com", "a key-shaped name was dropped, contact kept");
  ok((await store.byEmail("tok@example.com")).name === "tok@example.com", "a token-shaped name was dropped");
  eq(await store.byEmail(KEY43 + "@example.com"), null, "a key-shaped email is refused");
  eq((await store.search("m@example.com"))[0].matrix.displayName, "", "a token-shaped matrix displayName is dropped");
  eq((await store.search(KEY43)).length, 0, "nothing key-shaped was stored to search for");
}

section("tampered storage is scrubbed, not trusted");
{
  const KEY43 = "dGhpcy1pcy1hLWZha2Uta2V5LTMyLWJ5dGVzLW9mLWR";
  const seed = { hyContacts: {
    v: 1,
    held: ["kidOK", KEY43],
    items: [
      { id: "c_goodid1234", name: "Tam", emails: ["tam@example.com", "TAM@example.com", "bad"], matrix: { mxid: "@tam:hs.example", displayName: "T", access_token: "syt" }, circleKid: KEY43, sources: ["google", "evil"], updated: 5, secret: KEY43, body: "msg" },
      { id: "__proto__", name: "Proto", emails: ["proto@example.com"], matrix: null, circleKid: null, sources: [], updated: "x" },
      { id: "c_dupmail1234", name: "Dup", emails: ["tam@example.com"], matrix: null },
      { id: "c_empty123456", name: "Nobody", emails: [], matrix: null },
      "garbage", 5, null,
    ],
  } };
  const { store, storage } = fresh(seed);
  const all = await store.all();
  eq(all.map((c) => c.name).sort(), ["Proto", "Tam"], "garbage, empty and duplicate-email records dropped");
  const tam = all.find((c) => c.name === "Tam");
  eq([tam.emails, tam.circleKid, tam.sources], [["tam@example.com"], null, ["google"]], "fields rebuilt");
  ok(all.find((c) => c.name === "Proto").id !== "__proto__", "a __proto__ id was replaced");
  eq(storage.sets, 0, "reads never write");
  await store.setHeldCircles(["kidOK"]);
  ok(!/secret|access_token|msg|syt/.test(storage.raw()), "next write persists the scrubbed state");
}

section("prototype pollution and hostile keys");
{
  const { store } = fresh();
  const evil = JSON.parse('{"name":"Evil","emails":["evil@example.com"],"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  await store.importGoogle([evil, { name: "__proto__", emails: ["proto@example.com"] }, { name: "constructor", emails: ["ctor@example.com"] }]);
  await store.importMatrix([JSON.parse('{"mxid":"@__proto__:hs.example","displayName":"__proto__","__proto__":{"polluted":true}}')]);
  ok({}.polluted === undefined && Object.prototype.polluted === undefined, "Object.prototype untouched");
  const all = await store.all();
  eq(all.length, 4, "hostile values imported as plain data");
  await rejects(store.link("__proto__", { mxid: "@a:b.example" }), "not-found", "link('__proto__') is not-found");
  await rejects(store.link("constructor", { mxid: "@a:b.example" }), "not-found", "link('constructor') is not-found");
  eq(await store.remove("__proto__"), false, "remove('__proto__') is false");
  ok({}.polluted === undefined, "still untouched");
  await store.importGoogle([{ name: "x", emails: { length: 1, 0: "a@b.cc" } }, { name: {}, emails: ["n@example.com"] }, 7, null, "str", []]);
  ok((await store.all()).length >= 4, "odd shapes do not break the store");
}

section("defensive input and caps");
{
  const { store } = fresh();
  const r = await store.importGoogle([
    { name: "No email", emails: [] },
    { name: "Bad emails", emails: ["a", "@b.cc", "a@b", "a b@c.dd", "a@b..cc", ".a@b.cc", "a.@b.cc", "<a@b.cc>", "x".repeat(300) + "@b.cc"] },
    { name: "Good", emails: ["good@example.com", "junk", 5, null] },
    "nope", 12, null, {},
  ]);
  eq([r.added, r.skipped], [1, 6], "malformed entries skipped, good one kept");
  eq((await store.all())[0].emails, ["good@example.com"], "bad addresses on a good entry are dropped");
  const m = await store.importMatrix([{ mxid: "alice:hs.example" }, { mxid: "@alice" }, { mxid: "@a b:c.example" }, { mxid: "@:hs.example" }, { mxid: "@a:b c" }, { displayName: "x" }, { mxid: "@ok:hs.example" }]);
  eq([m.added, m.skipped], [1, 6], "malformed mxids skipped");
  const longName = "word ".repeat(100);
  await store.importGoogle([{ name: "A\u0000B‮C\n  D" + "  ", emails: ["ctl@example.com"] }, { name: longName, emails: ["long@example.com"] }]);
  eq((await store.byEmail("ctl@example.com")).name, "A B C D", "control and bidi characters stripped from names");
  eq((await store.byEmail("long@example.com")).name.length, 199, "names capped at 200 (then trimmed)");
  await store.importGoogle([{ name: "N".repeat(500), emails: ["run@example.com"] }]);
  eq((await store.byEmail("run@example.com")).name, "run@example.com", "an unbroken 500-char run looks like a key and is dropped, not truncated");
  const many = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11", "a12"].map((l) => l + "@many.example");
  await store.importGoogle([{ name: "Many", emails: many }]);
  eq((await store.byEmail("a1@many.example")).emails.length, 10, "emails per contact capped");
}
{
  const { store } = fresh();
  const N = HyContacts.LIMITS.contacts;
  const list = [];
  for (let i = 0; i < N + 3; i++) list.push({ name: "P" + i, emails: ["p" + i + "@bulk.example"] });
  const t0 = Date.now();
  const r = await store.importGoogle(list);
  eq([r.added, r.skipped], [N, 3], "list capped at LIMITS.contacts (" + N + ")");
  eq((await store.all()).length, N, "directory holds exactly the cap");
  const r2 = await store.importGoogle([{ name: "Over", emails: ["over@bulk.example"] }, { name: "P5 renamed", emails: ["p5@bulk.example"] }]);
  eq([r2.added, r2.merged, r2.skipped], [0, 1, 1], "at the cap: new people skipped, existing ones still update");
  const r3 = await store.importMatrix([{ mxid: "@over:hs.example" }]);
  eq([r3.added, r3.skipped], [0, 1], "cap applies to matrix imports too");
  console.log("  (bulk " + N + " in " + (Date.now() - t0) + " ms)");
}

section("serialised operations");
{
  const { store } = fresh();
  const slow = HyContacts.create({
    storage: { _m: new Map(), async get(k) { await new Promise((r) => setTimeout(r, 5)); return this._m.get(k); }, async set(k, v) { await new Promise((r) => setTimeout(r, 5)); this._m.set(k, JSON.parse(JSON.stringify(v))); } },
  });
  await Promise.all([
    slow.importGoogle([{ name: "One", emails: ["one@example.com"] }]),
    slow.importGoogle([{ name: "Two", emails: ["two@example.com"] }]),
    slow.importMatrix([{ mxid: "@three:hs.example" }]),
  ]);
  eq((await slow.all()).length, 3, "parallel imports all land");
  void store;
}

section("local only, and only its own storage key");
{
  const src = fs.readFileSync(path.join(here, "core.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const bad of ["fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket", "EventSource", "importScripts", "chrome.", "setTimeout", "setInterval", "localStorage", "indexedDB", "require(", "import("]) {
    ok(!code.includes(bad), "core.js does not use " + bad);
  }
  ok(!/https?:\/\//.test(code), "core.js has no URLs");
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = () => { called++; throw new Error("network"); };
  const { store, storage } = fresh();
  await store.importGoogle([{ name: "A", emails: ["a@example.com"] }]);
  await store.importMatrix([{ mxid: "@a:hs.example", emails: ["a@example.com"] }]);
  await store.all(); await store.search("a"); await store.byEmail("a@example.com");
  await store.setHeldCircles(["kid12345678"]);
  globalThis.fetch = realFetch;
  eq(called, 0, "no network calls during use");
  eq([...storage.keysRead], ["hyContacts"], "reads only its own key (never 'circles')");
  eq([...storage.keysWritten], ["hyContacts"], "writes only its own key");
  const own = HyContacts.create({ storage, key: "elsewhere" });
  await own.importGoogle([{ name: "B", emails: ["b@example.com"] }]);
  ok(storage.keysWritten.has("elsewhere") && !storage.keysWritten.has("circles"), "key option respected");
}

section("fromChrome adapter and chrome-shaped reads");
{
  const area = {
    _o: {},
    get(k) { return Promise.resolve({ [k]: this._o[k] }); },
    set(o) { Object.assign(this._o, JSON.parse(JSON.stringify(o))); return Promise.resolve(); },
  };
  const store = HyContacts.create({ storage: HyContacts.fromChrome(area) });
  await store.importGoogle([{ name: "Chrome", emails: ["c@example.com"] }]);
  ok(Object.keys(area._o).join() === "hyContacts", "adapter writes {hyContacts: state}");
  eq((await store.all()).length, 1, "adapter round trip");
  const lax = HyContacts.create({ storage: { get: async (k) => ({ [k]: area._o[k] }), set: async () => {} } });
  eq((await lax.all()).length, 1, "tolerates a storage whose get returns {key: value}");
  let threw = false;
  try { HyContacts.create({}); } catch (e) { threw = e instanceof TypeError; }
  ok(threw, "create without storage throws TypeError");
}

// ---------------------------------------------------------------------------
console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) {
  console.log("\nfailures:\n  " + failures.join("\n  "));
  process.exit(1);
}
