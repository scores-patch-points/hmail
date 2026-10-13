# SHEET-WIRING — hooking up `contacts/sheet.js`

Nothing outside `extension/contacts/` was edited. `sheet.js` is a classic content script for
`mail.google.com`; it builds a closed-shadow-root panel (createElement/textContent only, no
icons) and talks to the store only through `window.__hyphaeContactsPort`.

Tests: `node extension/contacts/sheet.test.mjs` (133 checks, no DOM).
Visual check: serve `extension/contacts/` over http and open `sheet.test.html?open=1&n=40`
(`?hook=0`, `?empty=1`, `?noport=1`, `?autofile=1` change what the stub does).

## 1. Load it — same isolated world as `gmail.js`

`gmail.js` is not a static content script today; `background.js` injects it. Add
`"contacts/sheet.js"` after `"gmail.js"` in all three lists, and the port file (section 2)
before it:

```js
// background.js:17   (executeScript, on the toolbar click)
files: ["crypto.js", "content.js", "gmail.js", "contacts/port.js", "contacts/sheet.js"]
// background.js:166  (registerContentScripts, auto mode)
js: ["crypto.js", "content.js", "gmail.js", "contacts/port.js", "contacts/sheet.js", "auto.js"],
// popup.js:66        (executeScript from the popup)
files: ["crypto.js", "content.js", "gmail.js", "contacts/port.js", "contacts/sheet.js"]
```

If the owner moves to a static manifest entry instead:

```json
{ "matches": ["https://mail.google.com/*"],
  "js": ["contacts/port.js", "contacts/sheet.js"], "run_at": "document_idle" }
```

`sheet.js` does nothing off `mail.google.com`. It only installs `window.__hyphaeContacts` and
`window.__hyphaeContactsLogic`; nothing is drawn until `open()`.

## 2. The port over `chrome.runtime`

`contacts/port.js` (not written here — it is the owner's, one small file). The message shape is
the one in `CORE-WIRING.md` §4 (`{ hyphae: "contacts", op, args }` →
`{ ok, result }` / `{ ok: false, code, message }`):

```js
(function () {
  if (location.hostname !== "mail.google.com" || window.__hyphaeContactsPort) return;
  function call(op, args) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage({ hyphae: "contacts", op: op, args: args || [] }, function (r) {
        if (chrome.runtime.lastError || !r) return reject(new Error("unavailable"));
        if (r.ok) return resolve(r.result);
        var e = new Error(r.message || "failed"); e.code = r.code || "error"; reject(e);  // sheet.js reads e.code
      });
    });
  }
  window.__hyphaeContactsPort = {
    all:             function ()         { return call("all"); },
    search:          function (q)        { return call("search", [q]); },
    link:            function (id, patch){ return call("link", [id, patch]); },
    importGoogleCsv: function (text)     { return call("importGoogleCsv", [text]); },
    circles:         function ()         { return call("circles"); }
  };
})();
```

Worker side (`background.js`, `sender.id === chrome.runtime.id` and `sender.tab` only):

| port call | op | worker does |
| --- | --- | --- |
| `all()` | `all` | `contacts.all()` |
| `search(q)` | `search` | `contacts.search(q)` |
| `link(id, patch)` | `link` | `contacts.link(id, patch)` — the sheet sends only `{ circleKid }` or `{ email }` |
| `importGoogleCsv(text)` | `importGoogleCsv` | `contacts.importGoogle(HyGoogleContacts.parseExport(text))` → `{ added, merged, skipped, conflicts }`. **Not in `CORE-WIRING.md`'s ops whitelist: add it.** Parse in the worker, never in the page. |
| `circles()` | `circles` | **project to labels only**: `Object.values(circlesByKid).map(c => ({ kid: c.kid, name: c.name }))`. The stored circle objects carry `key`; sending one whole would hand a key to the page. |

Return only what the sheet needs. The sheet copies a whitelist of fields out of every record
(`tidyOne`) and drops anything else, but do not rely on that to protect a key — never put one in
the reply.

## 3. The menu item (`gmail.js`, in the header button's menu)

Beside `compose` in the menu builder (around `gmail.js:748`):

```js
var contactsBtn = document.createElement("button");
contactsBtn.type = "button"; contactsBtn.textContent = "Contacts";
btns.appendChild(contactsBtn);
contactsBtn.addEventListener("click", function () {
  close();
  if (window.__hyphaeContacts) window.__hyphaeContacts.open();
});
```

`open()` resolves once the list has loaded, `close()` closes it, `refresh()` reloads after the
store changes (call it from an import or a circle hand-off if the sheet is open).

## 4. `composeTo` — the hook `gmail.js` still needs

`window.__hyphaeContacts.composeTo(contact)` calls
`window.__hyphaeGmail.composeTo(email, { circleKid })` when it exists. The second argument is
there because **`toggle()` seals to the *active* circle**; without it a message "to Maya" would
be sealed to whichever circle happens to be active and reach a different set of people.

Without the hook the sheet opens Gmail's compose (`div[gh="cm"]`, pressed with mousedown, mouseup,
click as `fire()` does), copies nothing, and tells the user, in text, which address to add.

Sketch for `gmail.js` (it reuses `wantEncrypt`, `fire`, `track`, `setNative`, `recipients`):

```js
var wantTo = null;   // { email, kid } set by composeTo, consumed by track()

// in window.__hyphaeGmail = { ... }
composeTo: function (email, opts) {
  var open = document.querySelector('div[gh="cm"]') ||
             document.querySelector('div[role="button"][aria-label="Compose"]');
  if (!open) return Promise.reject(new Error("no-compose-button"));
  var kid = opts && opts.circleKid;
  if (kid && !circles[kid]) return Promise.reject(new Error("key-not-held"));  // do not fall back to another circle
  if (kid) activeKid = kid;
  wantEncrypt = true;
  wantTo = { email: String(email || "").trim().toLowerCase() };
  fire(open);
  return Promise.resolve(true);
},

// in track(), after the existing `if (wantEncrypt && activeCircle()) { ... toggle(st); }`
if (wantTo) { fillTo(st, wantTo.email); wantTo = null; }

function fillTo(st, email) {
  var to = st.root.querySelector('input[role="combobox"][aria-label*="To"], textarea[name="to"]');
  if (!to) return false;
  to.focus();
  setNative(to, email);
  // Gmail turns the text into a recipient chip on Enter / comma / blur.
  ["keydown", "keyup"].forEach(function (t) {
    to.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
  });
  return true;
}
```

The selector and the chip-commit are the unverified part (see below). `track()` runs when the
compose window appears, so `fillTo` may need a short retry (the To field mounts a beat later).

## 5. Compose-line annotation (`annotate`)

```js
window.__hyphaeContacts.annotate(["maya@x.org", "Dev <dev@y.org>"])
// → [{ email, name, status, word, label }, …]
//   label: "to Maya Lin (ready)", "to Dev Patel (needs key)", "to a@b.co (not in contacts)"
window.__hyphaeContacts.annotateText(emails)   // "to Maya Lin (ready) · to Dev Patel (needs key)"
window.__hyphaeContacts.annotateAsync(emails)  // waits for the first load
```

`annotate` is synchronous and reads the sheet's cache. On a cold cache it answers "not in
contacts" and starts a load, so the next call is warm. Call `refresh()` (or `annotateAsync`) once
when the compose window opens, then `annotateText(recipients(root))` on each recipient change.
Words: `ready`, `needs key`, `matrix only`, `google only`, `not in contacts`.

## 6. What the sheet sends the port, exactly

| user action | call | args |
| --- | --- | --- |
| open / refresh | `all()`, `circles()` | none |
| type in search (after 140 ms) | `search(q)` | the typed text; the store's ids are *added* to the local filter's |
| Link a key | `link(id, patch)` | `{ circleKid: "<kid>" }` |
| Add an email address | `link(id, patch)` | `{ email: "<address>" }` |
| Import | `importGoogleCsv(text)` | the file's text; only `.csv` / `.vcf` / `.vcard`, ≤ 25 MB |

It never calls anything with a key, token or message, and receives none (a record's unknown
fields are dropped on arrival). "Invite to hyphae" calls nothing at all.

## 7. Not verified inside real Gmail

- `window.__hyphaeContacts.open()` has not been run on `mail.google.com`. Rendering, keyboard
  navigation, focus trap, the key picker, add-email, import and both compose paths were checked
  on `sheet.test.html` (a stand-in page) in a real browser pane, against a stub port.
- That Gmail's own document-level key handlers (`c`, `/`, `j`, `k`, `g` then `i`…) do not see
  keys typed in the sheet. The host stops propagation in the bubble phase, which beats handlers
  on `document` bubble but not a capture-phase handler on `window`/`document`. Check by typing
  `c` and `/` in the search box on Gmail.
- That Gmail does not steal focus back from the sheet (the sheet re-focuses on `focusin`, which
  could fight Gmail's own focus handling).
- That the `focusin` trap and the transparent click-away layer do not interfere with Gmail's
  compose window; the panel sits at `top: 64px` to clear Gmail's header, a number measured from
  nothing but Gmail's present layout.
- Trusted Types: no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval` or `new Function` in
  `sheet.js` (asserted by the test); not run under Gmail's actual policy.
- The `composeTo` hook above does not exist yet. `fillTo`'s selector and the chip commit are a
  guess from Gmail's markup, not a measurement.
- `port.js`, the worker ops and the manifest/inject lines are not written or run; the sheet has
  only met a stub port.
- The look: dark panel, lavender text and the h·y overlay are hand-set from the brief's colours
  and checked for contrast by the test (18 pairs, all ≥ 4.5:1), not compared to the live header
  button.
- Screen-reader behaviour was not tried with a real reader; only the roles/labels are in place
  (`dialog`/`aria-modal`, `grid`, `aria-sort`, `aria-pressed`, `aria-live` status lines).
