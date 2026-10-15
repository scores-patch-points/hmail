// End-to-end flow test for the plain-field path in content.js, against a stand-in
// page (jsdom). This is the path the popup's "Seal this field" uses on any site:
//   seal the focused field -> the field holds a hy1 token and is marked sealed ->
//   peek reports the token -> reveal opens it back into the page.
//   node extension/test/field.flow.test.mjs     (needs jsdom; npm i -D jsdom)
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
nreq(path.join(ext, "crypto.js"));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

const PAGE = `<!doctype html><html><body>
  <input id="subject" type="text" />
  <textarea id="body"></textarea>
  <div id="content" contenteditable="true"></div>
  <div id="inbox"></div>
</body></html>`;

const dom = new JSDOM(PAGE, { url: "https://example.com/", pretendToBeVisual: true, runScripts: "outside-only" });
const w = dom.window, d = w.document;
Object.defineProperty(w, "crypto", { value: webcrypto });
w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
// jsdom lacks two things content.js relies on: a meaningful innerText and
// isContentEditable. Add thin stand-ins so the real code path runs.
Object.defineProperty(w.HTMLElement.prototype, "innerText", {
  get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true,
});
Object.defineProperty(w.HTMLElement.prototype, "isContentEditable", {
  get() { return this.getAttribute && this.getAttribute("contenteditable") !== null; }, configurable: true,
});
// what the popup's inject() provides: crypto.js + content.js in the isolated world
w.chrome = {
  runtime: { lastError: null, onMessage: { addListener() {} }, sendMessage(_m, cb) { if (cb) setTimeout(() => cb(null), 0); } },
  storage: { local: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); } } },
};
w.eval(fs.readFileSync(path.join(ext, "crypto.js"), "utf8"));
w.eval(fs.readFileSync(path.join(ext, "content.js"), "utf8"));

const H = w.HyCrypto, hy = w.__hyphae;
ok(!!H && !!hy, "crypto.js and content.js loaded into the page");

(async () => {
  const circle = H.newCircle("personal");
  ok(H.parseShare(H.shareString(circle)) !== null, "circle round-trips through its share string");

  // ---- 1. seal the focused field (input) -------------------------------------
  const input = d.getElementById("subject");
  input.value = "the launch code is 4392";
  input.focus();
  const r1 = await hy.sealFocused(circle);
  ok(r1 && r1.ok, "sealFocused reported ok: " + JSON.stringify(r1));
  ok(/^hy1\./.test(input.value) && /~$/.test(input.value), "the field now holds a sealed token: " + input.value.slice(0, 24) + "…");
  ok(input.value.indexOf("the launch code") === -1, "no plaintext left in the field");
  ok(input.hasAttribute("data-hyphae-sealed"), "the field is marked sealed (data-hyphae-sealed)");
  ok(input.value.indexOf("~") !== -1 && H.hasToken(input.value), "the token is well-formed");

  // ---- 2. a field that already holds a token is marked on scan ---------------
  const area = d.getElementById("body");
  area.value = "hello " + input.value;
  hy.markFields(d.body);
  ok(area.hasAttribute("data-hyphae-sealed"), "a field found by markFields is marked sealed");
  ok(!input.hasAttribute("data-hyphae-sealing"), "the transient sealing marker is gone");

  // ---- 3. peek reports a real fragment of the ciphertext ---------------------
  const peeked = hy.peek();
  ok(typeof peeked === "string" && /^hy1\./.test(peeked) && peeked.indexOf("…") !== -1, "peek() returns a real ciphertext fragment: " + peeked);
  ok(peeked && input.value.indexOf(peeked.replace("…~", "")) === 0, "peek matches the sealed field");

  // ---- 4. reveal opens it back into the page (any site) ----------------------
  const inbox = d.getElementById("inbox");
  inbox.textContent = "note: " + input.value + " end";
  await hy.reveal({ [circle.kid]: circle });
  const opened = inbox.querySelector("[data-hyphae]");
  ok(!!opened, "reveal opened the token into a hyphae span");
  ok(opened.shadowRoot === null, "the opened text lives in a closed shadow root (page scripts can't read it)");
  ok(inbox.textContent.indexOf("note: ") !== -1 && inbox.textContent.indexOf(" end") !== -1, "the surrounding text is kept around the opened span");
  ok(inbox.textContent.indexOf("hy1.") === -1, "the raw token is gone from the page text");

  // ---- 5. a different circle cannot open it ----------------------------------
  const other = H.newCircle("someone-else");
  const inbox2 = d.createElement("div");
  inbox2.textContent = input.value;
  d.body.appendChild(inbox2);
  await hy.reveal({ [other.kid]: other });
  ok(!inbox2.querySelector("[data-hyphae]") && inbox2.textContent.indexOf("hy1.") !== -1, "a foreign circle leaves the token locked");

  // ---- 6. seal a contenteditable (uses getSelection + execCommand insertText) --
  const ce = d.getElementById("content");
  ce.textContent = "secret note";
  ce.setAttribute("tabindex", "0");
  ce.focus();
  if (d.activeElement !== ce) Object.defineProperty(d, "activeElement", { get() { return ce; }, configurable: true });
  d.getSelection = function () {
    return { rangeCount: 1, isCollapsed: false, anchorNode: ce.firstChild || ce,
      toString() { return ce.textContent; } };
  };
  d.execCommand = function (cmd, _ui, val) {
    if (cmd === "selectAll") { this._sel = ce; return true; }
    if (cmd === "insertText") { if (this._sel === ce) { ce.textContent = ""; this._sel = null; } ce.textContent += val; return true; }
    return true;
  };
  ce.focus();
  const r6 = await hy.sealFocused(circle);
  ok(r6 && r6.ok && /hy1\./.test(ce.textContent), "a contenteditable seals too: " + JSON.stringify(r6));
  ok(ce.hasAttribute("data-hyphae-sealed"), "the editor is marked sealed");

  console.log(`\nfield flow: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
