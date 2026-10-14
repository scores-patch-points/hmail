// A Drive file sealed to a connected person: the worker-side bridge seals and opens it, and
// no circle or key ever appears in what it hands back.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("../crypto.js"); require("../invite/p256.js"); require("../invite/spake2.js");
require("../invite/hyinvite.js"); require("../invite-bridge.js"); require("../drive/hash.js"); require("../drive/seal.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };
const store = () => { const m = new Map(); return { get: async k => m.get(k), set: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); } }; };
const mk = (name) => globalThis.HyInviteBridge.create({ HyInvite: globalThis.HyInvite, storage: store(), name, DriveSeal: globalThis.HyDriveSeal });
const S = mk("Sam"), R = mk("Riley"), X = mk("Stranger");
const b64 = (u) => Buffer.from(u).toString("base64");

const inv = await S.handle("invite-create", { to: "riley@example.com", mode: "code" });
const text = inv.body;
const join = await R.handle("invite-join", { text, code: inv.code, from: "sam@example.com" });
const acc = await S.handle("hello-accept", { text: join.hello });
const wel = await R.handle("welcome-accept", { text: acc.welcome, from: "sam@example.com" });
ok(join.ok && acc.ok && wel.ok, "connected both ways");
const dir = await S.handle("directory", {});
const fp = dir.people[0].fp;
ok(typeof fp === "string" && fp.length > 8, "directory carries the contact fingerprint");

const plain = new TextEncoder().encode("the plan is friday");
const sealed = await S.handle("seal-file", { fp, b64: b64(plain), meta: { name: "plan.txt", mime: "text/plain" }, allowUnverified: true });
ok(sealed.ok, "sealed to the person: " + JSON.stringify(sealed).slice(0, 80));
ok(!/"key"|"circle"/.test(JSON.stringify(sealed)), "no circle or key in the answer");
ok(Buffer.from(sealed.b64, "base64").subarray(0, 4).toString() === "HYD1", "it is a hyphae drive file");

const opened = await R.handle("open-file", { b64: sealed.b64 });
if (!opened.ok) console.log("open-file said:", JSON.stringify(opened));
ok(opened.ok && Buffer.from(opened.b64, "base64").toString() === "the plan is friday", "the connected person opens it");
ok(opened.meta.name === "plan.txt" && opened.fp, "name and who it was sealed with come back");
const stranger = await X.handle("open-file", { b64: sealed.b64 });
ok(!stranger.ok, "a stranger cannot open it: " + stranger.reason);
const nobody = await S.handle("seal-file", { fp: "nope", b64: b64(plain), meta: {} });
ok(!nobody.ok && nobody.reason === "not-connected", "unknown contact refused");

console.log("file-to-person:", pass, "passed,", fail, "failed");
process.exit(fail ? 1 : 0);
