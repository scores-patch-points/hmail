# CORE-WIRING — hooking up `contacts/core.js`

Nothing outside `extension/contacts/` was edited. `core.js` is the model only: no DOM, no
`chrome.*`, no network. Its full API contract is the comment at the top of the file.
Run the tests: `node extension/contacts/core.test.mjs` (153 checks).

## The few lines the owner needs

**1. Load it** (UMD, registers `HyContacts` on `self`; the repo is `"type": "module"`, so in Node
`import "./contacts/core.js"` and read `globalThis.HyContacts`, as `invite/sim.mjs` does):

```js
// background.js (service worker)
importScripts("contacts/core.js");
// manifest.json: add "contacts/core.js" to the content-script list only if a content script
// needs it; prefer asking the worker by message (below), like get-circles.
```

**2. Create one store in the worker** (chrome.storage.local is not `{get(key)->value}`, so wrap it):

```js
const contacts = HyContacts.create({ storage: HyContacts.fromChrome(chrome.storage.local) });
```

State lives under the single key `hyContacts` (override with `{ key }`). It never reads or
writes `circles`.

**3. Tell it which circles are held — ids only, after every change to `circles`:**

```js
async function syncHeld() {
  const { circles } = await chrome.storage.local.get("circles");
  await contacts.setHeldCircles(Object.keys(circles || {}));   // kids, never keys
}
// call at worker start, after merge-circles adds one, and when a circle is removed
```

`status` is computed on every read from that list, so a circle arriving by hand-off flips
`needs-key` to `ready` with no other bookkeeping.

**4. Expose it by message** (suggested; the importer and sheet only need the store):

```js
// background.js onMessage, sender.id === chrome.runtime.id only
if (msg.hyphae === "contacts") {
  const ops = ["all", "byEmail", "search", "importGoogle", "importMatrix", "link", "setHeldCircles", "remove"];
  if (ops.includes(msg.op)) {
    contacts[msg.op](...(msg.args || []))
      .then((r) => send({ ok: true, result: r }), (e) => send({ ok: false, code: e.code || "error", message: String(e.message) }));
    return true;
  }
}
```

`link()` rejects with `Error.code` of `not-found | invalid | conflict | limit` and changes nothing
when it rejects — surface those to the user; do not retry blindly.

**5. Feed it:**
- Google importer → `contacts.importGoogle([{ name, emails, source }])`
- Matrix side → `contacts.importMatrix([{ mxid, displayName, emails? }])` with the people the
  user actually shares a room with / has a DM with. Only pass `emails` that the user's own
  contact list or the Matrix account's verified 3PIDs gave you.
- Gmail compose: `contacts.byEmail(toAddress)` → if `status === "ready"` offer encrypted send
  with `circleKid`. The adapter still reads the key from the existing `get-circles` path; the
  contacts store never has it.

## What status `ready` does and does NOT guarantee

`ready` means exactly: **the contact has a Matrix link, and `circleKid` names a circle whose key
this device currently holds.** It is a statement about a key on this device.

It does **not** mean:

- **The person's identity was verified.** Anyone can give a Matrix display name or claim an
  email. A Matrix account joined to an email by a shared address was joined on a *claim*, not
  on proof the same human controls both.
- **The email address belongs to that Matrix account**, or that the Google entry and the
  Matrix account are one person, beyond "a shared normalised email or an explicit `link()`".
- **The person holds the key.** `circleKid` records which circle *you* assigned to them; the
  other side may never have received it, or may have lost it. Keys travel out of band, so
  nothing here can see them arrive.
- **Only that person can read it.** A circle key is shared by everyone who holds it. Sealing to
  circle K reaches every holder of K, so one contact "ready" via a group circle exposes the
  message to the whole group.
- **The contact is addressable.** The contract defines `ready` by key + Matrix link alone, so a
  Matrix-only contact with a held circle is `ready` with `addressable: false`. Check
  `addressable` before filling a To: field.
- **The key is still safe** — nothing about revocation or compromise is tracked.

Other limits worth knowing:
- Gmail dot/plus aliases are not collapsed (a missed merge is a duplicate row; a wrong merge
  would send to the wrong person). `link()` merges two rows when the user says so.
- Imports only add emails; `link(id, { removeEmail })` removes one. A contact whose address
  changed in Google will keep the old one until removed.
- `remove()` is not sticky: the next import brings the person back.
- Re-pointing or unlinking a contact's Matrix account clears its `circleKid`, because the circle
  was assigned to that identity.
- Operations are serialised per store, but chrome.storage has no transactions; do imports from
  the worker only, not from several contexts at once.
- 20,000 contacts / 10 emails per contact are hard caps; `chrome.storage.local` has its own
  quota (10 MB without `unlimitedStorage`), and a failed write rejects with nothing changed.
