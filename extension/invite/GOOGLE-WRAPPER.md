# Making this feel like a wrapper around Google Workspace

The goal as stated: hyphae should feel like a layer on Gmail, Drive and Docs — not a second
app — and inviting a Gmail-only person should happen *inside* the compose window you already
use. This file is the feasibility map and the exact words. It is deliberately conservative:
"possible" means a content script on the page can do it today with no Google OAuth and no
Google API; "fragile" means it depends on Google's DOM or on an undocumented-but-long-lived
endpoint; "no" means it is not available to an extension at all.

Nothing here has been run against a live Gmail or Drive account (this session was forbidden
from using real accounts). The cryptography is tested (`attacks.test.mjs`); the Google-page
claims below are design analysis, labelled as such.

## Principle

hyphae never sends mail and never calls a Google API. It fills Gmail's own compose window and
the person presses Gmail's own Send. That keeps Google's account permissions out of it (no
OAuth scope to be phished for), and it means an "invite" is, from Google's point of view, an
ordinary email the user wrote.

## Feasibility by surface

| Surface | Write (S seals) | Read (R opens) | Status | Notes |
|---|---|---|---|---|
| **Gmail compose** | content script; hyphae's own editor holds the plaintext, Gmail's field stays empty until Send | — | **possible today** (adapter exists) | Draft autosave never sees plaintext. `guardSend` runs on Send. **The subject is plaintext today**: the adapter does not seal it (see "The subject line" below). |
| **Gmail read** | — | in-place reveal in a closed shadow root under a hyphae strip | **possible today** | Gmail hard-wraps and splits a token across divs and quotes with `>`; the invite/hello parser and `crypto.js` both tolerate that (tests A2.6, F1). |
| **Gmail attachments** | encrypt the file before it reaches Gmail's uploader: intercept the `<input type=file>` / drop target, attach `name.hy1` | fetch the attachment through the page's own session, decrypt locally, offer a download | **fragile** | Doable with content-script interception; breaks when Gmail changes its uploader. Token form inflates ×1.33. Prototype seals files into the same envelope (`sealFile`, test F1: 200 KB). Not wired. |
| **Gmail search / preview / spam / smart reply / Gemini** | — | — | **no** | Ciphertext defeats server features by design. All-ciphertext mail is filed as Spam (observed), so every sealed mail and every invite starts with prose (`SEALED_NOTE`, the invite text). |
| **Drive upload** | intercept the picker/drop, upload `report.pdf.hy1` instead | "Open with hyphae" on a `.hy1` file: fetch the file with the page's session, decrypt, show in an overlay viewer or save | **fragile** | Names leak unless renamed (`file-7f3a.hy1`). No Drive preview, thumbnail, OCR or search of contents. Folder structure and sharing stay visible to Google. |
| **Drive sharing** | Google's own Share dialog, to R's address | — | **possible, not private** | Google sees *that* it was shared and with whom. Only the content is sealed. |
| **Docs** | hyphae's overlay editor outside the document; the Doc holds only the token, pasted as text | read the doc's export text (`/export?format=txt`, same-origin, session cookie) or the accessibility DOM; find tokens; decrypt into an overlay | **possible with an overlay editor; fragile** | Docs renders to canvas and merges edits on Google's servers: there is no field to seal in place. A token is opaque text, so two people typing into it garble it (GCM then refuses — fails closed). Comments, suggestions and version history hold ciphertext. |
| **Slides** | token in a text box; reveal overlay on top | export text / overlay | **fragile** | Thumbnails, present mode and mobile show the token. |
| **Sheets** | token per cell | export CSV and decrypt | **fragile, narrow** | Formulas, sort, filter, charts cannot compute on ciphertext. Use as a vault, not a spreadsheet. |
| **Calendar** | seal the description; keep the title generic | reveal on the event page | **possible, leaky** | Invitations are emailed by Google with the title and description; phone notifications show the token; attendees and times are visible. |
| **Meet chat** | the generic "seal this field" action on the chat box | page reveal | **possible** | A text box and a DOM list. Audio and video: **no**. |
| **Google Chat** | same as Meet chat | same | **possible** | Nothing in the invite flow depends on a chat transport. The invite, hello and welcome are plain strings carried by mail (or pasted into any channel); there is no hyphae chat to assume. |
| **Mobile apps** | — | — | **no** | No extension on Gmail for Android/iOS. A recipient who reads mail on their phone sees the sealed note. |
| **Account-level** (filters, forwarding, delegates) | — | — | **no** | Not touched, and not defended: a delegate or auto-forward sees ciphertext only, but sees all of it. |

## Where the "Invite to hyphae" control appears

In hyphae's strip above the compose body (the strip the adapter already draws), driven by
`contactForAddress()` for each recipient chip:

| Recipient state | Strip says | Actions |
|---|---|---|
| Verified contact | **Sealed to Priya.** | — |
| Known, not verified (no-code pairing) | **Priya has joined, but you haven't checked the number with them.** | *Check the number* |
| Several unverified answers to one invite | **More than one person answered this invite.** | *Check the numbers* (no sending until chosen) |
| No contact | **Priya isn't on hyphae yet, so can't open this.** | *Invite Priya to hyphae* · *Send without encrypting* (with its own confirm) |

*Invite* opens a **new Gmail compose window** pre-filled with the invite (To, Subject, Body) and
shows the one-time code in hyphae's own panel next to it. The person sends the invite with
Gmail's Send. The held message stays on S's device, sealed at rest, and is released only when
Priya has paired (and, in no-code mode, been verified).

The control must **not** appear when: no recipients yet; every recipient is a verified contact;
the message is not being encrypted. It must **block**, not warn, when the body is about to go as
plaintext to a verified contact (`plaintext-to-sealed-contact`).

## The subject line

**State of the world (verified by the adapter's owner): there is no sealed subject.** Whatever
is in Gmail's Subject field goes to Google as plaintext, and Gmail uses it for threading, search
and notification text. The design therefore does not assume it can be sealed. What it does:

* **Sealed subject, plain label.** Gmail's Subject field is set to a fixed label,
  `HyInvite.SUBJECT_LABEL` = `Private message (hyphae)`. The real subject the person typed
  lives in hyphae's editor and travels *inside* the sealed envelope (`sealTo(fp, text,
  {subject})`; it is signed with the rest; `open()` returns it as `subject`). The recipient's
  strip shows it above the body. Google sees only the label.
* **What that costs:** every sealed thread has the same subject, so Gmail threads them together
  and search cannot tell them apart; notification previews say only the label; there is no
  subject for the recipient to scan in the inbox list until hyphae reveals the thread.
* **Enforcement:** `guardSend` blocks a sealed mail whose subject is anything but the label
  (code `subject-readable`) unless the adapter passes `allowReadableSubject` after an explicit,
  worded confirmation. The invite email is the one mail that has a readable subject on purpose
  (it must be intelligible to someone without hyphae) and it contains nothing secret.
* **Not built:** the adapter has to set the label and carry the typed subject into hyphae's
  editor. Until it does, treat every subject as public.

## The words

These are literal. They are produced by `HyInvite.inviteEmail()` and covered by tests.

**Subject (code mode and no-code mode)**
> Sam wants to send you private messages (hyphae)

**Body, code mode**
> Sam has invited you to exchange private messages with hyphae.
>
> hyphae is a free browser extension (Chrome, Brave, Edge). It locks what Sam sends you so that
> Google, and anyone else who can see your mailbox, only ever sees scrambled characters.
>
> This email contains no password and no key, on purpose: anything in an email, Google can read.
>
> To set up:
> 1. Install hyphae. Search for "hyphae" in your browser's extension store, or go to https://hyphae.social/
> 2. Open this email again. hyphae will show a "Join" button on it.
> 3. Sam will tell you a short code by phone, in person or on Signal. Not by email, and not by any chat
>    that Google runs. Type it in when hyphae asks.
>
> If you were not expecting this, ignore it. Nothing happens unless you type in a code from someone you know.
>
> -- the part below is for hyphae, you do not need to read it --
> `hy1inv.1.…~`

In no-code mode step 3 reads: "hyphae will show you a 26-character number. Read it to Sam by
phone or in person and check that it matches theirs. Until you have done that, anyone who can
read your mailbox could be pretending to be one of you." and the closing line becomes "…ignore it,
and do not read any number to anyone who calls you about it."

**What S is told next to the code** (hyphae's own panel, never in the mail)
> Tell Priya this code by phone, in person, or on Signal:  **7K4M9-XQ2R5**
> It works once. After three wrong tries it stops working and you start again.
> Don't put it in an email, a text message, or any Google chat or doc.

**What R is told on opening the invite**
> **Someone sent you an invite to hyphae.**
> It says it's from "Sam". That is only what it says — hyphae can't check it.
> Only continue if Sam told you to expect this and gave you a code another way.
> *[ code ]*  *[ Join ]*

**What R is told after joining**
> **Waiting for Sam.** When Sam's hyphae confirms the code, you'll be connected.
> If a connection appears that you didn't set up, tell Sam by phone.

**Name of the new contact**: the person types it. The invite's claimed name is shown as a
muted "says they are Sam" and is never promoted to the label.

## What it can honestly not do

* It cannot hide that S emailed R, when, how often, or how big.
* It cannot make Google's server features work on sealed content: search, preview, translate,
  spellcheck, smart reply, live co-editing, "ask Gemini about this doc".
* It cannot defend a recipient on a phone or a locked-down browser with no extensions.
* It cannot verify who a person is. It can verify that the human at the other end of the second
  channel knows the code. If a phisher is on that channel, the phisher is the contact.
* Every Gmail DOM selector is a bet on Google not changing its markup; the hyphae strip should
  fail *closed* (refuse to send, say why) when it cannot find what it needs.
