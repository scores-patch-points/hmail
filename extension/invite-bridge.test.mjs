// node extension/invite-bridge.test.mjs
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
const require = createRequire(import.meta.url);
require("./crypto.js"); require("./invite/p256.js"); require("./invite/spake2.js");
require("./invite/hyinvite.js"); require("./invite-bridge.js");
const HI = globalThis.HyInvite;
const { create } = globalThis.HyInviteBridge;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };
const store = () => { const m = new Map(); return { get: async k => m.get(k), set: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); } , _m: m }; };

const sS = store(), sR = store();
const S = create({ HyInvite: HI, storage: sS, name: "Sam" });
const R = create({ HyInvite: HI, storage: sR, name: "Riley" });

// 1. nobody is connected yet
let w = await S.handle("who", { addrs: ["riley@example.com"] });
ok(w.ok && w.who["riley@example.com"].state === "none", "unknown address is 'none'");
let sealed = await S.handle("seal", { recipients: ["riley@example.com"], text: "hello", subject: "plan" });
ok(!sealed.ok && sealed.reason === "not-connected", "seal refuses a stranger");

// 2. invite: brand-free by default, code kept out of the mail
const inv = await S.handle("invite-create", { to: "riley@example.com", mode: "code" });
ok(inv.ok && inv.code && inv.setup, "invite-create returns code and setup for the panel");
ok(!/hyphae/i.test(inv.subject + inv.body.split("-- the part below")[0]), "invite mail names no product");
ok(inv.body.indexOf(inv.code.replace(/[^A-Za-z0-9]/g, "")) === -1, "code is not in the mail body");
ok(/hyphae/i.test(inv.setup) && /1 day|within a day/i.test(inv.setup), "setup instructions are for the second channel");

// 3. a wrong code costs a try and pairs nothing; right code pairs
const read = await R.handle("invite-read", { text: inv.body, from: "sam@example.com" });
ok(read.ok && read.invite.mode === "code", "recipient reads the invite");
const bad = await R.handle("invite-join", { text: inv.body, from: "sam@example.com", code: "AAAA-AAAA" });
if (bad.ok) {
  const badAcc = await S.handle("hello-accept", { text: bad.hello });
  ok(!badAcc.ok, "a hello from a wrong code is refused");
} else ok(true, "wrong code refused at join: " + bad.reason);
const join = await R.handle("invite-join", { text: inv.body, from: "sam@example.com", code: inv.code, label: "Sam" });
ok(join.ok && /hy1hello/.test(join.hello), "right code gives a hello token");
const acc = await S.handle("hello-accept", { text: join.hello });
ok(acc.ok && acc.welcome && acc.to === "riley@example.com", "inviter accepts and addresses the welcome to the invited address");
const fin = await R.handle("welcome-accept", { text: acc.welcome, from: "sam@example.com" });
ok(fin.ok && fin.status === "verified-code", "recipient finishes: verified by code");

// 4. now connected, both ways
w = await S.handle("who", { addrs: ["riley@example.com"] });
ok(w.who["riley@example.com"].state === "pair-verified", "inviter sees the recipient as a verified pair");

// 5. seal and open
sealed = await S.handle("seal", { recipients: ["riley@example.com"], text: "the real message", subject: "the real subject" });
ok(sealed.ok && sealed.subject === HI.SUBJECT_LABEL, "subject field carries only the neutral label");
ok(!/hyphae|encrypt/i.test(sealed.body.split("hy1.")[0]), "cover text names neither product nor encryption");
ok(sealed.body.indexOf("the real") === -1, "no plaintext in what Gmail would store");
// R's side needs to bind S's address before an address resolves; open works by circle regardless
const opened = await R.handle("open", { text: sealed.body });
ok(opened.ok && opened.items.length === 1 && opened.items[0].body === "the real message", "recipient opens the body");
ok(opened.items[0].subject === "the real subject", "recipient gets the real subject from inside the envelope");

// 5b. the directory lists connected people for the recipient field; R's side binds the sender's address
const dirS = await S.handle("directory", { q: "ril" });
ok(dirS.ok && dirS.people.length === 1 && dirS.people[0].emails[0] === "riley@example.com" && dirS.people[0].status === "connected", "directory lists Riley as connected on Sam's side");
const merged = globalThis.HyInviteBridge.mergeSuggestions([{ name: "Other", emails: ["o@example.com"], status: "ready" }], dirS.people);
ok(merged.length === 2 && merged[1].status === "ready", "suggestions merge the connected person once");
ok(globalThis.HyInviteBridge.mergeSuggestions(merged, dirS.people).length === 2, "no duplicate on a second merge");

const whoR = await R.handle("who", { addrs: ["sam@example.com"] });
ok(whoR.who["sam@example.com"].state === "pair-verified", "Riley sees Sam as a verified pair by address once the code was confirmed");
// 6. nothing returned to a page carries a key
const all = JSON.stringify([w, sealed, opened, acc, fin, join, read]);
ok(!/"key"|"priv|"d":|"circle"/.test(all), "no key or circle in anything returned");

// 7. persistence: a fresh bridge on the same storage is the same identity and keeps the contact
const S2 = create({ HyInvite: HI, storage: sS, name: "ignored" });
w = await S2.handle("who", { addrs: ["riley@example.com"] });
ok(w.who["riley@example.com"].state === "pair-verified", "state survives a restart");

// 8. hostile input
ok((await S.handle("nope", {})).reason === "unknown-op", "unknown op refused");
ok((await S.handle("seal", { recipients: "x", text: 5 })).ok === false, "bad types refused");
ok((await S.handle("invite-create", { to: "not an address" })).reason === "bad-address", "bad address refused");

console.log(`\ninvite-bridge: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
