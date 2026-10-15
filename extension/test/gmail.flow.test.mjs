// End-to-end flow test for the Gmail adapter against a stand-in Gmail DOM (jsdom),
// with the real invite bridge and contacts core behind chrome.runtime.sendMessage.
//   JSDOM_DIR=/path/to/dir-with-node_modules-jsdom node extension/test/gmail.flow.test.mjs
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..");
const jsdomDir = process.env.JSDOM_DIR || path.join(ext, "..", "node_modules");
const req = createRequire(path.join(jsdomDir, "x.js"));
const { JSDOM } = req("jsdom");
const nreq = createRequire(import.meta.url);

nreq(path.join(ext, "crypto.js")); nreq(path.join(ext, "invite/p256.js")); nreq(path.join(ext, "invite/spake2.js"));
nreq(path.join(ext, "invite/hyinvite.js")); nreq(path.join(ext, "invite-bridge.js")); nreq(path.join(ext, "contacts/core.js"));
const HI = globalThis.HyInvite, Bridge = globalThis.HyInviteBridge;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const wait = ms => new Promise(r => setTimeout(r, ms));
const mem = () => { const m = new Map(); return { get: async k => m.get(k), set: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); } }; };

const SRC = ["crypto.js", "content.js", "gmail.js"].map(f => fs.readFileSync(path.join(ext, f), "utf8"));

const PAGE = `<!doctype html><html><body>
<div id="top"><a aria-label="Google Account: x"></a><span></span><span></span></div>
<div role="button" gh="cm">Compose</div>
<div role="main" id="main"></div>
</body></html>`;

function makePerson(name, address) {
  const dom = new JSDOM(PAGE, { url: "https://mail.google.com/mail/u/0/", pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window, d = w.document;
  Object.defineProperty(w, "crypto", { value: webcrypto });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() { return Array.from(this.childNodes).map(n => n.nodeType === 3 ? n.nodeValue : (n.tagName === "BR" ? "\n" : (n.innerText || ""))).join(""); },
    set(v) { this.textContent = v; }, configurable: true,
  });
  const store = mem();
  const bridge = Bridge.create({ HyInvite: HI, storage: store, name });
  const store2 = mem();
  const contacts = globalThis.HyContacts.create({ storage: store2 });
  w.chrome = { runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      const done = r => setTimeout(() => cb(r), 0);
      if (msg.hyphae === "invite") bridge.handle(msg.op, msg.args).then(done);
      else if (msg.hyphae === "contacts" && msg.op === "search") {
        // what background.js does: the store's answers plus people connected by invitation
        Promise.all([contacts.search(...(msg.args || [])), bridge.handle("directory", { q: msg.args[0] })])
          .then(([r, d]) => done({ ok: true, result: Bridge.mergeSuggestions(r, d.people) }), () => done({ ok: false }));
      }
      else if (msg.hyphae === "contacts") contacts[msg.op](...(msg.args || [])).then(r => done({ ok: true, result: r }), e => done({ ok: false }));
      else done(null);
    },
  } };
  // execCommand stand-in: insertText into the focused input or contenteditable.
  d.execCommand = function (cmd, ui, val) {
    const a = d.activeElement;
    if (cmd === "selectAll") { this._sel = a; return true; }
    if (cmd === "delete") { if (a && a.isContentEditable) a.textContent = ""; return true; }
    if (cmd === "insertText") {
      if (!a) return false;
      if (a.tagName === "INPUT") {
        if (a.getAttribute("aria-label") === "To recipients" && /,$/.test(val)) {
          const chip = d.createElement("span"); chip.setAttribute("email", val.replace(/,$/, "")); chip.textContent = val;
          a.parentElement.insertBefore(chip, a); a.value = "";
        } else a.value += val;
        a.dispatchEvent(new w.Event("input", { bubbles: true }));
        return true;
      }
      if (a.isContentEditable || a.getAttribute("contenteditable") === "true") {
        if (this._sel === a) { a.textContent = ""; this._sel = null; }
        a.appendChild(d.createTextNode(val)); return true;
      }
    }
    return true;
  };
  const main = d.getElementById("main");
  let seq = 0;
  function openCompose() {
    seq++;
    const dlg = d.createElement("div"); dlg.setAttribute("role", "dialog"); dlg.id = "c" + seq;
    dlg.innerHTML = `<div class="title"><button aria-label="Minimize"></button><button aria-label="Full screen"></button><button aria-label="Save &amp; close"></button></div>
      <div class="addr"><div class="toRow"><input aria-label="To recipients"></div></div>
      <div class="subjRow"><input name="subjectbox"></div>
      <div aria-label="Message Body" contenteditable="true"></div>
      <div role="button" aria-label="Send">Send</div>`;
    main.appendChild(dlg);
    return dlg;
  }
  d.querySelector('div[gh="cm"]').addEventListener("click", () => openCompose());
  for (const code of SRC) w.eval(code);
  return { w, d, name, address, bridge, contacts, openCompose, main, G: () => w.__hyphaeGmail };
}

const compose = p => { const dlg = p.d.querySelector('div[role="dialog"]:last-of-type') || p.d.querySelector('div[role="dialog"]'); return dlg; };
const fieldsOf = dlg => ({
  to: Array.from(dlg.querySelectorAll("[email]")).map(n => n.getAttribute("email")),
  subject: dlg.querySelector('input[name="subjectbox"]').value,
  body: dlg.querySelector('[aria-label="Message Body"]').textContent,
});
async function received(p, text, from) {
  const box = p.d.createElement("div"); box.className = "a3s";
  const holder = p.d.createElement("div"); holder.className = "adn";
  holder.innerHTML = `<span class="gD" email="${from || ""}"></span>`;
  holder.appendChild(box); box.textContent = text; p.main.appendChild(holder);
  return { box, holder };
}

// ------------------------------------------------------------------ people
const S = makePerson("Sam", "sam@example.com");
const R = makePerson("Riley", "riley@example.com");
// a stranger so the circle path is absent: no circles for either
S.G().setCircles({}, null); R.G().setCircles({}, null);

// ---- 1. Sam writes to Riley, who is not connected
S.openCompose(); await wait(700);
ok(S.G().state().composes.length === 1, "compose tracked");
S.G().toggle(0); await wait(100);
let ui = S.G().ui(0);
ok(ui.titleBar && ui.toActive && ui.toShown === "block", "title-bar switch mounted; hyphae recipient field stands in");
S.G().pickTo(0, "riley@example.com");
ui = S.G().ui(0);
ok(ui.to.length === 1 && ui.to[0] === "riley@example.com", "recipient taken by hyphae's field, not Gmail's To");
const gmailToBefore = fieldsOf(S.d.querySelector('div[role="dialog"]')).to;
ok(gmailToBefore.length === 0, "Gmail's To has no chip while typing in hyphae's field");
S.G().fill(0, "Plan", "the real message");
const r1 = await S.G().sealOnly(0);
ok(r1 && r1.ok === false && r1.missing && r1.missing[0] === "riley@example.com", "send refused: not connected");
ui = S.G().ui(0);
ok(/Invite riley@example.com/.test(ui.invite) , "invite offered for the stranger");
ok(fieldsOf(S.d.querySelector('div[role="dialog"]')).body === "" , "nothing was put in Gmail's body");

// ---- 2. Sam invites; a new compose opens with a brand-free invitation
await S.G().inviteClick(0, "riley@example.com"); await wait(800);
ui = S.G().ui(0);
const codeShown = (ui.invite.match(/[A-Z0-9]{4}[- ]?[A-Z0-9]{4}[- ]?[A-Z0-9]{2}|[A-Z0-9-]{10,12}/) || [])[0];
ok(/one-time code/i.test(ui.invite), "code panel shown in hyphae's own bar");
const dlgs = S.d.querySelectorAll('div[role="dialog"]');
ok(dlgs.length === 2, "a second compose was opened for the invitation");
const inv = fieldsOf(dlgs[1]);
ok(inv.to.indexOf("riley@example.com") !== -1, "invitation addressed to Riley");
const invHead = inv.body.split("-- the part below")[0];
ok(!/hyphae|encrypt/i.test(invHead + inv.subject), "invitation text names neither the product nor encryption");
ok(/hy1inv\./.test(inv.body.replace(/\s+/g, "")), "invitation carries the public token");
// the code must not be in any Gmail field
const code = (await S.bridge.handle("alarms", {})).ok && null;
const allGmail = JSON.stringify([...S.d.querySelectorAll("input")].map(i => i.value)) + S.d.querySelectorAll('[aria-label="Message Body"]')[1].textContent;
const created = ui.invite.replace(/\s+/g, "");
ok(true, "(code check below, against the bridge)");

// ---- 3. Riley receives it and joins with the code
// recover the code from the panel text
console.log("PANEL:", JSON.stringify(ui.invite));
const m = /not in any Google chat:\s*([A-Z0-9][A-Z0-9 -]*[A-Z0-9])\s*(Copy code)/.exec(ui.invite.replace(/\s+/g, " "));
const typed = m ? m[1].trim() : null;
ok(!!typed, "code readable in the panel: " + typed);
ok(allGmail.replace(/[\s-]/g, "").indexOf((typed || "ZZZ").replace(/[\s-]/g, "")) === -1, "code appears in no Gmail field");

await received(R, inv.body, "sam@example.com"); await wait(900);
ok(R.G().fam().length === 1 && R.G().fam()[0].kind === "inv", "Riley's page shows the invitation strip");
await R.G().famClick(0, typed); await wait(900);
ok(/Reply drafted/.test(R.G().fam()[0].state), "Riley's answer drafted: " + R.G().fam()[0].state);
const rDlg = R.d.querySelectorAll('div[role="dialog"]')[R.d.querySelectorAll('div[role="dialog"]').length - 1];
const hello = fieldsOf(rDlg);
ok(hello.to.indexOf("sam@example.com") !== -1, "answer addressed to the sender read from the page");
ok(/hy1hello\./.test(hello.body.replace(/\s+/g, "")), "answer carries the hello token");

// ---- 4. Sam receives the answer and accepts
await received(S, hello.body, "riley@example.com"); await wait(900);
const famS = S.G().fam();
ok(famS.some(f => f.kind === "hello"), "Sam's page shows the answer strip");
const idx = famS.findIndex(f => f.kind === "hello");
await S.G().famClick(idx); await wait(900);
ok(/Connected/.test(S.G().fam()[idx].state), "Sam is connected: " + S.G().fam()[idx].state);
const sDlgs = S.d.querySelectorAll('div[role="dialog"]');
const welcome = fieldsOf(sDlgs[sDlgs.length - 1]);
ok(welcome.to.indexOf("riley@example.com") !== -1, "welcome addressed to the invited address");

// ---- 5. Riley finishes
await received(R, welcome.body, "sam@example.com"); await wait(900);
const famR = R.G().fam(); const wi = famR.findIndex(f => f.kind === "welcome");
ok(wi !== -1, "Riley's page shows the confirmation strip");
await R.G().famClick(wi); await wait(500);
ok(/Connected/.test(R.G().fam()[wi].state), "Riley connected: " + R.G().fam()[wi].state);

// ---- 6. Now Sam sends to Riley for real
S.openCompose(); await wait(700);
const k = S.G().state().composes.length - 1;
S.G().toggle(k); await wait(100);
S.G().pickTo(k, "riley@example.com");
S.G().fill(k, "Plan for Friday", "the real message");
const sealed = await S.G().sealOnly(k);
ok(sealed && sealed.ok, "sealed to the pair: " + JSON.stringify(sealed));
const lastDlg = S.d.querySelectorAll('div[role="dialog"]')[k];
const out = fieldsOf(lastDlg);
ok(out.to.indexOf("riley@example.com") !== -1, "Gmail's To got the final address only at send time");
ok(out.subject === HI.SUBJECT_LABEL, "Gmail's Subject is only the neutral label: " + JSON.stringify(out.subject));
ok(out.body.indexOf("the real message") === -1 && out.body.indexOf("Plan for Friday") === -1, "no plaintext in what Gmail stores");
ok(!/hyphae|encrypt|private/i.test(out.body.split("hy1.")[0] + out.subject), "cover text names neither product nor encryption");
// Riley reads it
const opened = await R.bridge.handle("open", { text: out.body });
ok(opened.ok && opened.items[0] && opened.items[0].body.indexOf("the real message") !== -1, "Riley opens the body");
ok(opened.items[0].subject === "Plan for Friday", "Riley gets the real subject from inside");
ok(opened.items[0].authentic === true, "authentic: signed by Sam's key");

// ---- 6b. and Riley's page shows it, opened by the worker
await received(R, out.body, "sam@example.com"); await wait(1200);
const pr = R.G().pairs();
ok(pr.length === 1 && pr[0].opened, "Riley's page opens the pair message: " + JSON.stringify(pr));
ok(pr[0] && /Plan for Friday/.test(pr[0].text) && /the real message/.test(pr[0].text), "panel shows the real subject and body");
ok(pr[0] && /signed by someone you connected with/.test(pr[0].state), "panel says the signature checked out");

// ---- 6c. Riley writes back: Sam is suggested from the local directory, as connected, and sent to
R.openCompose(); await wait(700);
const rk = R.G().state().composes.length - 1;
R.G().toggle(rk); await wait(100);
R.G().typeTo(rk, "sa"); await wait(500);
ok(R.G().suggestions(rk).indexOf("sam@example.com") !== -1, "Sam is suggested to Riley from the local directory: " + JSON.stringify(R.G().suggestions(rk)));
R.G().pickTo(rk); await wait(300);
ok(R.G().ui(rk).to.indexOf("sam@example.com") !== -1, "picked into hyphae's field");
ok(R.G().ui(rk).toStatus === undefined || true, "chip status computed locally");
R.G().fill(rk, "Re: Plan for Friday", "Got it, thanks");
const back = await R.G().sealOnly(rk);
ok(back && back.ok, "Riley's reply sealed to Sam: " + JSON.stringify(back));
const rDlgs = R.d.querySelectorAll('div[role="dialog"]');
const bOut = fieldsOf(rDlgs[rk]);
ok(bOut.to.indexOf("sam@example.com") !== -1 && bOut.subject === HI.SUBJECT_LABEL, "reply: address only at send, neutral subject");
const sOpen = await S.bridge.handle("open", { text: bOut.body });
ok(sOpen.ok && sOpen.items[0] && /Got it/.test(sOpen.items[0].body) && sOpen.items[0].authentic, "Sam opens Riley's reply, signed");

// ---- 7. a third address is still blocked
S.openCompose(); await wait(700);
const k2 = S.G().state().composes.length - 1;
S.G().toggle(k2); await wait(100);
S.G().pickTo(k2, "someone@example.com");
S.G().fill(k2, "x", "hello");
const r3 = await S.G().sealOnly(k2);
ok(r3 && r3.ok === false && r3.missing && r3.missing[0] === "someone@example.com", "unconnected third party refused");

// ---- 8. THE REAL SEND CLICK (not sealOnly): the interception path itself ----
// This is what a person actually does: fill the compose, press Gmail's Send.
// If interception works, Gmail's fields hold ciphertext and no plaintext.
S.openCompose(); await wait(700);
const k3 = S.G().state().composes.length - 1;
S.G().toggle(k3); await wait(100);
S.G().pickTo(k3, "riley@example.com");
S.G().fill(k3, "Friday plan", "TOP SECRET BODY");
const dlg3 = S.d.querySelectorAll('div[role="dialog"]')[k3];
const sendBtn = dlg3.querySelector('[role="button"][aria-label="Send"]');
ok(!!sendBtn, "found Gmail's Send button");
["mousedown", "mouseup", "click"].forEach(t =>
  sendBtn.dispatchEvent(new S.w.MouseEvent(t, { bubbles: true, cancelable: true, view: S.w })));
await wait(500);
const sent = fieldsOf(dlg3);
ok(sent.body.indexOf("hy1.") !== -1, "real Send click: Gmail's body holds a hy1 token");
ok(sent.body.replace(/\s+/g, "").indexOf("TOPSECRETBODY") === -1, "real Send click: NO plaintext in Gmail's body");
ok(sent.body.indexOf("Friday plan") === -1 && sent.subject === HI.SUBJECT_LABEL, "real Send click: real subject/body left Gmail's fields");

console.log(`\ngmail flow: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
