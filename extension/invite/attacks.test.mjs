// Adversarial suite for the invite flow. Run:  node extension/invite/attacks.test.mjs
//
// Every row plays an adversary against the prototype (or, for a CONTROL, against a
// deliberately weaker design the harness must be able to break — if it cannot, the
// harness is blind and the suite fails). The result kinds:
//
//   defend   the attack must fail; if it succeeds the suite fails
//   limit    the attack succeeds by design; the row states what makes it detectable
//            and the test asserts that detection, so the limit is measured, not hand-waved
//   control  a weaker design; the attack must succeed or the harness proves nothing
//   check    a plain correctness / property check the attacks rely on
//
// Nothing here sends mail or touches a network: the mailbox, scanner, web and
// directory are in-process mocks (sim.mjs).
import { Mailbox, Person, Web, scan, gmailMangle, flip, pairByCode, I, H, C, S2, FAST, clock } from "./sim.mjs";

const wc = globalThis.crypto;
const te = new TextEncoder();
const { b64u, unb64u } = I;
const QUICK = process.env.QUICK === "1";
const TRIALS_RATE = Number(process.env.TRIALS || (QUICK ? 150 : 500));
const TRIALS_MITM = Number(process.env.MITM_TRIALS || (QUICK ? 60 : 200));

// ---- harness ------------------------------------------------------------------------------

const rows = [];
let failures = 0;
async function row(id, adv, title, kind, fn) {
  let r, err = null;
  const t0 = Date.now();
  try { r = await fn(); } catch (e) { err = e; r = {}; }
  const ms = Date.now() - t0;
  let status, bad = false;
  if (err) { status = "ERROR  " + (err.message || err); bad = true; }
  else if (kind === "defend") { bad = !!r.broken; status = r.broken ? "BROKEN ✗" : "DEFENDED"; }
  else if (kind === "control") { bad = !r.broken; status = r.broken ? "BROKEN as expected" : "HARNESS BLIND ✗"; }
  else if (kind === "limit") {
    status = r.broken ? "ACCEPTED LIMIT" : "DEFENDED";
    if (r.broken && r.expectDetected && !r.detected) { bad = true; status = "UNDETECTED ✗"; }
    if (r.broken) status += r.detected ? " (detected)" : " (not detectable)";
  } else if (kind === "check") { bad = !r.ok; status = r.ok ? "ok" : "FAILED ✗"; }
  if (bad) failures++;
  rows.push({ id, adv, title, kind, status, detail: r.detail || (err && err.stack) || "", ms });
  console.log(`${bad ? "✗" : "·"} ${id.padEnd(6)} ${kind.padEnd(7)} ${status.padEnd(34)} ${title}${r.detail ? "\n          " + r.detail : ""}${err ? "\n" + err.stack : ""}`);
}

async function world(params) {
  const mb = new Mailbox();
  const S = await Person.make("Sam", "sam@gmail.com", mb, params);
  const R = await Person.make("Rae", "rae@gmail.com", mb, params);
  return { mb, S, R };
}
const onlyContact = (p) => Object.values(p.agent.state.contacts)[0];

/** Did anyone end up verified to a key that is not the real counterpart's? */
async function wronglyPaired(S, R) {
  const sFp = await S.agent.fp(), rFp = await R.agent.fp();
  const atR = Object.values(R.agent.state.contacts).some((c) => c.status !== "unverified" && c.fp !== sFp);
  const atS = Object.values(S.agent.state.contacts).some((c) => c.status !== "unverified" && c.fp !== rFp);
  return atR || atS;
}
function tokenOf(body, kind) {
  const t = I.parseTokens(body).find((x) => x.kind === kind);
  return t ? { orig: "hy1" + kind + "." + t.fields.join(".") + "~", fields: t.fields } : null;
}
function mutate(body, kind, idx) {
  const t = tokenOf(body, kind);
  const f = t.fields.slice();
  if (f[idx] === "-") return null;
  f[idx] = flip(f[idx], Math.floor(f[idx].length / 2));
  return body.replace(t.orig, "hy1" + kind + "." + f.join(".") + "~");
}
function replaceField(body, kind, idx, value) {
  const t = tokenOf(body, kind), f = t.fields.slice();
  f[idx] = value;
  return body.replace(t.orig, "hy1" + kind + "." + f.join(".") + "~");
}
function setBody(mb, pred, fn) {
  const m = mb.msgs.slice().reverse().find(pred);
  m.body = fn(m.body);
  return m;
}
const lastMsg = (mb, to) => mb.msgs.slice().reverse().find((m) => m.to === to);

async function pubFields(text) {
  const out = [];
  for (const t of I.parseTokens(text)) for (const f of t.fields) { const b = unb64u(f); if (b && b.length) out.push(b); }
  return out;
}

/** The passive reader's best effort: every key it can derive from public material, tried on every token. */
async function passiveOpens(dump, extra) {
  const pubs = await pubFields(dump);
  for (const m of dump.matchAll(/hy1\.([A-Za-z0-9_-]{11})\./g)) void m;
  const cands = new Set();
  const add = (u8) => cands.add(b64u(u8));
  for (const p of pubs) {
    if (p.length === 32) add(p);
    add(await S2.sha256(p));
    add(await S2.hkdf(p, new Uint8Array(0), "hyphae/pair/circle/v1", 40).then((u) => u.slice(8)));
  }
  for (let i = 0; i < pubs.length; i++) for (let j = 0; j < pubs.length; j++) add(await S2.sha256(S2.concat(pubs[i], pubs[j])));
  for (const e of extra || []) add(e);
  const kids = [...new Set([...dump.matchAll(/hy1\.([A-Za-z0-9_-]{11})\./g)].map((m) => m[1]))];
  let opened = 0;
  for (const key of cands) {
    const circles = {};
    for (const kid of kids) circles[kid] = { kid, key };
    const r = await H.revealText(dump, circles);
    opened += r.opened;
  }
  return { opened, candidates: cands.size, kids: kids.length };
}

// ================================================================================================
console.log("\n== unit checks the attacks rely on ==");

await row("U1", "-", "P-256 BigInt arithmetic matches WebCrypto ECDH (5 random scalars, arbitrary points)", "check", async () => {
  let ok = 0;
  for (let t = 0; t < 5; t++) {
    const k = C.randomScalar(), p2 = C.mul(C.randomScalar(), C.G);
    const kp = await wc.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const jwk = await wc.subtle.exportKey("jwk", kp.privateKey);
    const q = C.mul(k, C.G);
    jwk.d = b64u(C.i2b(k, 32)); jwk.x = b64u(C.i2b(q.x, 32)); jwk.y = b64u(C.i2b(q.y, 32));
    const sk = await wc.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const raw = new Uint8Array(65); raw[0] = 4; raw.set(C.i2b(p2.x, 32), 1); raw.set(C.i2b(p2.y, 32), 33);
    const pk = await wc.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const bits = new Uint8Array(await wc.subtle.deriveBits({ name: "ECDH", public: pk }, sk, 256));
    const mine = C.mul(k, p2);
    if (Buffer.from(bits).equals(Buffer.from(C.i2b(mine.x, 32)))) ok++;
  }
  const a = C.add(C.mul(3n, C.G), C.mul(4n, C.G)), b = C.mul(7n, C.G);
  return { ok: ok === 5 && a.x === b.x && a.y === b.y && C.mul(C.N, C.G) === null, detail: `${ok}/5 scalar-mult matches, 3G+4G=7G, nG=∞` };
});

await row("U2", "-", "SPAKE2: same code → same K; wrong code → different K; M, N are on the curve and distinct", "check", async () => {
  const ctx = te.encode("ctx");
  const w = await S2.deriveW("ABCDEFGHJK", ctx, 10), w2 = await S2.deriveW("ABCDEFGHJM", ctx, 10);
  const a = await S2.start("A", w), b = await S2.start("B", w);
  const ka = await S2.finish("A", w, a.x, b.msg), kb = await S2.finish("B", w, b.x, a.msg);
  const b2 = await S2.start("B", w2), kbad = await S2.finish("B", w2, b2.x, a.msg), kabad = await S2.finish("A", w, a.x, b2.msg);
  const p = await S2.points();
  return {
    ok: Buffer.from(ka).equals(Buffer.from(kb)) && !Buffer.from(kabad).equals(Buffer.from(kbad)) &&
      C.isOnCurve(p.M) && C.isOnCurve(p.N) && (p.M.x !== p.N.x),
    detail: "K equal on match, unequal on mismatch",
  };
});

await row("U3", "-", "Code codec: single-character typos and transpositions of a code are refused before anything is sent", "check", async () => {
  let caught = 0, total = 0;
  for (let t = 0; t < 200; t++) {
    const c = I.newCode(5).norm;
    const i = Math.floor(Math.random() * c.length);
    const alt = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".replace(c[i], "")[Math.floor(Math.random() * 31)];
    total++;
    if (I.parseCode(c.slice(0, i) + alt + c.slice(i + 1)) === null) caught++;
  }
  const c = I.newCode(5);
  const sloppy = c.display.toLowerCase().replace(/0/g, "o").replace(/1/g, "l").replace(/-/g, " ");
  return { ok: caught >= 197 && I.parseCode(sloppy) === c.norm, detail: `${caught}/${total} single-character typos caught; read-aloud confusions O/0 I/L/1 accepted` };
});

await row("U4", "-", "Degenerate SPAKE2 points are refused (off-curve, x≥p, identity length, 65-byte form, exactly the mask)", "check", async () => {
  const w = await S2.deriveW("ABCDEFGHJK", te.encode("c"), 10), st = await S2.start("A", w), p = await S2.points();
  const bad = [];
  bad.push(new Uint8Array(33));                                              // not a point
  for (let x = 1n; ; x++) {                                                  // an x with no point above it
    const b = new Uint8Array(33); b[0] = 2; b.set(C.i2b(x, 32), 1);
    if (!C.decode(b)) { bad.push(b); break; }
  }
  const big = new Uint8Array(33); big[0] = 2; big.fill(255, 1); bad.push(big); // x ≥ p
  bad.push(new Uint8Array([0]));                                               // SEC1 identity
  const full = new Uint8Array(65); full[0] = 4; bad.push(full);
  let refused = 0;
  for (const b of bad) if ((await S2.finish("A", w, st.x, b)) === null) refused++;
  const exactlyMask = C.encode(C.mul(w, p.N));                                 // Y = w·N  → Y − wN = ∞
  const k = await S2.finish("A", w, st.x, exactlyMask);
  return { ok: refused === bad.length && k === null, detail: `${refused}/${bad.length} malformed + the identity-forcing value refused` };
});

await row("U5", "-", "Passive-reader harness is not vacuous: given the real circle key it does open the tokens", "check", async () => {
  const { mb, S, R } = await world();
  await pairByCode(S, R);
  const sFp = Object.keys(S.agent.state.contacts)[0];
  const t = await S.agent.sealTo(sFp, "positive control");
  const real = S.agent.state.contacts[sFp].circle;
  const r = await H.revealText(I.sealedBody([t]), { [real.kid]: real });
  return { ok: r.opened === 1, detail: "opened with the real key" };
});

// ================================================================================================
console.log("\n== A1  Google / anyone with the whole mailbox ==");

await row("A1.1", "A1", "passive reader, whole mailbox after a code pairing + 5 mails + a file: secret scan and key search", "defend", async () => {
  const { mb, S, R } = await world();
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  const codeNorm = I.normalize(inv.code);
  S.send(R.address, inv.email.subject, inv.email.body);
  const parsed = (await R.pump()).find((g) => g.kind === "inv").r;
  const j = await R.agent.join(parsed.invite, { code: inv.code });
  R.send(S.address, "re", j.hello);
  await S.pump(); await R.pump();
  const rFp = Object.keys(S.agent.state.contacts)[0];
  for (let i = 0; i < 5; i++) S.send(R.address, I.SUBJECT_LABEL, I.sealedBody([await S.agent.sealTo(rFp, "secret number " + i)]));
  S.send(R.address, I.SUBJECT_LABEL, I.sealedBody([await S.agent.sealFile(rFp, { name: "plan.pdf", mime: "application/pdf", bytes: wc.getRandomValues(new Uint8Array(4000)) })]));
  const dump = mb.dump();
  const invState = S.agent.state.invites[inv.iid];
  const secrets = [
    inv.code, codeNorm, S.agent.state.contacts[rFp].circle.key, R.agent.state.contacts[Object.keys(R.agent.state.contacts)[0]].circle.key,
    S.agent.identity.dh.d, S.agent.identity.sign.d, R.agent.identity.dh.d, R.agent.identity.sign.d,
    invState.x, invState.w, b64u(C.i2b(BigInt("0x" + invState.x), 32)), b64u(C.i2b(BigInt("0x" + invState.w), 32)),
  ];
  const leaked = I.auditPublicText(dump, secrets);
  const r = await passiveOpens(dump);
  return { broken: leaked.length > 0 || r.opened > 0, detail: `${secrets.length} secrets scanned for, ${leaked.length} found; ${r.candidates} derived keys × ${r.kids} circles tried, ${r.opened} tokens opened` };
});

await row("A1.2", "A1", "passive reader who LATER learns the code (recorded call, shoulder-surf): can it read the recorded mail?", "defend", async () => {
  const { mb, S, R } = await world();
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  S.send(R.address, inv.email.subject, inv.email.body);
  const parsed = (await R.pump()).find((g) => g.kind === "inv").r;
  R.send(S.address, "re", (await R.agent.join(parsed.invite, { code: inv.code })).hello);
  await S.pump(); await R.pump();
  const rFp = Object.keys(S.agent.state.contacts)[0];
  S.send(R.address, I.SUBJECT_LABEL, I.sealedBody([await S.agent.sealTo(rFp, "recorded before the code leaked")]));
  // the attacker now has: the mailbox AND the code. Public ctx = iid + inviter's bundle.
  const invTok = tokenOf(mb.msgs[0].body, "inv"), helloTok = tokenOf(mb.msgs[1].body, "hello");
  const bundleS = unb64u(invTok.fields[2]), X = unb64u(invTok.fields[3]), bundleR = unb64u(helloTok.fields[1]), Y = unb64u(helloTok.fields[2]);
  const w = await S2.deriveW(I.normalize(inv.code), I.lp(["hyphae/invite/ctx/v1", b64u(unb64u(invTok.fields[1])), bundleS]), FAST.kdfIters);
  const p = await S2.points();
  const xG = C.add(C.decode(X), C.neg(C.mul(w, p.M))), yG = C.add(C.decode(Y), C.neg(C.mul(w, p.N)));
  const cands = [xG, yG, C.add(xG, yG), C.decode(X), C.decode(Y)];
  const extra = [];
  for (const K of cands) {
    const tt = I.lp(["hyphae/invite/tt/v1", b64u(unb64u(invTok.fields[1])), bundleS, bundleR, X, Y, C.encode(K), C.i2b(w, 32)]);
    const sch = await S2.schedule(tt);
    extra.push(b64u(sch.ke), b64u((await S2.hkdf(sch.ke, new Uint8Array(0), "hyphae/pair/circle/v1", 40)).slice(8)));
    for (const ikm of [C.i2b(K.x, 32)]) extra.push(b64u((await S2.hkdf(ikm, new Uint8Array(0), "hyphae/pair/circle/v1", 40)).slice(8)));
  }
  const r = await passiveOpens(mb.dump(), extra);
  return { broken: r.opened > 0, detail: `code + X + Y known; unmasked x·G, y·G computed; ${r.candidates} candidate keys, ${r.opened} opened (K = xyG needs a private scalar; so does the identity DH)` };
});

await row("A1.3", "A1", "passive reader of a no-code (sas) pairing: whole mailbox, every derivable key", "defend", async () => {
  const { mb, S, R } = await world();
  const inv = await S.agent.createInvite({ to: R.address, mode: "sas" });
  S.send(R.address, inv.email.subject, inv.email.body);
  const parsed = (await R.pump()).find((g) => g.kind === "inv").r;
  R.send(S.address, "re", (await R.agent.join(parsed.invite, {})).hello);
  await S.pump();
  const rFp = Object.keys(S.agent.state.contacts)[0];
  S.send(R.address, I.SUBJECT_LABEL, I.sealedBody([await S.agent.sealTo(rFp, "unverified but not readable", { allowUnverified: true })]));
  const r = await passiveOpens(mb.dump());
  return { broken: r.opened > 0, detail: `${r.candidates} candidate keys, ${r.opened} opened` };
});

await row("A1.4", "A1", "the invite email alone is not a capability: forge a hello S accepts from it (best attempts, 40-bit code)", "defend", async () => {
  const { mb, S, R } = await world();
  const M = await Person.make("Mallory", "m@evil.example", mb, { ...FAST, maxFailures: 1e9 });
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  S.send(R.address, inv.email.subject, inv.email.body);
  const email = lastMsg(mb, R.address);
  const parsed = await M.agent.readInvite(email.body, { from: S.address });
  // first the hello with no proof at all (no point, no tag): must not be accepted and must not cost a try
  const bare = replaceField(replaceField((await M.agent.join(parsed.invite, { code: I.newCode(5).display })).hello, "hello", 2, "-"), "hello", 4, "-");
  const r0 = await S.agent.acceptHello(bare);
  const costFree = S.agent.state.invites[inv.iid].failures === 0;
  let accepted = 0, tried = 0;
  for (let i = 0; i < 6; i++) {
    const j = await M.agent.join(parsed.invite, { code: I.newCode(5).display });
    tried++;
    const r = await S.agent.acceptHello(j.hello);
    if (r.ok) accepted++;
  }
  return { broken: accepted > 0 || r0.ok, detail: `proofless hello → ${r0.reason} (free of charge: ${costFree}); then ${tried} guesses → ${accepted} accepted; invite state afterwards: ${S.agent.state.invites[inv.iid].state}` };
});

// ================================================================================================
console.log("\n== A2  active network attacker / malicious relay or homeserver ==");

await row("A2.1", "A2", "flip a character in every field of the invite, in turn; real code typed; any wrong pairing?", "defend", async () => {
  const hist = {};
  let breach = false;
  for (let idx = 0; idx < 6; idx++) {
    const { mb, S, R } = await world();
    const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
    const body = mutate(inv.email.body, "inv", idx);
    if (!body) continue;
    S.send(R.address, inv.email.subject, body);
    const got = (await R.pump()).find((g) => g.kind === "inv").r;
    if (!got.ok) { hist["rejected:" + got.reason] = (hist["rejected:" + got.reason] || 0) + 1; continue; }
    const j = await R.agent.join(got.invite, { code: inv.code });
    if (!j.ok) { hist["join:" + j.reason] = (hist["join:" + j.reason] || 0) + 1; continue; }
    R.send(S.address, "re", j.hello);
    const atS = (await S.pump())[0].r;
    await R.pump();
    hist["field" + idx + ":" + (atS.ok ? "paired" : atS.reason)] = 1;
    if (await wronglyPaired(S, R)) breach = true;
  }
  return { broken: breach, detail: JSON.stringify(hist) };
});

await row("A2.2", "A2", "flip a character in every field of the hello, and of the welcome, in turn", "defend", async () => {
  const hist = {};
  let breach = false;
  for (const stage of ["hello", "welcome"]) {
    const nf = stage === "hello" ? 6 : 3;
    for (let idx = 0; idx < nf; idx++) {
      const { mb, S, R } = await world();
      const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
      S.send(R.address, inv.email.subject, inv.email.body);
      const parsed = (await R.pump()).find((g) => g.kind === "inv").r;
      let hello = (await R.agent.join(parsed.invite, { code: inv.code })).hello;
      if (stage === "hello") { hello = mutate(hello, "hello", idx); if (!hello) continue; }
      R.send(S.address, "re", hello);
      const atS = await S.pump();
      if (stage === "welcome") {
        const w = lastMsg(mb, R.address);
        if (!tokenOf(w.body, "welcome")) continue;
        const m = mutate(w.body, "welcome", idx); if (!m) continue;
        w.body = m;
      }
      const atR = await R.pump();
      const outS = atS.length ? (atS[0].r.ok ? "paired" : atS[0].r.reason) : "nothing";
      const outR = atR.length ? (atR[0].r.ok ? "paired" : atR[0].r.reason) : "nothing";
      hist[`${stage}${idx}`] = `S:${outS} R:${outR}`;
      if (await wronglyPaired(S, R)) breach = true;
    }
  }
  return { broken: breach, detail: JSON.stringify(hist) };
});

await row("A2.3", "A2", "relay drops, delays past expiry, duplicates and reorders messages", "defend", async () => {
  let breach = false;
  const notes = [];
  // drop the welcome: no breach, S has R, R has not S yet
  { const { mb, S, R } = await world();
    const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
    S.send(R.address, inv.email.subject, inv.email.body);
    const p = (await R.pump()).find((g) => g.kind === "inv").r;
    R.send(S.address, "re", (await R.agent.join(p.invite, { code: inv.code })).hello);
    await S.pump();
    mb.msgs = mb.msgs.filter((m) => !tokenOf(m.body, "welcome"));
    await R.pump();
    notes.push("welcome dropped: R verified=" + Object.values(R.agent.state.contacts).length);
    if (await wronglyPaired(S, R)) breach = true; }
  // delay the hello past expiry
  { const { mb, S, R } = await world();
    const inv = await S.agent.createInvite({ to: R.address, mode: "code", ttlMs: 1000 });
    S.send(R.address, inv.email.subject, inv.email.body);
    const p = (await R.pump()).find((g) => g.kind === "inv").r;
    const hello = (await R.agent.join(p.invite, { code: inv.code })).hello;
    clock.t += 5000;
    R.send(S.address, "re", hello);
    const r = (await S.pump())[0].r;
    notes.push("late hello: " + r.reason);
    if (r.ok) breach = true;
    clock.t -= 5000; }
  // duplicate the hello twice, deliver welcome twice
  { const { mb, S, R } = await world();
    const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
    S.send(R.address, inv.email.subject, inv.email.body);
    const p = (await R.pump()).find((g) => g.kind === "inv").r;
    const hello = (await R.agent.join(p.invite, { code: inv.code })).hello;
    R.send(S.address, "re", hello); R.send(S.address, "re", hello);
    const rs = await S.pump();
    await R.pump();
    notes.push("duplicate hello: " + rs.map((x) => (x.r.ok ? (x.r.duplicate ? "dup-ok" : "paired") : x.r.reason)).join(","));
    if (Object.keys(S.agent.state.contacts).length !== 1 || S.agent.state.alarms.length) breach = true;
    if (await wronglyPaired(S, R)) breach = true; }
  return { broken: breach, detail: notes.join(" | ") };
});

await row("A2.4", "A2", "reflection: S's own invite point fed back as the joiner's message; S's hello replayed as a welcome", "defend", async () => {
  const { mb, S, R } = await world();
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  const invTok = tokenOf(inv.token, "inv");
  const sBundle = unb64u(invTok.fields[2]), X = invTok.fields[3];
  // a hello that carries S's own bundle as "R" and S's own X as "Y"
  const sigS = await S.agent._sign(new Uint8Array(8));
  const fake = I.parseTokens(inv.token).length ? `hy1hello.${invTok.fields[1]}.${invTok.fields[2]}.${X}.${b64u(sigS)}.${b64u(new Uint8Array(32))}.-~` : "";
  const r = await S.agent.acceptHello(fake);
  return { broken: !!r.ok || Object.keys(S.agent.state.contacts).length > 0, detail: `reflected hello → ${r.reason}; contacts=${Object.keys(S.agent.state.contacts).length}` };
});

await row("A2.5", "A2", "full active MITM in code mode (bundles swapped both ways, X/Y relayed or re-made), 40-bit code, 25 sessions", "defend", async () => {
  let wins = 0, n = 25;
  for (let t = 0; t < n; t++) {
    const { mb, S, R } = await world();
    const Mal = await Person.make("Mallory", "m@evil.example", mb, { ...FAST, maxFailures: 1e9 });
    const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
    S.send(R.address, inv.email.subject, inv.email.body);
    const realInvBody = lastMsg(mb, R.address).body;
    const parsedReal = await Mal.agent.readInvite(realInvBody, { from: S.address });
    // she replaces the invite R sees with her own (own key, own X from a code she picked)
    const mine = await Mal.agent.createInvite({ to: R.address, mode: "code" });
    lastMsg(mb, R.address).body = mine.email.body;
    const gotR = (await R.pump()).find((g) => g.kind === "inv").r;
    const j = await R.agent.join(gotR.invite, { code: inv.code });          // R types the REAL code
    // she forwards S a hello of her own, guessing the code
    const toS = await Mal.agent.join(parsedReal.invite, { code: I.newCode(5).display });
    const rS = await S.agent.acceptHello(toS.hello);
    // and tries to welcome R: R's hello was made under the real code, hers needs the same w
    const asInviter = await Mal.agent.acceptHello(j.hello);
    if (asInviter.ok && asInviter.welcome) await R.agent.acceptWelcome(asInviter.welcome);
    if (rS.ok || (await wronglyPaired(S, R))) wins++;
  }
  return { broken: wins > 0, detail: `${n} sessions, ${wins} pairings with the attacker` };
});

await row("A2.6", "A2", "relay rewrites every URL in the mail to a wrapper (safe-links style) and re-wraps/quotes tokens", "defend", async () => {
  const { mb, S, R } = await world();
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  const body = gmailMangle(inv.email.body.replace(/https?:\/\/[^\s]+/g, (u) => "https://safelinks.example/?u=" + encodeURIComponent(u)), { wrap: 61, quote: true });
  S.send(R.address, inv.email.subject, body);
  const p = (await R.pump()).find((g) => g.kind === "inv").r;
  const j = p.ok ? await R.agent.join(p.invite, { code: inv.code }) : { ok: false };
  R.send(S.address, "re", gmailMangle(j.hello, { wrap: 50, quote: true }));
  const atS = (await S.pump())[0].r;
  R.send(S.address, "x", ""); // keep pump honest
  const atR = await R.pump();
  const paired = atS.ok && atR.some((a) => a.r.ok);
  return { broken: !paired, detail: "invite and hello survive hard-wrap + '> ' quoting: " + (paired ? "paired" : "NOT paired") };
});

await row("A2.7", "A2", `fuzz: ${QUICK ? 400 : 1500} mutated/garbled messages into every parser (hello, welcome, invite, open, guard) — exceptions or wrong pairings?`, "defend", async () => {
  const N = QUICK ? 400 : 1500;
  const mb = new Mailbox();
  const S = await Person.make("Sam", "sam@gmail.com", mb, { ...FAST, maxFailures: 1e9 });
  const R = await Person.make("Rae", "rae@gmail.com", mb, FAST);
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  const p = await R.agent.readInvite(inv.token, { from: S.address });
  const hello = (await R.agent.join(p.invite, { code: inv.code })).hello;
  // a real welcome, obtained from a throw-away clone of S so the original stays un-paired
  const clone = new I.Agent({ identity: S.agent.identity, state: JSON.parse(JSON.stringify(S.agent.state)), params: { ...FAST, maxFailures: 1e9 } });
  const welcome = (await clone.acceptHello(hello)).welcome;
  // and a real sealed message in a pair circle, from the same clone
  const rFp = Object.keys(clone.state.contacts)[0];
  const sealed = I.sealedBody([await clone.sealTo(rFp, "fuzz me")]);
  const corpus = [inv.token, hello, welcome, sealed, inv.email.body];
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~ \n>";
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  function mutateStr(str) {
    const k = Math.floor(Math.random() * 6);
    const i = Math.floor(Math.random() * str.length);
    if (k === 0) return str.slice(0, i) + pick(ALPHA) + str.slice(i + 1);
    if (k === 1) return str.slice(0, i);
    if (k === 2) return str.slice(0, i) + str.slice(i + 1 + Math.floor(Math.random() * 30));
    if (k === 3) return str + pick(corpus);
    if (k === 4) return str.slice(0, i) + pick(corpus) + str.slice(i);
    return str.replace(/\./g, () => (Math.random() < 0.1 ? ".." : ".")).replace(/~/g, Math.random() < 0.5 ? "" : "~~");
  }
  const sFp = await S.agent.fp(), rFp0 = await R.agent.fp();
  let thrown = 0, wrong = 0, ran = 0;
  const errs = new Set();
  for (let i = 0; i < N; i++) {
    let m = pick(corpus);
    for (let r = 0; r < 1 + Math.floor(Math.random() * 3); r++) m = mutateStr(m);
    for (const f of [
      () => S.agent.acceptHello(m), () => R.agent.acceptWelcome(m), () => R.agent.readInvite(m, { from: "x@y.z" }),
      () => R.agent.open(m), () => S.agent.guardSend({ recipients: ["rae@gmail.com", "q@r.s"], subject: m.slice(0, 20), body: m }),
    ]) {
      ran++;
      try { await f(); } catch (e) { thrown++; errs.add(String(e.message).slice(0, 60)); }
    }
    if (Object.values(S.agent.state.contacts).some((c) => c.fp !== rFp0) || Object.values(R.agent.state.contacts).some((c) => c.fp !== sFp)) wrong++;
  }
  return { broken: thrown > 0 || wrong > 0, detail: `${ran} parser calls on ${N} inputs: ${thrown} exceptions${thrown ? " " + [...errs].join("; ") : ""}, ${wrong} wrong pairings` };
});

// ================================================================================================
console.log("\n== A3  link scanners and prefetchers ==");

await row("A3.1", "A3", "scanner GETs every URL in every mail, twice, before the human opens anything; then pairing", "defend", async () => {
  const { mb, S, R } = await world();
  const web = new Web();
  const state = { sideEffects: 0 };
  web.on("https://hyphae.social/", () => { state.sideEffects++; return { status: 200 }; });
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  S.send(R.address, inv.email.subject, inv.email.body);
  const urls = scan(lastMsg(mb, R.address), web);
  const before = JSON.stringify(S.agent.state.invites[inv.iid]);
  scan(lastMsg(mb, R.address), web);
  const after = JSON.stringify(S.agent.state.invites[inv.iid]);
  const perInvite = urls.filter((u) => u.includes(inv.iid) || /[?#&]t=|token|key=/i.test(u));
  const p = (await R.pump()).find((g) => g.kind === "inv").r;
  const j = await R.agent.join(p.invite, { code: inv.code });
  R.send(S.address, "re", j.hello);
  const atS = (await S.pump())[0].r;
  const welcomeMsg = lastMsg(mb, R.address);
  scan(welcomeMsg, web);
  const atR = (await R.pump())[0].r;
  return {
    broken: before !== after || perInvite.length > 0 || !atS.ok || !atR.ok,
    detail: `${urls.length} URL (${urls[0]}), ${web.hits.length} GETs, invite state unchanged=${before === after}, per-invite URLs=${perInvite.length}, paired after scan=${atS.ok && atR.ok}`,
  };
});

await row("A3.2", "A3", "CONTROL: a magic-link design (single-use https://…/join?t=…) meets the same scanner", "control", async () => {
  const web = new Web();
  const link = "https://hyphae.example/join?t=" + b64u(wc.getRandomValues(new Uint8Array(16)));
  let used = false;
  web.on("https://hyphae.example/join", () => { if (used) return { status: 410 }; used = true; return { status: 200, body: "joined" }; });
  scan({ subject: "invite", body: "click " + link }, web);   // the scanner runs first
  const human = web.get(link);                                // the human's click
  return { broken: human.status === 410, detail: "human click after the scanner: HTTP " + human.status };
});

await row("A3.3", "A3", "CONTROL: key placed in the link fragment (…#k=…) — what a mailbox reader sees", "control", async () => {
  const circle = H.newCircle("c");
  const email = "https://hyphae.example/open#k=" + circle.key;
  const stolen = (email.match(/#k=([A-Za-z0-9_-]{43})/) || [])[1];
  const t = await H.seal(circle, "secret");
  const r = await H.revealText(t, { [circle.kid]: { kid: circle.kid, key: stolen } });
  return { broken: r.opened === 1, detail: "mailbox reader opens the token with the key lifted from the email" };
});

// ================================================================================================
console.log("\n== A4  phisher spoofing S's invite ==");

await row("A4.1", "A4", "spoofed invite from sam@gmail.com carrying the attacker's key and 'Sam' as its name", "defend", async () => {
  const mb = new Mailbox();
  const R = await Person.make("Rae", "rae@gmail.com", mb, FAST);
  const Mal = await Person.make("Sam", "mallory@evil.example", mb, FAST);       // calls itself "Sam"
  const inv = await Mal.agent.createInvite({ to: R.address, mode: "code" });
  mb.deliver({ from: "sam@gmail.com", to: R.address, subject: inv.email.subject, body: inv.email.body });  // spoofed From
  const p = (await R.pump()).find((g) => g.kind === "inv").r;
  const noCode = await R.agent.join(p.invite, {});
  const named = Object.values(R.agent.state.contacts);
  return {
    broken: !!noCode.ok || named.length > 0,
    detail: `invite parsed; claimsToBe='${p.invite.claimsToBe}' shown as a claim only; join without a code → ${noCode.reason}; contacts created=${named.length}`,
  };
});

await row("A4.2", "A4", "phisher asks R to read out / forward everything hyphae shows during setup; tries it against the real S", "defend", async () => {
  const { mb, S, R } = await world();
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  S.send(R.address, inv.email.subject, inv.email.body);
  const p = (await R.pump()).find((g) => g.kind === "inv").r;
  const j = await R.agent.join(p.invite, { code: inv.code });
  // what R's screen and outbox ever show: the hello token, R's pending record, R's contact list
  const shown = JSON.stringify([j, R.agent.state.pending, R.agent.state.contacts]);
  const secrets = [R.agent.identity.dh.d, R.agent.identity.sign.d, inv.code, I.normalize(inv.code)];
  const leaked = I.auditPublicText(shown.replace(/"ke":"[^"]*"|"tagA":"[^"]*"|"h":"[^"]*"/g, ""), secrets);
  // the phisher takes R's hello and tries it on a different, real invite of S's
  const inv2 = await S.agent.createInvite({ to: "other@gmail.com", mode: "code" });
  const stolen = await S.agent.acceptHello(replaceField(j.hello, "hello", 0, inv2.iid));
  return { broken: leaked.length > 0 || stolen.ok, detail: `identity keys / code in anything R's UI shows: ${leaked.length}; R's hello moved to another invite → ${stolen.reason}` };
});

await row("A4.3", "A4", "phisher spoofs the invite AND phones R with a code (voice impersonation); R pairs with the phisher", "limit", async () => {
  const { mb, S, R } = await world();
  const Mal = await Person.make("Sam", "mallory@evil.example", mb, FAST);
  const inv = await Mal.agent.createInvite({ to: R.address, mode: "code" });
  mb.deliver({ from: "sam@gmail.com", to: R.address, subject: inv.email.subject, body: inv.email.body });
  const p = (await R.pump()).find((g) => g.kind === "inv").r;
  const j = await R.agent.join(p.invite, { code: inv.code });                     // code "from Sam's voice"
  R.send(Mal.address, "re", j.hello);
  await Mal.pump(); await R.pump();
  const rc = onlyContact(R);
  const sFp = await S.agent.fp();
  const broken = rc && rc.status === "verified-code" && rc.fp !== sFp;
  // what makes it detectable: R's contact is not S's key, and S has no contact for R at all
  const detected = broken && Object.keys(S.agent.state.contacts).length === 0 && rc.label === "";
  return { broken, detected, expectDetected: true, detail: `R holds a verified-code contact whose key is NOT Sam's; Sam's own app lists no contact for R, and the contact has no name the phisher chose (label='${rc && rc.label}', claims='${rc && rc.claims}')` };
});

await row("A4.4", "A4", "attacker answers a no-code invite with its own key before R does; S then tries to send", "defend", async () => {
  const { mb, S, R } = await world();
  const Mal = await Person.make("Rae", "mallory@evil.example", mb, FAST);
  const inv = await S.agent.createInvite({ to: R.address, mode: "sas" });
  S.send(R.address, inv.email.subject, inv.email.body);
  const parsed = await Mal.agent.readInvite(lastMsg(mb, R.address).body, { from: S.address });
  const j = await Mal.agent.join(parsed.invite, {});
  mb.deliver({ from: R.address, to: S.address, subject: "re", body: j.hello });
  await S.pump();
  const c = onlyContact(S);
  let sent = false;
  try { await S.agent.sealTo(c.fp, "the merger closes friday"); sent = true; } catch (e) { /* refused */ }
  const g = S.agent.guardSend({ recipients: [R.address], subject: I.SUBJECT_LABEL, body: I.sealedBody([await S.agent.sealTo(c.fp, "x", { allowUnverified: true })]) });
  return { broken: sent, detail: `contact status=${c.status}; sealTo without an explicit allowUnverified: ${sent ? "SENT" : "refused"}; guard warns: ${g.warns.map((w) => w.code).join(",")}` };
});

// ================================================================================================
console.log("\n== A5  forgery inside a shared-key circle ==");

await row("A5.1", "A5", "CONTROL: today's hy1 circle (3 members, shared key): a member writes as another", "control", async () => {
  const circle = H.newCircle("team");
  const fromBea = await H.seal(circle, "I approve the invoice. — Bea");
  const forged = await H.seal(circle, "I approve the invoice. — Bea");       // Mallory, same key, same words
  const a = await H.revealText(fromBea, { [circle.kid]: circle }), b = await H.revealText(forged, { [circle.kid]: circle });
  return { broken: a.opened === 1 && b.opened === 1 && a.text === b.text, detail: "the format has no author: forged and genuine tokens are indistinguishable to every reader" };
});

async function group3() {
  const mb = new Mailbox();
  const A = await Person.make("Ann", "ann@gmail.com", mb, FAST), B = await Person.make("Bea", "bea@gmail.com", mb, FAST), M = await Person.make("Mal", "mal@gmail.com", mb, FAST);
  const circle = H.newCircle("team");
  const bundles = [await A.agent.bundle(), await B.agent.bundle(), await M.agent.bundle()];
  for (const p of [A, B, M]) p.agent.addGroup(circle, bundles);
  return { A, B, M, circle, bundles };
}
async function craft(agent, circle, envOverrides, signer) {
  const base = { v: 1, t: "msg", from: await agent.fp(), to: "*", kid: circle.kid, ts: Date.now(), id: b64u(wc.getRandomValues(new Uint8Array(12))), kind: "text", name: "", mime: "", body: "x" };
  const e = { ...base, ...envOverrides };
  const ordered = {};
  for (const k of ["v", "t", "from", "to", "kid", "ts", "id", "kind", "name", "mime", "body"]) ordered[k] = e[k];
  const sig = await (signer || agent)._sign(te.encode("hyphae/env/v1\0" + JSON.stringify(ordered)));
  return H.seal(circle, JSON.stringify({ e: ordered, s: b64u(sig) }));
}

await row("A5.2", "A5", "signed envelope: member M claims to be B (from=B, signed with M's key)", "defend", async () => {
  const { A, B, M, circle } = await group3();
  const bFp = await B.agent.fp();
  const t = await craft(M.agent, circle, { from: bFp, body: "I approve the invoice. — Bea" });
  const r = (await A.agent.open(t))[0];
  const genuine = (await A.agent.open(await B.agent.sealGroup(circle.kid, "real one")))[0];
  return { broken: r.authentic === true, detail: `forged: authentic=${r.authentic} (${r.reason}); genuine from Bea: authentic=${genuine.authentic}` };
});

await row("A5.3", "A5", "pairwise circle: R holds the circle key and forges a message 'from S'", "defend", async () => {
  const { mb, S, R } = await world();
  await pairByCode(S, R);
  const sFp = await S.agent.fp(), rFp = await R.agent.fp();
  const circle = onlyContact(R).circle;
  const t = await craft(R.agent, circle, { from: sFp, to: rFp, body: "wire it to account 12345" });
  const r = (await R.agent.open(t))[0];
  const t2 = await H.seal(circle, "wire it to account 12345");            // bare token, no envelope at all
  const r2 = (await R.agent.open(t2))[0];
  return { broken: r.authentic === true || r2.authentic === true, detail: `forged envelope: ${r.reason}; bare token: ${r2.reason}` };
});

await row("A5.4", "A5", "splice: a genuine signed envelope from circle 1 re-sealed into circle 2 (attacker holds both keys)", "defend", async () => {
  const { A, B, M, circle } = await group3();
  const c2 = H.newCircle("other");
  for (const p of [A, B, M]) p.agent.addGroup(c2, [await A.agent.bundle(), await B.agent.bundle(), await M.agent.bundle()]);
  const genuine = await B.agent.sealGroup(circle.kid, "meet at 6");
  const inner = JSON.parse((await H.revealSegments(genuine, { [circle.kid]: circle }))[0].plain);
  const moved = await H.seal(c2, JSON.stringify(inner));
  const r = (await A.agent.open(moved))[0];
  return { broken: r.authentic === true, detail: `spliced into another circle: authentic=${r.authentic} (${r.reason})` };
});

await row("A5.5", "A5", "tamper with ciphertext / swap kid / truncate token", "defend", async () => {
  const { A, B, circle } = await group3();
  const t = await B.agent.sealGroup(circle.kid, "meet at 6");
  const bad1 = t.replace(/~$/, "").slice(0, -4) + "AAAA~";
  const parts = t.replace(/~$/, "").split(".");
  const bad2 = [parts[0], H.newCircle("z").kid, parts[2], parts[3]].join(".") + "~";
  const bad3 = t.slice(0, t.length - 12) + "~";
  let opened = 0;
  for (const b of [bad1, bad2, bad3]) for (const r of await A.agent.open(b)) if (r.ok && r.authentic) opened++;
  return { broken: opened > 0, detail: "3 mutated tokens, 0 accepted" };
});

await row("A5.6", "A5", "replay: a genuine old signed message re-sent in a new mail as if it were new", "limit", async () => {
  const { mb, S, R } = await world();
  await pairByCode(S, R);
  const rFp = Object.keys(S.agent.state.contacts)[0];
  const old = await S.agent.sealTo(rFp, "the safe code is 4411");
  const first = (await R.agent.open(old))[0];
  clock.t += 3 * 24 * 3600 * 1000;
  const again = (await R.agent.open("fresh looking mail:\n" + old))[0];
  clock.t -= 3 * 24 * 3600 * 1000;
  const broken = again.authentic === true;                      // the crypto layer accepts it: it IS genuine
  const detected = broken && again.seenBefore === true && again.ts === first.ts && again.id === first.id;
  return { broken, detected, expectDetected: true, detail: `accepted as authentic, but seenBefore=${again.seenBefore} and the signed timestamp/id are the original's (UI must show the signed time, not the mail's)` };
});

// ================================================================================================
console.log("\n== A6  later takeover of R's or S's mailbox ==");

await row("A6.1", "A6", "attacker gets R's whole mailbox AFTER pairing: read history, then write to S as R", "defend", async () => {
  const { mb, S, R } = await world();
  await pairByCode(S, R);
  const rFp = Object.keys(S.agent.state.contacts)[0];
  for (let i = 0; i < 3; i++) S.send(R.address, I.SUBJECT_LABEL, I.sealedBody([await S.agent.sealTo(rFp, "history " + i)]));
  const mailboxOfR = mb.msgs.filter((m) => m.to === R.address || m.from === R.address).map((m) => m.body).join("\n");
  const Mal = await Person.make("Mallory", "m@evil.example", mb, FAST);
  const read = await passiveOpens(mailboxOfR);
  // writes as R: plaintext, an invite of its own, a bare token under a wrong key
  const forgedPlain = (await S.agent.open("It's Rae, new phone, send me the file again")).length;
  const inv = await Mal.agent.createInvite({ to: S.address, mode: "sas", });
  const parsed = await S.agent.readInvite(inv.email.body, { from: R.address });
  const authentic = (await S.agent.open(await H.seal(H.newCircle("x"), "from Rae"))).filter((r) => r.ok).length;
  return {
    broken: read.opened > 0 || forgedPlain > 0 || authentic > 0 || !(parsed.keyChange && parsed.keyChange.length === 1),
    detail: `history tokens opened=${read.opened}; plaintext/bare tokens accepted as authentic=${forgedPlain + authentic}; a new invite from R's address is flagged keyChange=${JSON.stringify(!!parsed.keyChange)}`,
  };
});

await row("A6.2", "A6", "same attacker joins S in sas mode from R's address: does the new key displace R's verified contact?", "defend", async () => {
  const { mb, S, R } = await world();
  await pairByCode(S, R);
  const rFp = Object.keys(S.agent.state.contacts)[0];
  const Mal = await Person.make("Rae", "m@evil.example", mb, FAST);
  const inv = await S.agent.createInvite({ to: R.address, mode: "sas" });          // S re-invites R's address (e.g. 'new phone?')
  const parsed = await Mal.agent.readInvite(inv.email.body, { from: S.address });
  const j = await Mal.agent.join(parsed.invite, {});
  await S.agent.acceptHello(j.hello);
  const pick = S.agent.contactForAddress(R.address);
  let sentToMal = false;
  if (pick.contact && pick.contact.fp !== rFp) { try { await S.agent.sealTo(pick.contact.fp, "x"); sentToMal = true; } catch (e) { /* refused */ } }
  return { broken: sentToMal || (pick.contact && pick.contact.fp !== rFp), detail: `address now resolves to ${pick.contact ? (pick.contact.fp === rFp ? "the verified contact" : "SOMEONE ELSE") : "ambiguous"}; contacts=${Object.keys(S.agent.state.contacts).length}` };
});

await row("A6.3", "A6", "S's mailbox taken while an invite is in flight: attacker holds the invite and S's later mail", "defend", async () => {
  const { mb, S, R } = await world();
  const Mal = await Person.make("Mallory", "m@evil.example", mb, { ...FAST, maxFailures: 1e9 });
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  S.send(R.address, inv.email.subject, inv.email.body);
  const p = await Mal.agent.readInvite(lastMsg(mb, R.address).body, { from: S.address });
  const j = await Mal.agent.join(p.invite, { code: I.newCode(5).display });
  const r = await S.agent.acceptHello(j.hello);
  return { broken: !!r.ok, detail: `attacker's answer → ${r.reason}` };
});

// ================================================================================================
console.log("\n== A7  replay / forward of an invite ==");

await row("A7.1", "A7", "invite forwarded to a third party T who also has hyphae (no code): T's best attempts", "defend", async () => {
  const { mb, S, R } = await world();
  const T = await Person.make("Tom", "tom@gmail.com", mb, { ...FAST, maxFailures: 1e9 });
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  S.send(R.address, inv.email.subject, inv.email.body);
  const fwd = await T.agent.readInvite(lastMsg(mb, R.address).body, { from: R.address });
  const noCode = await T.agent.join(fwd.invite, {});
  const results = [];
  for (let i = 0; i < 5; i++) results.push((await S.agent.acceptHello((await T.agent.join(fwd.invite, { code: I.newCode(5).display })).hello)).reason);
  const tHasContact = Object.values(S.agent.state.contacts).some((c) => c.fp !== undefined);
  return { broken: !!noCode.ok || tHasContact, detail: `no-code join: ${noCode.reason}; 5 guesses → ${results.join(",")}; S contacts=${Object.keys(S.agent.state.contacts).length}` };
});

await row("A7.2", "A7", "after R paired: replay R's hello byte-for-byte; replay it with the attacker's bundle swapped in", "defend", async () => {
  const { mb, S, R } = await world();
  const { inv, j } = await pairByCode(S, R);
  const Mal = await Person.make("Mallory", "m@evil.example", mb, FAST);
  const rep = await S.agent.acceptHello(j.hello);
  const swapped = await S.agent.acceptHello(replaceField(j.hello, "hello", 1, b64u(await (async () => (await Mal.agent.bundle()).bytes)())));
  return { broken: Object.keys(S.agent.state.contacts).length !== 1 || swapped.ok || S.agent.state.alarms.length > 0, detail: `byte-identical replay → ${rep.duplicate ? "duplicate (welcome re-sent, nothing new)" : rep.reason}; key-swapped replay → ${swapped.reason}; contacts=${Object.keys(S.agent.state.contacts).length}, alarms=${S.agent.state.alarms.length}` };
});

await row("A7.3", "A7", "sas mode: invite forwarded; T answers too. Which one may S send to?", "defend", async () => {
  const { mb, S, R } = await world();
  const T = await Person.make("Tom", "tom@gmail.com", mb, FAST);
  const inv = await S.agent.createInvite({ to: R.address, mode: "sas" });
  S.send(R.address, inv.email.subject, inv.email.body);
  const body = lastMsg(mb, R.address).body;
  const pr = await R.agent.readInvite(body, { from: S.address }), pt = await T.agent.readInvite(body, { from: R.address });
  const jr = await R.agent.join(pr.invite, {}), jt = await T.agent.join(pt.invite, {});
  const a1 = await S.agent.acceptHello(jt.hello);                     // T first
  const a2 = await S.agent.acceptHello(jr.hello);
  const pick = S.agent.contactForAddress(R.address);
  let leaked = false;
  for (const c of Object.values(S.agent.state.contacts)) { try { await S.agent.sealTo(c.fp, "x"); leaked = true; } catch (e) { /* refused */ } }
  // S compares safety numbers with the real R by voice; only R's number matches
  const rFp = await R.agent.fp(), tFp = await T.agent.fp();
  const toRSays = await R.agent.safetyNumber(await S.agent.fp());
  const bad = await S.agent.confirmSafetyNumber(tFp, toRSays);
  const good = await S.agent.confirmSafetyNumber(rFp, toRSays);
  const after = S.agent.contactForAddress(R.address);
  let toT = false;
  try { await S.agent.sealTo(tFp, "x"); toT = true; } catch (e) { /* refused */ }
  return {
    broken: leaked || !pick.ambiguous || bad.ok || !good.ok || toT || !after.contact || after.contact.fp !== rFp,
    detail: `second responder alarm=${a2.alarm}; ambiguous=${!!pick.ambiguous}; sealTo w/o verification refused for both; voice check: T ${bad.ok ? "MATCHES" : "mismatch"}, R ${good.ok ? "match" : "NO MATCH"}; then address → ${after.contact && after.contact.fp === rFp ? "R" : "?"}`,
  };
});

await row("A7.4", "A7", "old invite replayed after it expired, and after it was used", "defend", async () => {
  const { mb, S, R } = await world();
  const inv = await S.agent.createInvite({ to: R.address, mode: "code", ttlMs: 60000 });
  const p = await R.agent.readInvite(inv.token, { from: S.address });
  clock.t += 120000;
  const j = await R.agent.join(p.invite, { code: inv.code });
  clock.t -= 120000;
  const w = await world();
  const inv2 = await w.S.agent.createInvite({ to: w.R.address, mode: "code" });
  const p2 = await w.R.agent.readInvite(inv2.token, { from: w.S.address });
  const h1 = (await w.R.agent.join(p2.invite, { code: inv2.code })).hello;
  const first = await w.S.agent.acceptHello(h1);
  const T = await Person.make("Tom", "tom@gmail.com", w.mb, FAST);
  const p3 = await T.agent.readInvite(inv2.token, { from: w.S.address });
  const tj = await T.agent.join(p3.invite, { code: I.newCode(5).display });
  const second = await w.S.agent.acceptHello(tj.hello);
  return { broken: j.ok || !first.ok || second.ok || !tj.ok, detail: `expired: ${j.reason}; used invite re-answered by a third party with a wrong code: ${second.reason}` };
});

// ================================================================================================
console.log("\n== A8  guessing the code ==");

await row("A8.1", "A8", "online: full invite, unlimited speed, 300 attempts at a 40-bit code", "defend", async () => {
  const { mb, S, R } = await world();
  const Mal = await Person.make("Mallory", "m@evil.example", mb, { ...FAST, maxFailures: 1e9 });
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  const p = await Mal.agent.readInvite(inv.token, { from: S.address });
  const hist = {};
  let won = false;
  for (let i = 0; i < 300; i++) {
    const j = await Mal.agent.join(p.invite, { code: I.newCode(5).display });
    const r = await S.agent.acceptHello(j.hello);
    hist[r.reason || "ok"] = (hist[r.reason || "ok"] || 0) + 1;
    if (r.ok) won = true;
  }
  // and then the genuine R is told no more tries: honest cost of the lock
  const real = await R.agent.join(p.invite, { code: inv.code });
  const rr = await S.agent.acceptHello(real.hello);
  return { broken: won, detail: `${JSON.stringify(hist)}; guesses actually evaluated = ${hist["bad-tag"]} → success probability ≤ ${hist["bad-tag"]}/2^40 ≈ ${(hist["bad-tag"] / 2 ** 40).toExponential(1)}; genuine R afterwards: ${rr.reason} (DoS, not a break)` };
});

await row("A8.2", "A8", `online rate, measured: 8-bit code, invite allows 3 tries, ${TRIALS_RATE} invites, best strategy (3 distinct guesses)`, "defend", async () => {
  const { mb, S } = await world({ codeBytes: 1 });
  const Mal = await Person.make("Mallory", "m@evil.example", mb, { ...FAST, codeBytes: 1, maxFailures: 1e9 });
  let wins = 0;
  const all = [...I.allCodes(1)];
  for (let t = 0; t < TRIALS_RATE; t++) {
    const inv = await S.agent.createInvite({ to: "x@gmail.com", mode: "code" });
    const p = await Mal.agent.readInvite(inv.token, { from: S.address });
    const picks = new Set();
    while (picks.size < 3) picks.add(all[Math.floor(Math.random() * all.length)]);
    for (const g of picks) {
      const j = await Mal.agent.join(p.invite, { code: g });
      if ((await S.agent.acceptHello(j.hello)).ok) { wins++; break; }
    }
  }
  // calibration: the same attacker script, handed the true code as one of its three guesses, must win every time
  let calib = 0;
  for (let t = 0; t < 5; t++) {
    const inv = await S.agent.createInvite({ to: "x@gmail.com", mode: "code" });
    const p = await Mal.agent.readInvite(inv.token, { from: S.address });
    const truth = S.agent.state.invites[inv.iid].code;
    for (const g of [I.newCode(1).norm, I.newCode(1).norm, truth]) {
      const j = await Mal.agent.join(p.invite, { code: g });
      if ((await S.agent.acceptHello(j.hello)).ok) { calib++; break; }
    }
  }
  const pExp = 3 / 256, exp = TRIALS_RATE * pExp, sd = Math.sqrt(TRIALS_RATE * pExp * (1 - pExp));
  const over = wins > exp + 4 * sd + 1;
  return { broken: over || calib !== 5, detail: `${wins} wins / ${TRIALS_RATE}; theory 3/256 = ${(100 * pExp).toFixed(2)}% → expected ${exp.toFixed(1)} ± ${sd.toFixed(1)}; measured ${(100 * wins / TRIALS_RATE).toFixed(2)}%. Calibration: attacker given the true code wins ${calib}/5 (so the script is a real attack)` };
});

/** One full active MITM session. `giveTruth` hands the attacker the real code (calibration only). */
async function mitmSession(params, giveTruth) {
  const { mb, S, R } = await world(params);
  const Mal = await Person.make("Mallory", "m@evil.example", mb, { ...FAST, ...params, maxFailures: 1e9 });
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  const parsedReal = await Mal.agent.readInvite(inv.token, { from: S.address });
  const guess = giveTruth ? inv.code : I.newCode(params.codeBytes || 5).display;
  // her invite to R must carry an X built from the SAME guess she will use toward S
  const fake = await Mal.agent.createInvite({ to: R.address, mode: "code" });
  const mi = Mal.agent.state.invites[fake.iid];
  const bundle = await Mal.agent.bundle();
  const w = await S2.deriveW(I.normalize(guess), I.lp(["hyphae/invite/ctx/v1", b64u(unb64u(fake.iid)), bundle.bytes]), FAST.kdfIters);
  const st = await S2.start("A", w);
  mi.x = st.x.toString(16); mi.w = w.toString(16); mi.code = I.normalize(guess);
  const mine = replaceField(fake.token, "inv", 3, b64u(st.msg));
  const gotR = await R.agent.readInvite(mine, { from: S.address });
  const jr = await R.agent.join(gotR.invite, { code: inv.code });          // R types the REAL code
  const toS = await Mal.agent.join(parsedReal.invite, { code: guess });
  const atS = await S.agent.acceptHello(toS.hello);
  const asInv = await Mal.agent.acceptHello(jr.hello);
  let atR = { ok: false };
  if (asInv.ok && asInv.welcome) atR = await R.agent.acceptWelcome(asInv.welcome);
  return !!(atS.ok && atR.ok);
}

await row("A8.3", "A8", `online + man-in-the-middle with R present, 8-bit code, ${TRIALS_MITM} sessions: one guess must satisfy BOTH ends`, "defend", async () => {
  let wins = 0, calib = 0;
  for (let t = 0; t < TRIALS_MITM; t++) if (await mitmSession({ codeBytes: 1 }, false)) wins++;
  for (let t = 0; t < 5; t++) if (await mitmSession({ codeBytes: 1 }, true)) calib++;
  const pExp = 1 / 256, exp = TRIALS_MITM * pExp, sd = Math.sqrt(TRIALS_MITM * pExp);
  return { broken: wins > exp + 4 * sd + 1 || calib !== 5, detail: `${wins}/${TRIALS_MITM} full MITMs; theory 1/256 → ${exp.toFixed(2)} expected. Calibration: MITM script given the true code succeeds ${calib}/5` };
});

await row("A8.4", "A8", "offline: whole transcript + every one of 256 possible codes — is there ANY verifier the attacker can compute?", "defend", async () => {
  const { mb, S, R } = await world({ codeBytes: 1 });
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  S.send(R.address, inv.email.subject, inv.email.body);
  const p = (await R.pump()).find((g) => g.kind === "inv").r;
  R.send(S.address, "re", (await R.agent.join(p.invite, { code: inv.code })).hello);
  const secretX = S.agent.state.invites[inv.iid].x;   // white-box, ONLY for the positive control below
  await S.pump();
  const invTok = tokenOf(mb.msgs[0].body, "inv"), helloTok = tokenOf(mb.msgs[1].body, "hello");
  const iidS = b64u(unb64u(invTok.fields[1])), bS = unb64u(invTok.fields[2]), X = unb64u(invTok.fields[3]);
  const bR = unb64u(helloTok.fields[1]), Y = unb64u(helloTok.fields[2]), tagR = unb64u(helloTok.fields[4]);
  const pts = await S2.points();
  let verifierHits = 0, controlHits = 0, tried = 0;
  for (const code of I.allCodes(1)) {
    const w = await S2.deriveW(code, I.lp(["hyphae/invite/ctx/v1", iidS, bS]), FAST.kdfIters);
    const xG = C.add(C.decode(X), C.neg(C.mul(w, pts.M))), yG = C.add(C.decode(Y), C.neg(C.mul(w, pts.N)));
    tried++;
    // everything computable from public data: both unmasked points, the sum, and the masked values themselves
    for (const K of [xG, yG, C.add(xG, yG), C.decode(X), C.decode(Y)]) {
      if (!K) continue;
      const sch = await S2.schedule(I.lp(["hyphae/invite/tt/v1", iidS, bS, bR, X, Y, C.encode(K), C.i2b(w, 32)]));
      if (S2.ctEq(await S2.tag(sch.kcB, sch.h, "hello"), tagR)) verifierHits++;
    }
    // positive control: with the inviter's scalar x the same procedure DOES verify, for the right code only
    const Kx = C.mul(BigInt("0x" + secretX), yG);
    if (Kx) {
      const sch = await S2.schedule(I.lp(["hyphae/invite/tt/v1", iidS, bS, bR, X, Y, C.encode(Kx), C.i2b(w, 32)]));
      if (S2.ctEq(await S2.tag(sch.kcB, sch.h, "hello"), tagR)) controlHits++;
    }
  }
  return { broken: verifierHits > 0 || controlHits !== 1, detail: `${tried} codes × 5 public-only candidate K: ${verifierHits} verifier hits; with the private scalar the same code path finds the true code exactly ${controlHits} time(s)` };
});

await row("A8.5", "A8", "CONTROL: naive 'key = HKDF(code)' short-code design, 16-bit code, same mailbox reader", "control", async () => {
  const code = I.newCode(2).norm;
  const key = b64u(await S2.hkdf(te.encode(code), new Uint8Array(0), "naive", 32));
  const circle = { kid: b64u(wc.getRandomValues(new Uint8Array(8))), name: "n", key };
  const tok = await H.seal(circle, "meet at 6");
  let found = null;
  for (const c of I.allCodes(2)) {
    const k = b64u(await S2.hkdf(te.encode(c), new Uint8Array(0), "naive", 32));
    const r = await H.revealText(tok, { [circle.kid]: { kid: circle.kid, key: k } });
    if (r.opened) { found = c; break; }
  }
  return { broken: found === code, detail: "offline search over 65,536 codes recovers the key from one token" };
});

await row("A8.6", "A8", "spoofed invites feed R a stream of fake X values (one guess each); how many does R's client answer?", "defend", async () => {
  const mb = new Mailbox();
  const R = await Person.make("Rae", "rae@gmail.com", mb, FAST);
  const Mal = await Person.make("Mallory", "m@evil.example", mb, { ...FAST, maxFailures: 1e9 });
  const realCode = I.newCode(5);                       // the code S told R
  let answered = 0, refused = 0;
  for (let i = 0; i < 12; i++) {
    const fake = await Mal.agent.createInvite({ to: R.address, mode: "code" });
    const p = await R.agent.readInvite(fake.token, { from: "sam@gmail.com" });
    const j = await R.agent.join(p.invite, { code: realCode.display });
    if (j.ok) answered++; else refused++;
  }
  return { broken: answered > 3, detail: `R's client answered ${answered} of 12 fake invites, then: ${refused} refused (too-many-unconfirmed) → at most ${answered} guesses` };
});

await row("A8.7", "A8", "typing the code wrong costs the invite nothing (typos are caught on R's device, before any message)", "check", async () => {
  const { mb, S, R } = await world();
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  const p = await R.agent.readInvite(inv.token, { from: S.address });
  const typo = inv.code.slice(0, 3) + (inv.code[3] === "A" ? "B" : "A") + inv.code.slice(4);
  const j = await R.agent.join(p.invite, { code: typo });
  return { ok: !j.ok && j.reason === "mistyped-code" && S.agent.state.invites[inv.iid].failures === 0, detail: `typo → ${j.reason}; failures at S = ${S.agent.state.invites[inv.iid].failures}` };
});

// ================================================================================================
console.log("\n== A9  key substitution at first contact ==");

await row("A9.1", "A9", "sas mode, active MITM swaps both bundles: pairing happens — what exposes it?", "limit", async () => {
  const { mb, S, R } = await world();
  const Mal = await Person.make("Mallory", "m@evil.example", mb, FAST);
  const sFp = await S.agent.fp();
  // Mallory answers S's invite as "R" ...
  const inv = await S.agent.createInvite({ to: R.address, mode: "sas" });
  const parsedS = await Mal.agent.readInvite(inv.token, { from: R.address });
  await S.agent.acceptHello((await Mal.agent.join(parsedS.invite, {})).hello);
  // ... and shows R her own invite in S's place; R answers it
  const mineInv = await Mal.agent.createInvite({ to: R.address, mode: "sas" });
  const parsedM = await R.agent.readInvite(mineInv.token, { from: S.address });
  const jr = await R.agent.join(parsedM.invite, {});
  await Mal.agent.acceptHello(jr.hello);
  // S and R each see a contact and, having overridden the unverified warning, content flows
  const sc = onlyContact(S), rc = onlyContact(R);
  const tok = await S.agent.sealTo(sc.fp, "the board vote is 5-4", { allowUnverified: true });
  const malCircleWithS = Mal.agent.state.contacts[sFp].circle;          // Mallory's pairing with S
  const mallorySees = await H.revealText(tok, { [malCircleWithS.kid]: malCircleWithS });
  const snAtS = await S.agent.safetyNumber(sc.fp), snAtR = await R.agent.safetyNumber(rc.fp);
  const cmp = await S.agent.confirmSafetyNumber(sc.fp, snAtR);           // the number R reads out loud
  const broken = mallorySees.opened === 1;
  const detected = broken && snAtS !== snAtR && !cmp.ok && sc.status === "unverified";
  return { broken, detected, expectDetected: true, detail: `Mallory read the sealed token; safety numbers differ (S: ${snAtS.slice(0, 11)}… R: ${snAtR.slice(0, 11)}…), S's confirm of R's number → ${cmp.reason}, contact stays '${sc.status}', sealTo needed allowUnverified` };
});

await row("A9.2", "A9", "same MITM against a code pairing, attacker knows everything public but not the code", "defend", async () => {
  // identical to A2.5 but asserted on the status the user would see
  const { mb, S, R } = await world();
  const Mal = await Person.make("Mallory", "m@evil.example", mb, { ...FAST, maxFailures: 1e9 });
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  S.send(R.address, inv.email.subject, inv.email.body);
  const swapped = replaceField(inv.email.body, "inv", 2, b64u((await Mal.agent.bundle()).bytes));
  lastMsg(mb, R.address).body = swapped;
  const p = (await R.pump()).find((g) => g.kind === "inv").r;
  const j = await R.agent.join(p.invite, { code: inv.code });
  R.send(S.address, "re", replaceField(j.hello, "hello", 1, b64u((await Mal.agent.bundle()).bytes)));
  const atS = (await S.pump())[0].r;
  return { broken: !!atS.ok || (await wronglyPaired(S, R)), detail: `bundles swapped on the way both ways → S: ${atS.reason}; verified contacts: S=${Object.values(S.agent.state.contacts).length}, R=${Object.values(R.agent.state.contacts).length}` };
});

await row("A9.3", "A9", "CONTROL: email-address-bound key directory (WKD/Keybase-style) run by the party that is also the mailbox", "control", async () => {
  const real = await I.newIdentity("Rae"), evil = await I.newIdentity("Rae");
  const directory = {
    bundleFor: { "rae@gmail.com": I.bundleOf(real) },
    lookup(addr, attackerActive) { return attackerActive ? I.bundleOf(evil) : this.bundleFor[addr]; },
  };
  // S fetches R's key by address and seals to it (sealed-box style with an ephemeral ECDH key)
  const fetched = await I.readBundle(directory.lookup("rae@gmail.com", true));
  const eph = await wc.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pk = await wc.subtle.importKey("raw", fetched.dh, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await wc.subtle.deriveBits({ name: "ECDH", public: pk }, eph.privateKey, 256));
  const circle = { kid: b64u(wc.getRandomValues(new Uint8Array(8))), name: "sb", key: b64u(shared) };
  const tok = await H.seal(circle, "sealed to what the directory said");
  // the directory operator holds evil's private key and the ephemeral public key
  const ephPub = new Uint8Array(await wc.subtle.exportKey("raw", eph.publicKey));
  const evilPriv = await wc.subtle.importKey("jwk", { kty: "EC", crv: "P-256", ...evil.dh }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const epk = await wc.subtle.importKey("raw", ephPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const k2 = new Uint8Array(await wc.subtle.deriveBits({ name: "ECDH", public: epk }, evilPriv, 256));
  const r = await H.revealText(tok, { [circle.kid]: { kid: circle.kid, key: b64u(k2) } });
  return { broken: r.opened === 1, detail: "directory substitutes the key at lookup; S has no second channel to notice; attacker opens the token" };
});

await row("A9.4", "A9", "CONTROL: 20-bit short safety string with no commitment, attacker grinds both sides' keys (birthday)", "control", async () => {
  const { S, R } = await world();
  const bS = await S.agent.bundle(), bR = await R.agent.bundle();
  const fixedSign = bS.sign;
  async function cand() {
    const k = await wc.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const raw = new Uint8Array(await wc.subtle.exportKey("raw", k.publicKey));
    return I.readBundle(S2.concat(new Uint8Array([1]), raw, fixedSign));
  }
  const left = new Map();   // SN(bS, g2) -> g2   (what S would be shown)
  let hit = null, n = 0;
  while (!hit && n < 20000) {
    const g2 = await cand(), g1 = await cand(); n += 2;
    const a = await I.safetyNumberOf(bS, g2, 20), b = await I.safetyNumberOf(g1, bR, 20);
    if (left.has(b)) hit = { g1, g2: left.get(b) };
    left.set(a, g2);
  }
  return { broken: !!hit, detail: `matching 20-bit strings found after ${n} candidate keys` };
});

await row("A9.5", "A9", "same grinding against the real 130-bit safety number, 6000 candidate keys", "defend", async () => {
  const { S, R } = await world();
  const bS = await S.agent.bundle(), bR = await R.agent.bundle();
  async function cand() {
    const k = await wc.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const raw = new Uint8Array(await wc.subtle.exportKey("raw", k.publicKey));
    return I.readBundle(S2.concat(new Uint8Array([1]), raw, bS.sign));
  }
  const seen = new Map();
  let hit = false, n = 0;
  for (let i = 0; i < 3000; i++) {
    const g2 = await cand(), g1 = await cand(); n += 2;
    seen.set(await I.safetyNumberOf(bS, g2), 1);
    if (seen.has(await I.safetyNumberOf(g1, bR))) hit = true;
  }
  return { broken: hit, detail: `${n} candidates, ${seen.size} S-side strings vs ${n / 2} R-side strings: collisions ${hit ? "FOUND" : "none"} (birthday bound ~2^65 work)` };
});

// ================================================================================================
console.log("\n== A10  downgrade by user error ==");

await row("A10.1", "A10", "S pastes the live code into the email to R — nine ways of writing it", "defend", async () => {
  const { mb, S, R } = await world();
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  const c = inv.code, n = I.normalize(c);
  const variants = [
    c, c.toLowerCase(), c.replace(/-/g, " "), n, c.replace(/0/g, "O").replace(/1/g, "l"),
    `my code is ${c.toLowerCase().replace("-", " ")}, ok?`, c.replace("-", "\n"),
    n.match(/.{1,2}/g).join(" "), n.match(/.{1,3}/g).join("."),
  ];
  const missed = [];
  variants.forEach((v, i) => { if (S.agent.guardSend({ recipients: [R.address], subject: "hi", body: v }).allow) missed.push(i); });
  const inSubject = S.agent.guardSend({ recipients: [R.address], subject: "code " + c, body: "hello" });
  if (inSubject.allow) missed.push("subject");
  return { broken: missed.length > 0, detail: `${variants.length + 1} placements, ${missed.length} not blocked${missed.length ? " " + JSON.stringify(missed) : ""}` };
});

await row("A10.2", "A10", "S pastes a circle key, a share string, the written 17-group code or a private key into mail", "defend", async () => {
  const { mb, S, R } = await world();
  await pairByCode(S, R);
  const circle = Object.values(S.agent.state.contacts)[0].circle;
  const g = H.newCircle("grp");
  S.agent.addGroup(g, []);
  const tries = [
    circle.key, g.key, H.shareString(g), H.toWritten(g), S.agent.identity.dh.d, "key: " + circle.key.slice(0, 20) + " " + circle.key.slice(20),
  ];
  const missed = tries.filter((t) => S.agent.guardSend({ recipients: ["x@gmail.com"], subject: "s", body: t }).allow);
  return { broken: missed.length > 0, detail: `${tries.length} key leaks, ${missed.length} passed the guard` };
});

await row("A10.3", "A10", "S types plain text into Gmail's own field for a contact it has a sealed relationship with (also beside a token)", "defend", async () => {
  const { mb, S, R } = await world();
  await pairByCode(S, R);
  const rFp = Object.keys(S.agent.state.contacts)[0];
  const tok = I.sealedBody([await S.agent.sealTo(rFp, "ok")]);
  const a = S.agent.guardSend({ recipients: [R.address], subject: "lunch", body: "see you at 1, bring the contract" });
  const b = S.agent.guardSend({ recipients: [R.address], subject: I.SUBJECT_LABEL, body: tok + "\n\nP.S. the password is hunter2" });
  const ok = S.agent.guardSend({ recipients: [R.address], subject: I.SUBJECT_LABEL, body: tok });
  return { broken: a.allow || b.allow || !ok.allow, detail: `plaintext: ${a.blocks.map((x) => x.code)}; token + postscript: ${b.blocks.map((x) => x.code)}; clean sealed mail: ${ok.allow ? "allowed" : "BLOCKED"}` };
});

await row("A10.4", "A10", "attacker strips the code part out of the invite (turns it into a no-code invite) hoping R proceeds unverified", "defend", async () => {
  const { mb, S, R } = await world();
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  S.send(R.address, inv.email.subject, replaceField(inv.email.body, "inv", 3, "-"));
  const p = (await R.pump()).find((g) => g.kind === "inv").r;
  const withCode = await R.agent.join(p.invite, { code: inv.code });
  const noCode = await R.agent.join(p.invite, {});
  // R proceeds without a code anyway (sas-style hello): S, which issued a code invite, must not fall back
  R.send(S.address, "re", noCode.hello);
  const atS = (await S.pump())[0].r;
  return { broken: withCode.ok || atS.ok, detail: `R with a code: ${withCode.reason}; R without: hello sent as unverified; S (issued a code invite) → ${atS.reason}` };
});

await row("A10.5", "A10", "code leaks in a readable channel BEFORE R uses it; attacker (has mailbox + code) answers first", "limit", async () => {
  const { mb, S, R } = await world();
  const Mal = await Person.make("Mallory", "m@evil.example", mb, FAST);
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  S.send(R.address, inv.email.subject, inv.email.body);
  const parsedM = await Mal.agent.readInvite(lastMsg(mb, R.address).body, { from: S.address });
  const jm = await Mal.agent.join(parsedM.invite, { code: inv.code });           // she has the leaked code
  mb.deliver({ from: R.address, to: S.address, subject: "re", body: jm.hello });  // sent from R's address (spoofed / her mailbox access)
  const atS = (await S.pump())[0];
  const welcome = lastMsg(mb, R.address);
  const broken = atS.r.ok && Object.values(S.agent.state.contacts)[0].fp === (await Mal.agent.fp());
  // R now opens the invite and the (to R, unsolicited) welcome, and answers with the real code
  const gotR = await R.pump();
  const unsolicited = gotR.find((g) => g.kind === "welcome");
  const p = gotR.find((g) => g.kind === "inv").r;
  const jr = await R.agent.join(p.invite, { code: inv.code });
  const late = await S.agent.acceptHello(jr.hello);
  const welcome2 = await R.agent.acceptWelcome(welcome.body);
  const snS = await S.agent.safetyNumber(Object.keys(S.agent.state.contacts)[0]);
  const snR = await R.agent.safetyNumber(await S.agent.fp()).catch(() => null);
  const detected = broken && (!!unsolicited && unsolicited.r.alarm === "unsolicited-welcome") && late.alarm === "code-used-twice" && S.agent.state.alarms.some((a) => a.type === "code-used-twice") && welcome2.ok === false;
  return { broken, detected, expectDetected: true, detail: `S paired with the attacker (verified-code); alarms: R sees ${unsolicited && unsolicited.r.alarm}, S sees ${late.alarm}, R's real welcome check → ${welcome2.reason}; a voice check of the safety number would also differ` };
});

await row("A10.6", "A10", "leaked code AND the attacker controls R's mailbox (deletes the invite and the welcome): is anyone told?", "limit", async () => {
  const { mb, S, R } = await world();
  const Mal = await Person.make("Mallory", "m@evil.example", mb, FAST);
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  S.send(R.address, inv.email.subject, inv.email.body);
  const parsedM = await Mal.agent.readInvite(lastMsg(mb, R.address).body, { from: S.address });
  mb.msgs = mb.msgs.filter((m) => m.to !== R.address);                          // R never sees the invite
  const jm = await Mal.agent.join(parsedM.invite, { code: inv.code });
  mb.deliver({ from: R.address, to: S.address, subject: "re", body: jm.hello });
  const atS = (await S.pump())[0].r;
  mb.msgs = mb.msgs.filter((m) => m.to !== R.address);                          // ... nor the welcome
  const contact = onlyContact(S);
  const alarms = S.agent.state.alarms.length + R.agent.state.alarms.length;
  const broken = atS.ok && contact.fp === (await Mal.agent.fp());
  return { broken, detected: alarms > 0, expectDetected: false, detail: `S shows a verified-code contact for R's address that is the attacker; alarms raised anywhere: ${alarms}. Only S asking R out loud "did it work?" (or comparing the safety number) exposes it.` };
});

await row("A10.7", "A10", "S types a revealing subject while sealing the body (Gmail stores subjects in plaintext; no sealed subject exists in the adapter)", "defend", async () => {
  const { mb, S, R } = await world();
  await pairByCode(S, R);
  const rFp = Object.keys(S.agent.state.contacts)[0];
  const tok = I.sealedBody([await S.agent.sealTo(rFp, "details", { subject: "Layoffs list — draft 3" })]);
  const leak = S.agent.guardSend({ recipients: [R.address], subject: "Layoffs list — draft 3", body: tok });
  const reply = S.agent.guardSend({ recipients: [R.address], subject: "Re: " + I.SUBJECT_LABEL, body: tok });
  const label = S.agent.guardSend({ recipients: [R.address], subject: I.SUBJECT_LABEL, body: tok });
  const sub = JSON.stringify(mb.dump()).includes("Layoffs") || tok.includes("Layoffs");
  return { broken: leak.allow || !reply.allow || !label.allow || sub, detail: `readable subject → ${leak.blocks.map((b) => b.code)}; "Re: label" allowed=${reply.allow}; label allowed=${label.allow}; subject text visible in the sealed mail: ${sub}` };
});

// ---- regressions from the independent review (each was a real break or weakness in an earlier build) ----
console.log("\n== found by the independent review, now regression tests ==");

await row("R1", "A8", "concurrent hellos: 39 wrong guesses and the right code fired at once (budget must not be raced)", "defend", async () => {
  const { mb, S, R } = await world();
  const Mal = await Person.make("Mallory", "m@evil.example", mb, { ...FAST, maxFailures: 1e9 });
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  const pM = await Mal.agent.readInvite(inv.token, { from: S.address });
  const pR = await R.agent.readInvite(inv.token, { from: S.address });
  const hellos = [];
  for (let i = 0; i < 39; i++) hellos.push((await Mal.agent.join(pM.invite, { code: I.newCode(5).display })).hello);
  hellos.push((await R.agent.join(pR.invite, { code: inv.code })).hello);       // the correct one, last
  const results = await Promise.all(hellos.map((h) => S.agent.acceptHello(h)));
  const evaluated = results.filter((r) => r.reason === "bad-tag").length;
  const paired = Object.keys(S.agent.state.contacts).length;
  return { broken: evaluated > 3 || paired > 0 || S.agent.state.invites[inv.iid].state === "used", detail: `${evaluated} guesses evaluated (budget 3); contacts after the lock: ${paired}; state ${S.agent.state.invites[inv.iid].state}` };
});

await row("R2", "A2", "object-prototype keys on the wire: iid/welcome id/envelope sender/ids named constructor, __proto__, toString", "defend", async () => {
  const { mb, S, R } = await world();
  const Mal = await Person.make("Mallory", "m@evil.example", mb, FAST);
  const inv = await S.agent.createInvite({ to: R.address, mode: "sas" });
  const p = await Mal.agent.readInvite(inv.token, { from: S.address });
  const real = (await Mal.agent.join(p.invite, {})).hello;
  let threw = 0, planted = 0;
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    for (const f of [() => S.agent.acceptHello(replaceField(real, "hello", 0, key)), () => R.agent.acceptWelcome(`hy1welcome.${key}.${b64u(new Uint8Array(32))}.${b64u(new Uint8Array(64))}~`)]) {
      try { await f(); } catch (e) { threw++; }
    }
  }
  planted += Object.keys(S.agent.state.contacts).length;
  // an envelope whose sender / id are prototype names, next to a genuine one
  const { A, B, M, circle } = await group3();
  const poison = await craft(M.agent, circle, { from: "constructor", id: "__proto__" });
  const poison2 = await craft(M.agent, circle, { from: "toString", id: "constructor" });
  const good = await B.agent.sealGroup(circle.kid, "genuine");
  let results = [];
  try { results = await A.agent.open([poison, poison2, good].join("\n\n")); } catch (e) { threw++; }
  const goodOk = results.some((r) => r.authentic && r.body === "genuine");
  const poisonAccepted = results.some((r) => r.authentic && r.body === "x");
  return { broken: threw > 0 || planted > 0 || !goodOk || poisonAccepted, detail: `exceptions ${threw}, contacts planted ${planted}, genuine token still opened beside 2 poisoned ones: ${goodOk}` };
});

await row("R3", "A2", "algorithmic DoS: 280 KB of 'hy1inv.' / 'hy1.' repeated with no terminator through every parser", "defend", async () => {
  const { S, R } = await world();
  const bombs = ["hy1inv.".repeat(40000), "hy1.".repeat(70000), "hy1 ".repeat(70000), "h".repeat(280000) + " ".repeat(10), ("hy1." + "A".repeat(10) + ".").repeat(25000)];
  let worst = 0;
  for (const b of bombs) {
    for (const f of [() => I.parseTokens(b), () => R.agent.open(b), () => S.agent.guardSend({ recipients: ["x@y.z"], subject: "s", body: b }), () => S.agent.acceptHello(b), () => R.agent.readInvite(b, {})]) {
      const t0 = Date.now();
      await f();
      worst = Math.max(worst, Date.now() - t0);
    }
  }
  return { broken: worst > 3000, detail: `worst single call over 5 bombs × 5 entry points: ${worst} ms (earlier build: 10–32 s)` };
});

await row("R4", "A10", "guard evasions: only the 8 secret characters; a hex-encoded key; a quoted old invite with plaintext added", "defend", async () => {
  const { mb, S, R } = await world();
  const inv = await S.agent.createInvite({ to: "other@gmail.com", mode: "code" });
  const eight = I.normalize(inv.code).slice(0, 8);
  const first8 = S.agent.guardSend({ recipients: ["q@gmail.com"], subject: "s", body: "the first part is " + eight });
  await pairByCode(S, R);
  const rFp = Object.keys(S.agent.state.contacts)[0];
  const key = S.agent.state.contacts[rFp].circle.key;
  const hexKey = Buffer.from(unb64u(key)).toString("hex");
  const hexLeak = S.agent.guardSend({ recipients: ["q@gmail.com"], subject: "s", body: "k=" + hexKey });
  const quoted = S.agent.guardSend({ recipients: [R.address], subject: "re: invite", body: "see you at 6, password is hunter2\n\n> " + inv.email.body.split("\n").join("\n> ") });
  const justInvite = S.agent.guardSend({ recipients: ["new@gmail.com"], subject: inv.email.subject, body: inv.email.body });
  return { broken: first8.allow || hexLeak.allow || quoted.allow || !justInvite.allow, detail: `8 chars: ${first8.allow ? "PASSED" : "blocked"}; hex key: ${hexLeak.allow ? "PASSED" : "blocked"}; quoted invite + plaintext to a contact: ${quoted.allow ? "PASSED" : "blocked"}; the bare invite to a stranger: ${justInvite.allow ? "allowed" : "BLOCKED"}` };
});

await row("R5", "A7", "R presses Join twice with the same code (double click, retry) — does the inviter's welcome still verify?", "defend", async () => {
  const { mb, S, R } = await world();
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  const p = await R.agent.readInvite(inv.token, { from: S.address });
  const j1 = await R.agent.join(p.invite, { code: inv.code });
  const j2 = await R.agent.join(p.invite, { code: inv.code });
  const a1 = await S.agent.acceptHello(j1.hello), a2 = await S.agent.acceptHello(j2.hello);
  const atR = await R.agent.acceptWelcome(a1.welcome);
  const falseAlarm = S.agent.state.alarms.length;
  return { broken: !(atR.ok && j2.again && j1.hello === j2.hello) || falseAlarm > 0, detail: `second Join returned the same hello (again=${!!j2.again}); S: ${a1.ok}/${a2.ok ? "dup-ok" : a2.reason}; R verified=${atR.ok}; false alarms=${falseAlarm}` };
});

await row("R6", "A6", "mail rewritten so an invite arrives 'from' a different address: does it bind S's key to that address on R's side?", "defend", async () => {
  const { mb, S, R } = await world();
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  const p = await R.agent.readInvite(inv.token, { from: "cfo@rae-employer.com" });      // spoofed/rewritten From
  const j = await R.agent.join(p.invite, { code: inv.code });
  const a = await S.agent.acceptHello(j.hello);
  await R.agent.acceptWelcome(a.welcome);
  const before = R.agent.contactForAddress("cfo@rae-employer.com");
  const sFp = await S.agent.fp();
  const bound = R.agent.bindAddress(sFp, "sam@gmail.com");
  const after = R.agent.contactForAddress("sam@gmail.com");
  return { broken: !!before.contact, detail: `rewritten From resolves to a contact: ${!!before.contact}; after the person binds sam@gmail.com: ${after.contact ? "resolves" : "no"} (bound=${bound})`, };
});

await row("R7", "A2", "two hello tokens in one mail (a quoted reply): the welcome and address still come back at the top level", "check", async () => {
  const { mb, S, R } = await world();
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  const p = await R.agent.readInvite(inv.token, { from: S.address });
  const hello = (await R.agent.join(p.invite, { code: inv.code })).hello;
  const r = await S.agent.acceptHello(`${hello}\n\n> on Tuesday you wrote:\n> ${hello}`);
  return { ok: r.ok && !!r.welcome && r.to === R.address, detail: `ok=${r.ok}, welcome present=${!!r.welcome}, to=${r.to}` };
});

// ================================================================================================
console.log("\n== robustness the flow depends on ==");

await row("F1", "-", "Gmail splits/quotes content tokens; a 200 KB Drive-style file round-trips through a pairwise circle", "check", async () => {
  const { mb, S, R } = await world();
  await pairByCode(S, R);
  const rFp = Object.keys(S.agent.state.contacts)[0];
  const bytes = new Uint8Array(200 * 1024);
  for (let i = 0; i < bytes.length; i += 65536) wc.getRandomValues(bytes.subarray(i, Math.min(i + 65536, bytes.length)));
  const tok = await S.agent.sealFile(rFp, { name: "q3.xlsx", mime: "application/octet-stream", bytes });
  const mangled = gmailMangle(I.sealedBody([tok]), { wrap: 78, quote: true });
  const r = (await R.agent.open(mangled))[0];
  const back = unb64u(r.body);
  const same = back && back.length === bytes.length && Buffer.from(back).equals(Buffer.from(bytes));
  const msg = (await R.agent.open(gmailMangle(I.sealedBody([await S.agent.sealTo(rFp, "hello after wrap")]), { wrap: 40, quote: true })))[0];
  return { ok: r.authentic && r.name === "q3.xlsx" && same && msg.body === "hello after wrap", detail: `${bytes.length} bytes, token ${tok.length} chars, authentic=${r.authentic}` };
});

await row("F4", "-", "the real subject travels inside the signed envelope and comes back out on open()", "check", async () => {
  const { mb, S, R } = await world();
  await pairByCode(S, R);
  const rFp = Object.keys(S.agent.state.contacts)[0];
  const tok = await S.agent.sealTo(rFp, "body text", { subject: "Q3 numbers" });
  const r = (await R.agent.open(I.sealedBody([tok])))[0];
  return { ok: r.authentic && r.subject === "Q3 numbers" && r.body === "body text", detail: `subject='${r.subject}', authentic=${r.authentic}` };
});

await row("F2", "-", "production KDF cost (PBKDF2 100,000) pairing end to end", "check", async () => {
  const { mb, S, R } = await world({ kdfIters: 100000 });
  const t0 = Date.now();
  const res = await pairByCode(S, R);
  const ok = res.atS[0].r.ok && res.atR[0].r.ok;
  return { ok, detail: `${Date.now() - t0} ms for the whole pairing` };
});

await row("F3", "-", "state survives JSON persistence (what chrome.storage would hold): pair, restart, open, seal", "check", async () => {
  const { mb, S, R } = await world();
  await pairByCode(S, R);
  const saved = JSON.parse(JSON.stringify({ identity: R.agent.identity, state: R.agent.state }));
  const R2 = new I.Agent({ identity: saved.identity, state: saved.state, params: FAST });
  const rFp = Object.keys(S.agent.state.contacts)[0];
  const tok = await S.agent.sealTo(rFp, "after restart");
  const r = (await R2.open(tok))[0];
  const back = await R2.sealTo(Object.keys(R2.state.contacts)[0], "reply");
  const r2 = (await S.agent.open(back))[0];
  return { ok: r.authentic && r.body === "after restart" && r2.authentic && r2.body === "reply", detail: "round trip after reload" };
});

// ================================================================================================
const byKind = (k) => rows.filter((r) => r.kind === k);
const d = byKind("defend"), l = byKind("limit"), c = byKind("control"), k = byKind("check");
const dOk = d.filter((r) => r.status === "DEFENDED").length;
const lBroken = l.filter((r) => r.status.startsWith("ACCEPTED")).length;
const cOk = c.filter((r) => r.status.startsWith("BROKEN as")).length;
const kOk = k.filter((r) => r.status === "ok").length;
console.log("\n" + "=".repeat(112));
console.log("ID     kind    result                              attack");
console.log("-".repeat(112));
for (const r of rows) console.log(`${r.id.padEnd(6)} ${r.kind.padEnd(7)} ${r.status.padEnd(35)} ${r.title.length > 66 ? r.title.slice(0, 65) + "…" : r.title}`);
console.log("=".repeat(112));
console.log(`ATTACKS ON THE PROTOTYPE   attempted ${d.length}   defended ${dOk}   SUCCEEDED ${d.length - dOk}`);
console.log(`ACCEPTED LIMITS            ${l.length} played; ${lBroken} succeed by design; detection asserted where claimed`);
console.log(`CONTROLS (weak designs)    ${c.length} played; ${cOk} broken as expected (harness can break things)`);
console.log(`CHECKS                     ${k.length} run; ${kOk} ok`);
console.log(failures ? `\nSUITE FAILED: ${failures} row(s)` : "\nSUITE PASSED");
process.exit(failures ? 1 : 0);
