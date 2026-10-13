# Verdict — is the Gmail-user invite secure?

**Short answer.** Against the adversary the project cares most about — Google and anyone who can
read or rewrite the mailbox — the *code mode* design keeps content unreadable and refuses forged
or relayed pairings, **provided the one-time code really travelled by a channel that adversary
cannot read**. It is not secure against a person on that second channel who is lying, and the
no-code fallback is secure against a passive reader but not against an active one until two
people compare a number. Nothing here hides who wrote to whom.

The prototype is a *prototype*: its SPAKE2 and its elliptic-curve arithmetic are hand-written,
variable-time and unaudited. The tests below show it behaves as designed under every attack
the author could construct and under one independent reviewer's attempt (see "Review"); they do
not show it is free of flaws a cryptographer would find. The first build **did** have breaks
the author's own suite missed (below) — which is the argument for the audit, not against it.

## Result of the attack suite (`node attacks.test.mjs`, full run)

| | played | outcome |
|---|---|---|
| Attacks on the prototype (A1–A10, fuzz, rate/MITM measurements, review regressions R1–R6) | **44** | **44 defended, 0 succeeded** |
| Accepted limits (attack succeeds by design; detection asserted) | 5 | 5 succeed; 4 asserted *detected*, 1 *not detectable* (A10.6) |
| Controls: weaker designs the same harness must break | 6 | 6 broken — the harness can break things |
| Property checks the attacks rely on | 11 | 11 ok |

## Review

An independent reviewer (a separate agent given only the three source files and THREATS.md,
told to break them, not to praise) found these in the first build. Each is fixed and has a
regression test (R1–R7) that was run against the pre-fix file and **fails there**:

| # | Finding | Severity | Fix | Test |
|---|---|---|---|---|
| 1 | The 3-guess budget was not enforced under concurrent `acceptHello` (29 guesses evaluated; a correct guess after the lock still paired) | **break** | state-changing calls serialised per agent; state rechecked before write | R1 |
| 2 | An invite id named `constructor`/`toString` hit `Object.prototype`: half-written state, a planted unverified contact whose tokens opened `authentic` | weakness | `own()` lookups everywhere wire text indexes state; validation before mutation | R2 |
| 3 | One envelope with `from:"constructor"` threw out of `open()` and hid every other token in the mail | weakness | per-token isolation | R2 |
| 4 | Quadratic/worse regex on `hy1.` or `hy1inv.` repeated: 10–32 s on a 160–280 KB body (the 32 s one is in `crypto.js`, not owned here) | weakness | linear hand scanner; only well-formed tokens are handed to `crypto.js` (`HyInvite.hy1Tokens` exported for the other callers) | R3 |
| 5 | `guardSend` false negatives: the 8 secret characters without the 2 check characters; hex-encoded keys; "invite-only" exemption for any reply that quoted an old invite | weakness | match the 8-char core; hex forms; exemption only when the body is exactly the template | R4 |
| 6 | Pressing Join twice stranded R (new Y overwrote pending; S accepted the first hello) and raised a false `code-used-twice` | weakness | join is idempotent per (invite, code); same device re-answering is not a second party | R5 |
| 7 | Two hellos in one text lost the welcome and the address | weakness | first success returned at top level | R7 |
| 8 | The verified contact on R's side was bound to the unauthenticated `From:` address | weakness | `From:` is recorded as a claim; only `bindAddress()` makes an address resolve | R6 |
| 9 | Unbounded alarms/pending; spent `x`,`w` kept; `subject` surfaced on a bad signature | nit | caps, gc, subject only when authentic | — |

Not found by the reviewer after real effort: an offline test of a code guess, role reflection,
cross-context signature reuse, `lp()` field-boundary ambiguity, 1,200 curve-arithmetic checks
against WebCrypto, degenerate/non-canonical point encodings, envelope kid/to/from confusion.
One reviewer is one reviewer; this is not an audit.

The five accepted limits, plainly:

| ID | What the attacker gets | What exposes it |
|---|---|---|
| A4.3 | a phisher who spoofs the invite *and* phones R with a code is R's verified contact | the real S's app has no contact for R and no number to read; R chose the label |
| A5.6 | replay of a genuine old signed message is accepted as authentic | `seenBefore`, and the signed `ts`/`id` are the original's (UI must show the signed time) |
| A9.1 | no-code mode: an active relay pairs with both sides and reads everything, until the number is compared | safety numbers differ; `confirmSafetyNumber` fails; contact stays `unverified`; sealing needs an explicit override |
| A10.5 | code leaked in a readable channel *before* R uses it, with mailbox access: attacker pairs first | R sees an unsolicited welcome; S sees `code-used-twice` when R answers; safety numbers differ |
| A10.6 | the same, and the attacker also deletes R's mail | **nothing in the software.** Only S asking R "did it work?" |

## What is *proven* (by running it)

* The mailbox, the invite, hello and welcome contain none of: the code, either private key, the
  SPAKE2 scalars, the pair key — and no per-invite URL (A1.1, A3.1). Searched for in every
  encoding the tests could produce.
* A passive reader with the whole mailbox derives no key from public material, with or without
  the later-leaked code (A1.1–A1.3).
* Each of 6 invite fields, 6 hello fields and 3 welcome fields mutated in turn, 1,500 fuzzed
  inputs through 5 parsers (and 280 KB parser-bombs through every entry point, R3), relay drop/delay/duplicate/reorder, reflection, bundle swaps in both
  directions: never a wrong pairing, never an exception (A2.1–A2.7).
* The prototype's curve arithmetic equals WebCrypto's ECDH on random scalars and arbitrary
  points (U1); SPAKE2 agrees on a matching code and diverges on a mismatch (U2); degenerate
  points are refused (U4).
* The online try budget holds: 300 guesses against a live invite evaluated exactly 3 (A8.1),
  and 40 hellos fired concurrently still evaluate at most 3 (R1). The
  measured success rate with a deliberately weak 8-bit code was 5/500 against a theoretical
  5.9 ± 2.4, and 3/200 full MITMs against 0.78 expected (A8.2, A8.3; the earlier full run
  gave 7/500 and 0/200). 3 of 200 is a ~6% one-sided tail under the theory — consistent, not
  evidence of an advantage, but 200 trials cannot see a 2× advantage either. Calibration runs
  show the same attacker scripts win 5/5 when handed the code, so the attackers are real.
* Offline: for all 256 codes of the weak configuration, nothing computable from the full
  transcript verifies, while the same code path finds the code when given the private scalar
  (A8.4).
* The harness is not blind: a single-use magic link is burned by the scanner (A3.2), a key in a
  link fragment is read from the mail (A3.3), `HKDF(code)` falls to an offline search (A8.5), an
  address-bound directory substitutes a key unseen (A9.3), a 20-bit safety string falls to a
  birthday search in ~560 keys (A9.4), a shared-key circle cannot tell forger from author (A5.1).

## What is only *argued*

* **SPAKE2's security** is a proof in the random-oracle model for the textbook protocol. The
  tests check behaviours, not the proof. This is an implementation with its own `M`, `N`
  (try-and-increment from SHA-256 of a fixed label — nobody knows their relative discrete log,
  and anyone can re-derive them), its own key schedule, PBKDF2 stretching, and a hand-written
  BigInt curve. None of that has been reviewed by a cryptographer.
* **No side channels.** Scalar multiplication is variable-time. The only party that could time
  it is code on the same device; that is argued unreachable from a page, not tested.
* **The 40-bit code is enough.** With 3 tries the per-invite break probability is ≈ 2.7·10⁻¹².
  Whether that is enough depends on how many invites exist and how valuable they are; it is a
  number, not a certainty. A code that is *read aloud* is also exposed to whoever is in the room.
* **WebCrypto is correct** (AES-GCM, ECDH, ECDSA, HKDF, PBKDF2, HMAC). Assumed.
* **Gmail behaves as observed**: that it files all-ciphertext mail as spam, splits tokens one
  div per line, quotes with `>`. The parsers tolerate wrap and quoting (A2.6, F1); the spam
  mitigation (prose preamble) is argued, not measured against Gmail.
* **Everything about Google's pages** in GOOGLE-WRAPPER.md. No live Gmail/Drive/Docs session was
  used.
* **Users read warnings.** All the "detected" rows detect with software; a human has to act.

## Trust that remains (no design here removes these)

1. **A second channel exists and S and R know each other on it.** The code is the root of trust
   in code mode; the spoken/typed number is the root in no-code mode. If that channel is read by
   Google (Google Chat, Meet chat, Messages/RCS on Android, a Doc, Gmail itself), the design
   gives nothing. Signal, in person, a phone call: fine.
2. **First install.** The invite's words ("search for hyphae") are not authenticated. The root of
   trust for *the code that does the cryptography* is the extension store listing.
3. **The human at the other end.** The design authenticates "someone who knows this code", not
   "Priya". A4.3 is not a bug; it is the edge of what software can verify.
4. **Metadata, including the subject.** The Gmail adapter does not seal the subject today, so
   it is plaintext to Google; the design's answer (a fixed label, the real subject inside the
   signed envelope — `SUBJECT_LABEL`, `sealTo({subject})`, guard code `subject-readable`) is
   implemented here but not wired into the adapter. Google sees S emailed R, when, how big,
   the subject (until that is wired), that both use
   hyphae, the pair's constant circle id on every token, and S's public identity key in the
   invite.
5. **The browser and the device.** A compromised endpoint, a malicious extension, or malware
   reads plaintext and keys. The invite flow's storage is `chrome.storage.local` like the
   circles today (JWK private keys, extractable) — see WIRING §1 for the hardening.
6. **No forward secrecy, no post-compromise security.** The pair key is derived from long-term
   identity keys; a later device compromise opens everything in the mailbox, which Google keeps.
7. **No revocation.** Removing a person means a new pairing and, for groups, a new circle.
   A leaked pair key cannot be recalled.

## What the invite email may contain — exactly

`HyInvite.inviteEmail()` builds it; test A1.1/A3.1 scan the delivered mail for secrets.

| In the mail | Value | If an attacker has it |
|---|---|---|
| Prose (what hyphae is, 3 steps, "no password or key in this mail") | text | nothing |
| `https://hyphae.social/` | one static URL, identical for every invite | a scanner GETs it: no state, no per-invite handle |
| `hy1inv` token: version | `1` | nothing |
| invite id | 64 random bits, a label | enables a hello to *name* this invite; useless without the code |
| S's public identity bundle | ECDH + ECDSA public keys | public; S's identity |
| SPAKE2 point `X = x·G + w·M` | 33 bytes | a transcript for which no offline test of a code guess exists; permits **3** online guesses |
| claimed display name | S's own name | untrusted claim, never used as a label |
| expiry | time | nothing |

It does **not** contain: the code, any key, any token that unlocks content, any link whose
fetch changes anything, any value derived from the code that can be tested offline. The invite
is a **capability for exactly one thing**: the right to attempt a 40-bit guess three times
before S's invite dies. That is stated rather than hidden because "no capability at all" is not
literally true of any design in which the invite is meaningful.

## What the UX must make impossible (not merely discouraged)

Each of these has a test or a code path that enforces it; the adapter must not route around it.

1. **Putting the code, a key, a share string or a private key into any Gmail field** —
   `guardSend` blocks it in nine spellings (A10.1, A10.2); the adapter must call it on *every*
   Send path, including Gmail's "Send later" and "Send & archive".
2. **Sending plaintext, or plaintext beside a token, to a person S has a sealed relationship
   with** (A10.3).
3. **Silently falling from code mode to unverified.** A joiner holding a code must refuse an
   invite that has no code part; an inviter that issued a code must refuse a proof-less hello
   (A10.4). There is no "continue anyway" in code mode.
4. **Sealing to an `unverified` contact without a deliberate override**, and **choosing between
   several unverified answerers** to one invite (A4.4, A7.3).
5. **Showing a self-asserted name as the contact's name.** Show it as a claim; the human names
   the contact (A4.1, A4.3).
6. **Showing a message as "from Priya" unless `authentic` is true** — a bare hy1 token, or a
   token whose signature fails, must render as unattributed (A5.2–A5.4). Replays must show the
   signed time (A5.6).
7. **Auto-sending any invite, hello or welcome.** hyphae fills Gmail's compose window; the
   person presses Send. This is also what keeps Google OAuth out of the product.
8. **Putting the code in the same window as, or visually adjacent to, anything that is mailed.**
9. **Treating a "welcome" you did not ask for, a `code-used-twice`, or a `multiple-responders`
   alarm as noise.** They are the only signals the software has for A10.5.

## What the user must accept

* **A secure first contact costs one person-to-person act.** There is no design in which a
  Gmail-only recipient becomes trustworthy without the inviter and recipient exchanging
  something Google cannot read. Code mode makes that act "say ten characters, once".
* **Against Google as an *active* adversary in no-code mode, the design is not secure until a
  number is compared.** It is secure against Google reading.
* **If the code is read by the adversary before it is used, the adversary can pair as R.** The
  software can often notice afterwards; it cannot prevent it (A10.5/A10.6).
* **Anyone who has the invite email can burn it** (three wrong tries). That is a nuisance, not a
  breach, and it cannot be fixed without giving the email more power.
* **Google still sees the shape of the conversation.**
* **No hosted accounts means no recovery.** Lose the device, lose the identity; re-invite.

## Not done

* An independent audit, or replacement of the hand-rolled SPAKE2/BigInt curve with a reviewed
  library (and its test vectors). Highest-value next step.
* Non-extractable key storage; encrypted-at-rest local state.
* Live testing in real Gmail / Drive / Docs; spam-folder behaviour with the preamble.
* Multi-device (S's second laptop has no invite state; R in two browsers has two identities).
* Group invites; membership change; revocation; forward secrecy (a ratchet).
* The short-SAS commit-reveal round, which would let no-code mode use a short string.
