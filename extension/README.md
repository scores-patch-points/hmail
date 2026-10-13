# Hyphae — seal anything you write

A browser extension that encrypts text in **any field on any site** and decrypts what
your circle sealed, wherever it shows up. It is a layer, not an app: Gmail, a comment
box, a chat, a form, a note — if it stores text, it can hold a sealed token.

No Google OAuth, no API, no account with the site. It runs only when you ask it to,
on the tab you ask it on (`activeTab`), and never reads passwords.

## Try it (Brave / Chrome)

1. `brave://extensions` (or `chrome://extensions`) → turn on **Developer mode**.
2. **Load unpacked** → choose this `extension/` folder.
3. Click the Hyphae icon → **Circles & keys** → create a circle.
4. Click into any text field → **Seal field** (or `Alt+Shift+S`).
   Select part of the text first to seal only that part.
5. On a page showing sealed text → **Reveal page** (or `Alt+Shift+R`).
6. To let someone read it, send them the circle's key (**Copy key**) over a channel you
   trust; they paste it under **Join a circle**.

## What a sealed token is

```
hy1.<circle id>.<iv>.<ciphertext>~
```

Plain ASCII, so it survives anything that stores text. AES-256-GCM under the circle key;
the circle id is bound in as additional data. Line-wrapped tokens (mail clients fold long
lines) still open.

## Built and tested (v0.1)

- Seal selection / whole field in `<input>`, `<textarea>`, and `contenteditable` editors.
- Refuses password fields.
- Reveal in page text, including content the page adds later; leaves editable areas alone;
  tokens for circles you don't hold stay as they are.
- Circles: create, share, join (key string).
- Checks run: roundtrip, wrong circle, line-wrap, tampering, re-labelling, mixed tokens,
  share string, fresh IV per seal (Node); focused-field seal on all field types, password
  refusal, reveal with locked + dynamic nodes (Brave).

## Not built yet

- **Matrix key delivery** — circles as Matrix rooms, keys arriving over E2EE so nobody
  pastes keys by hand. Today keys move out of band.
- **Per-site auto-reveal** — an opt-in `optional_host_permissions` grant per site, so
  sealed text opens without pressing the shortcut.
- **Overlay editor** — sites that autosave drafts (Gmail, Docs) send keystrokes before you
  seal. Safe use needs composing in Hyphae's own box and inserting only the token.
- **Files / images**, key rotation and removing a member, a Web Store listing.

## Honest limits

- A site that must *compute* on your text (search, spam filter, translation, live
  collaborative editing) can't do it on sealed text.
- Sealing hides content, not who talked to whom or when.
- Anyone with the circle key reads everything ever sealed to it; there is no revocation yet.
- Desktop browsers with the extension only; the same token in a phone app stays ciphertext.
