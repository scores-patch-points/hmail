# Wiring — the small hook-ups the owner of the other files needs

Nothing outside `extension/invite/` was edited. The prototype is pure: strings in, strings and
state out. Load order for classic scripts / `importScripts`:

```
crypto.js  →  invite/p256.js  →  invite/spake2.js  →  invite/hyinvite.js
```

Each is UMD and registers `HyCrypto`, `HyP256`, `HySpake2`, `HyInvite` on `self`. In Node ESM
(the repo is `"type": "module"`) `import` them for their side effect and read the globals — see
`sim.mjs`.

## 1. Where the Agent lives

`HyInvite.Agent` holds the identity's private keys. It belongs in **`background.js`** (the
service worker), not in `gmail.js`/`content.js`, so the page-facing adapter still never holds or
sends a key. The adapter talks to it by message, exactly as `get-circles` already works.

```js
// background.js (sketch)
importScripts("crypto.js", "invite/p256.js", "invite/spake2.js", "invite/hyinvite.js");
let agent;
async function getAgent() {
  if (agent) return agent;
  const d = await chrome.storage.local.get("invite");
  const identity = d.invite ? d.invite.identity : await HyInvite.newIdentity(await displayName());
  agent = new HyInvite.Agent({ identity, state: d.invite && d.invite.state });
  return agent;
}
async function save() { await chrome.storage.local.set({ invite: { identity: agent.identity, state: agent.state } }); }
```

**Create the Agent once.** Memoize the *promise*, not the result: two cold-start callers that
each build their own Agent get two copies of `state`, and the try budget (and the "answered
once" rule) only hold per Agent. Mutating calls (`acceptHello`, `acceptWelcome`, `join`) are
serialised inside one Agent; they cannot be made safe across two.

`state` and `identity` are plain JSON (test F3 round-trips them). Call `save()` after every
mutating call: `createInvite`, `acceptHello`, `join`, `acceptWelcome`, `confirmSafetyNumber`,
`open` (it records `seen`). Strongly preferred hardening: keep the two private keys as
non-extractable `CryptoKey`s in IndexedDB and have `Agent._priv()` read them from there instead
of importing the JWKs — a ~10-line change in `hyinvite.js`, left alone because storage is yours.

## 2. Messages the background should expose

| `hyphae:` message | Calls | Returns to the page |
|---|---|---|
| `invite-create {to, mode}` | `agent.createInvite` | `{ iid, email:{subject,body}, code }` — `code` goes only to hyphae's own panel |
| `invite-read {text, from}` | `agent.readInvite` | `{ invite:{iid,mode,claimsToBe,from,expires}, alreadyPaired?, keyChange? }` |
| `invite-join {iid, code, label}` | `agent.join` | `{ hello }` — put into a Gmail reply draft, user presses Send |
| `hello-accept {text}` | `agent.acceptHello` | `{ ok, welcome?, to, alarm? }` — welcome goes into a draft **addressed to `to`** (the invited address), never to the hello's `From` |
| `welcome-accept {text}` | `agent.acceptWelcome` | `{ ok, alarm? }` |
| `contacts` / `contact-for {addr}` | `agent.state.contacts`, `contactForAddress` | for the strip |
| `bind-address {fp, addr}` | `agent.bindAddress` | on R's side a contact has **no** address until the person confirms "this key is that address"; `contact.addressClaims` lists what the mail headers claimed |
| `safety {fp}` / `safety-confirm {fp, typed}` | `safetyNumber`, `confirmSafetyNumber` | |
| `seal-to {fp, text, allowUnverified?}` | `sealTo` (+ `HyInvite.sealedBody`) | token text |
| `open {text}` | `agent.open` | `[{ ok, authentic, from, ts, body, reason, seenBefore }]` |
| `guard-send {recipients, subject, body, sealRequired}` | `agent.guardSend` | `{ allow, blocks, warns }` |

None of these returns a key. `invite-create` returns the code *to hyphae's own UI* only; the
adapter must never put it in a Gmail field (`guardSend` backs this up).

## 3. `gmail.js` (the adapter)

1. **Send path.** Before the existing `bypass` re-fire, call `guard-send`. If `allow` is false,
   do not send and show the reason (`blocks[].code` → plain words from GOOGLE-WRAPPER.md).
2. **Sealing.** Replace "seal to the active circle" with one `seal-to` per recipient who is a
   contact (pass `subject` — the text the person typed); join with `HyInvite.sealedBody(tokens)`
   so the mail starts with prose (spam).
   **Subject:** set Gmail's Subject field to `HyInvite.SUBJECT_LABEL` and keep the typed
   subject in hyphae's editor. There is no sealed subject in the adapter today, and `guard-send`
   blocks (`subject-readable`) any sealed mail whose subject is not the label.
   **Transport:** only mail is needed. `hello`/`welcome` are strings the adapter drops into a
   Gmail draft; there is no dependency on a chat or on Matrix.
3. **Recipient state.** On chip change call `contact-for` per address; drive the strip states in
   GOOGLE-WRAPPER.md. For an unknown recipient: *Invite* → `invite-create`, open a new compose
   with `email.subject`/`email.body`, show the code in hyphae's panel. Hold the message locally.
4. **Opened message.** Scan for invite-family tokens (`HyInvite.parseTokens` — it already
   strips `>` quoting and whitespace): `inv` → show the Join bar (`invite-read`); `hello` →
   prompt S, then `hello-accept` and draft the welcome to the returned `to`; `welcome` →
   `welcome-accept`. These are machine messages: render them collapsed under a "hyphae setup" line.
5. **Reveal.** Use `open` for tokens of pairwise circles and show `authentic`. If the page still
   uses `HyCrypto.revealSegments` directly, it will see the signed JSON envelope; patch it to
   call `HyInvite.unwrap(plain)` and **do not** label the result with a sender (unwrap does not
   verify).

## 4. `content.js` / popup / bridge

* **Do not call `HyCrypto.scan` / `hasToken` / `revealSegments` on a whole mail body directly.**
  `crypto.js`'s token regex is quadratic on a body of repeated `hy1.` (about 32 s at 160 KB —
  a sender can wedge the tab). Pre-filter with `HyInvite.hy1Tokens(text)` (linear, returns
  `{i, len}` of well-formed tokens) and hand only those slices to `crypto.js`, or send the text
  to the background and use `agent.open()`, which already does.

* `content.js` generic reveal: one patch point, same `unwrap` call as above, so sealed fields on
  non-Gmail sites show the body, not JSON.
* `popup.html/js`: a contacts list with status badges (`verified-code`, `verified-sas`,
  `unverified`), a "check the number" dialog (`safety` + `safety-confirm`), and an alarms list
  (`state.alarms`: `code-used-twice`, `unsolicited-welcome`, `multiple-responders`).
* `bridge.js` / hub: pair circles are ordinary `{kid, name, key}` objects. If you want the
  existing "Circles" list to show them, push `contact.circle` through the existing
  `merge-circles` message; the hub does not need to understand envelopes.

## 5. `drive/*`

`sealFile(fp, {name, mime, bytes})` returns one text token containing the file in the signed
envelope; `open` returns `kind:"file"`, `name`, `mime` and the bytes as base64url in `body`.
For Drive: upload the token as `<random>.hy1` (and keep the real name inside the envelope).

## 6. manifest

No new permission is needed. Add the three `invite/*.js` files wherever `crypto.js` is already
listed (service worker `importScripts`; content-script lists only if the page layer must call
`unwrap`, which needs none of the curve code — only `hyinvite.js` plus its dependencies).

## 7. What the owner must NOT do

* Do not put `code` into any Gmail field or draft, ever — including "to help the user".
* Do not fall back from code mode to unverified mode silently when a join fails (A10.4).
* Do not show an invite's `claimsToBe` as the contact's name.
* Do not seal to an `unverified` contact without the explicit, labelled override.
* Do not poll or "preview" an invite URL: there is none, and there must not be one.
