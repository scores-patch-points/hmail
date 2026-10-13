// Test harness for the invite flow. Everything here is local and in-process:
// a mailbox that Google (or anyone) can read and rewrite, a link scanner, a
// mock web, and people with an Agent each. Nothing touches a network, a real
// mailbox or a real account.
import "../crypto.js";
import "./p256.js";
import "./spake2.js";
import "./hyinvite.js";

export const H = globalThis.HyCrypto;
export const C = globalThis.HyP256;
export const S2 = globalThis.HySpake2;
export const I = globalThis.HyInvite;

/** Fast KDF for Monte-Carlo runs; the protocol logic is identical. Production is I.PARAMS.kdfIters. */
export const FAST = { kdfIters: 1000 };

/** One clock for every agent, so a test can let an invite age. */
export const clock = { t: Date.now() };

/**
 * The mailbox. `adversary` functions see every message on its way in and may
 * return it unchanged, a modified copy, null (drop), or an array (inject).
 * `dump()` is what a passive reader with the whole mailbox sees.
 */
export class Mailbox {
  constructor() { this.msgs = []; this.adversaries = []; this.seq = 0; }
  deliver(msg) {
    let batch = [{ ...msg }];
    for (const adv of this.adversaries) {
      const next = [];
      for (const m of batch) {
        const r = adv(m);
        if (r === null || r === undefined) continue;
        if (Array.isArray(r)) next.push(...r); else next.push(r);
      }
      batch = next;
    }
    for (const m of batch) this.msgs.push({ id: ++this.seq, ...m });
    return batch.length;
  }
  inbox(addr) { return this.msgs.filter((m) => m.to === addr.toLowerCase()); }
  dump() { return this.msgs.map((m) => `From: ${m.from}\nTo: ${m.to}\nSubject: ${m.subject}\n\n${m.body}`).join("\n\n=====\n\n"); }
}

export class Person {
  constructor(name, address, mailbox, agent) {
    this.name = name; this.address = address.toLowerCase(); this.mailbox = mailbox; this.agent = agent;
    this.seen = new Set();
    this.log = [];
  }
  static async make(name, address, mailbox, params) {
    const identity = await I.newIdentity(name);
    return new Person(name, address, mailbox, new I.Agent({
      identity, now: () => clock.t, params: { ...FAST, ...(params || {}) },
    }));
  }
  send(to, subject, body) { return this.mailbox.deliver({ from: this.address, to: to.toLowerCase(), subject, body }); }
  /** What the extension does when it opens mail: hello and welcome are machine messages. */
  async pump() {
    const out = [];
    for (const m of this.mailbox.inbox(this.address)) {
      if (this.seen.has(m.id)) continue;
      this.seen.add(m.id);
      const toks = I.parseTokens(m.body);
      for (const t of toks) {
        if (t.kind === "hello") {
          const r = await this.agent.acceptHello(m.body);
          out.push({ kind: "hello", m, r });
          if (r.ok && r.welcome) this.send(r.to, "re: invite", r.welcome);
          break;
        }
        if (t.kind === "welcome") { out.push({ kind: "welcome", m, r: await this.agent.acceptWelcome(m.body) }); break; }
        if (t.kind === "inv") { out.push({ kind: "inv", m, r: await this.agent.readInvite(m.body, { from: m.from }) }); break; }
      }
    }
    return out;
  }
}

/**
 * An automated link scanner / prefetcher: finds every URL in a message and
 * GETs it (twice — some gateways fetch once to scan and once to rewrite).
 */
export class Web {
  constructor() { this.routes = new Map(); this.hits = []; }
  on(prefix, fn) { this.routes.set(prefix, fn); }
  get(url) {
    this.hits.push(url);
    for (const [p, fn] of this.routes) if (url.startsWith(p)) return fn(url);
    return { status: 200, body: "static page" };
  }
}
export function scan(msg, web) {
  const urls = [...new Set((msg.subject + "\n" + msg.body).match(/https?:\/\/[^\s)>"']+/g) || [])];
  for (const u of urls) { web.get(u); web.get(u); }
  return urls;
}

/** What Gmail does to a token in transit: hard-wrap, and quote when replying. */
export function gmailMangle(body, { wrap = 60, quote = false } = {}) {
  const lines = [];
  for (const line of body.split("\n")) {
    if (line.length <= wrap) { lines.push(line); continue; }
    for (let i = 0; i < line.length; i += wrap) lines.push(line.slice(i, i + wrap));
  }
  return lines.map((l) => (quote ? "> " : "") + l).join("\n");
}

export function flip(str, at) {
  const chars = str.split("");
  const i = at ?? Math.floor(chars.length / 2);
  chars[i] = chars[i] === "A" ? "B" : "A";
  return chars.join("");
}

/** Complete a code-mode pairing between two people through `mailbox`. Returns everything produced. */
export async function pairByCode(S, R) {
  const inv = await S.agent.createInvite({ to: R.address, mode: "code" });
  S.send(R.address, inv.email.subject, inv.email.body);
  const got = await R.pump();
  const parsed = got.find((g) => g.kind === "inv").r;
  const j = await R.agent.join(parsed.invite, { code: inv.code });
  if (!j.ok) return { inv, j };
  R.send(S.address, "re: invite", j.hello);
  const atS = await S.pump();
  const atR = await R.pump();
  return { inv, j, atS, atR };
}
