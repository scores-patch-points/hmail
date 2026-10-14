# What hyphae is for

**Encryption that lives outside the online service.** People keep using the collaboration tools
they already use — Gmail, Google Drive, any web form or editor — but what they write is sealed
on their own device before the service ever receives it. The service stores and delivers
ciphertext; only the people you chose can read it. The collaboration still happens through the
service (you still share a Drive file with Google's Share dialog); the *keys* never do.

## The layers

| Layer | What it does | State |
|---|---|---|
| **Seal** | Text in any field and files in Drive are encrypted on-device (AES-256-GCM, per-circle key). | Text: working, Gmail adapter. Drive files: seal on upload, open/edit/re-seal in a hyphae viewer. |
| **Identity** | One hyphae account (Matrix on hyphae.social, email-confirmed, resettable). The extension does nothing until you are signed in. | Sign-in / create / reset built in the extension, tested against a homeserver double only, not live. |
| **Circles** | The key a group shares. For now one person, one personal circle; later invitations over end-to-end encrypted Matrix. | Personal circle works; invites later. |
| **Awareness** | When encryption is on, the whole page changes (lavender frame, "hyphae · encrypted" tab, focus rings), on any site. A tripwire says if the page sent your text to a third party, or if keystroke listeners / session recorders are present. | Built; unverified against live sites. |
| **Where it may run** | Only in browsers that do not report to Google, Microsoft or similar. | Heuristic denylist on browser brands; Brave recognised. |
| **Delivery** | Every push to main publishes a signed release; installed copies verify the signature and update themselves. | Built; needs the one-time folder grant (or a native helper / Web Store for one click). |
| **Chat** | Not reinvented: Element, signed in to the same account. | Button opens hosted Element. |

## What it cannot do (said plainly)
- Google Docs / Sheets / Slides are edited on Google's servers, so they cannot be sealed. Use files.
- A page's own scripts can read what you type before it is sealed. The tripwire reports what it
  can observe; it cannot see other extensions, the browser, or the operating system.
- Losing a circle key loses the content. There is no server-side recovery by design.
- "Private browser" cannot be proven from inside an extension; the check is a denylist.

## Next, in order
1. Prove sign-in / account creation / reset against the live homeserver with a real account and the TOTP gate.
2. Invitations: a second person joins a circle over Matrix, reads what you share via Google.
3. Native helper or Web Store release for true one-click updates.
4. Real-time collaborative text (sealed documents edited by several people) without Google Docs.
5. The same viewer/editor for more file types, and a sealed-files list across devices.
