# hyphae — seal anything you write

A browser extension that encrypts text in **any field on any site** and decrypts what
your circle sealed, wherever it shows up. It is a layer, not an app: Gmail, a comment
box, a chat, a form, a note — if it stores text, it can hold a sealed token.

No Google OAuth, no API, no account with the site. It runs on every site by default — seal
with the popup or a shortcut, and it opens sealed text as pages load — and never touches
password fields. (Turn the off switch in the popup to run only where you invoke it.)

## Try it (Brave / Chrome)

1. `brave://extensions` (or `chrome://extensions`) → **Developer mode** on.
2. **Load unpacked** → choose this `extension/` folder.
3. hyphae icon → **Circles & keys** → create a circle.
4. Click into any text field → **Seal field** (`Alt+Shift+S`). Select part of the text first to
   seal only that part.
5. On a page with sealed text → **Reveal page** (`Alt+Shift+R`).
6. To let someone read it, give them the circle: either the key string (**Copy key**) or, better,
   through the hub (below).

## Sealed token

```
hy1.<circle id>.<iv>.<ciphertext>~
```

Plain ASCII, so it survives anything that stores text. AES-256-GCM under the circle key; the
circle id is bound in as additional data. Line-wrapped tokens still open.

## Matrix is how people are connected (the hub)

The web app at `mail.hyphae.social/app/` holds your Matrix session (hyphae.social, or the
homeserver you point it at). Its **Circles** tab creates circles and gives a person access by
sending the circle's key in an end-to-end-encrypted Matrix DM; it also collects keys other
people sent you. A bridge content script — active on that one origin only — hands circles to
the extension. Keys only ever go page → extension; the extension never sends one back out and
never replaces a key it already holds.

## Activity ledger (opt-in, off by default)

Popup → **Activity ledger**. Three levels, each with its own key:

| Level | What it holds |
| --- | --- |
| receipts | that something happened, where, when (kind, host, time) |
| content | the detail behind a receipt (URL path, title) |
| summaries | what the Fold made of it — written by the Fold, not by the extension |

Modes: **seal-only** (default: only hyphae's own seal/reveal actions) and **visits** (also the
pages you open; needs the optional `tabs` permission, asked for only when you choose it). Query
strings and fragments are never kept. Every event is sealed to its level's key the moment it is
captured, so the queue on this device is already ciphertext. There is a pause switch.

Sharing a level means giving someone that level's key. There is no revocation of a key already
given: to withdraw, a new key is made and given to the people who remain.

## Built and tested

- `crypto.js` — 8 checks in Node (roundtrip, wrong circle, line-wrap, tamper, re-label, mixed,
  share string, fresh IV).
- `content.js` — in Brave on a test page: partial/whole-field seal in input, textarea,
  contenteditable; password refused; reveal with locked + dynamically added content.
- `ledger-core.js` — policy defaults, URL minimization, opt-in text, pause, per-level sealing,
  readback, level keys that don't cross-open, queue cap (Node).
- Hub `circles-core.ts` — shapes, validation, merge never overwrites (esbuild → Node).

## Not tested / not built

- **Untested live:** the hub's Matrix send/receive between two real accounts, the bridge on the
  real origin, the popup and shortcuts in a loaded extension, and the optional-permission flow.
- **Not built:** moving the ledger queue into a personal EODB room (Matrix) and flushing it;
  the Fold reading and summarizing it; per-level sharing UI in the hub; page-text capture on
  listed sites (needs per-site grants); an overlay editor for sites that autosave drafts;
  files/images; a Web Store listing.

## Honest limits

- A site that must *compute* on your text (search, spam filter, translation, live co-editing)
  can't do it on sealed text. Sealing hides content, not who talked to whom or when.
- Anyone holding a circle or level key reads everything ever sealed to it.
- A key you've given out can't be un-given; withdrawing means a new key going forward.
- Desktop browsers with the extension only.
