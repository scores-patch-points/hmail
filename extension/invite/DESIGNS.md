# Candidate designs, specified and attacked

The question: how does a person with hyphae get a Gmail-only recipient to a state where S can
send R sealed content and **both** can trust the key belongs to the other — when the invite
itself must travel through a mailbox the adversary can read and rewrite?

Four candidates were specified. Each was attacked with the same adversaries (`THREATS.md`
A1–A10). The choice was made from the attack table at the end, not from taste.

Notation: `S` inviter, `R` recipient, `G` Google/mailbox/relay. "2nd channel" is a path the
adversary does not control (voice, in person, Signal) — the project's rule is that a key never
shares a channel with the ciphertext it unlocks.

---

## (a) Shared circle key handed over a second channel

**Spec.** S makes a circle (`kid`, 32-byte key). S gives R the key as the 17-group written code
or a key file (`HyCrypto.toWritten` / `shareString`) over the 2nd channel. R installs hyphae,
enters it, and both seal and open ordinary `hy1.<kid>.<iv>.<ct>~` tokens. The invite email says
"install hyphae; Sam will give you a code on the phone".

**Attacks.**
* A1/A2/A3 hold: nothing secret is ever in the mailbox, there is no URL, there is no handshake
  to attack.
* A5 fails: the format has no author. Either holder (and in a group, every holder) can forge
  the other (control **A5.1**).
* A7/A10 fail *catastrophically*: the code **is** the capability, permanently. A code pasted
  into a mail, or heard later by a reader of the channel, opens every message ever sent, with no
  way to un-leak it (the same adversary as **A1.2** — recorded mailbox plus later-leaked secret —
  wins outright here, where it loses against (c)).
* A8: 68 characters is not guessable, but nobody will read 68 characters over a phone; the
  moment it is shortened to be speakable, offline guessing breaks it (control **A8.5**).
* No key rotation for a single person without redoing the whole handoff.

**Verdict.** Survives only as a *fallback*: the right tool for a circle of people who already
have a Signal thread and for the existing hub. It is the weakest option for first contact.

---

## (b) Per-recipient public-key identity, trust by comparing a short authentication string

**Spec** ("sas mode" in the prototype). R generates an ECDH P-256 + ECDSA P-256 identity locally
(WebCrypto; P-256 rather than X25519/Ed25519 because every shipped Chromium has it and SPAKE2
below needs one curve with point addition — X25519 only entered WebCrypto in Chrome 137).

```
S → R  (invite, public)   hy1inv.1.<iid>.<S bundle>.-.<label>.<exp>~
R → S  (hello,  public)   hy1hello.<iid>.<R bundle>.-.<sig_R>.-.<label>~
pair circle = HKDF( ECDH(S.dh, R.dh) ; salt = H(sorted bundles) ) → kid(8) ‖ key(32)
safety number = base32( SHA-256("hyphae/safety/v1" ‖ sorted bundles )[0:130 bits] )   26 chars
```

Both read their 26 characters to each other over the 2nd channel. Content is sealed to the pair
circle in a signed envelope. The contact is `unverified` until a typed number matches;
`sealTo` refuses an unverified contact unless the caller says `allowUnverified`.

**Attacks.**
* A1 holds (CDH on public keys; **A1.3**).
* A2/A9 **fail before the comparison**: a rewriting relay pairs with both sides and reads
  everything (**A9.1**). After the comparison they hold: numbers differ, confirm fails, contact
  stays unverified. So this design is exactly as strong as the user's willingness to make the call.
* The number must be long. A 20-bit string with no commitment falls to a birthday search over
  *both* sides' keys in ~560 candidates (control **A9.4**; the attacker controls both ends so the
  work is 2^(n/2), not 2^n). 130 bits resists a 6000-candidate search by a factor of ~2^100
  (**A9.5**). A short SAS needs a commit-then-reveal over three flights; we did not build that
  because (c) gives the same short human string with a stronger guarantee.
* A5 holds via signatures (**A5.2–A5.4**). A6 holds (history unreadable; key change flagged,
  **A6.1–A6.2**). A7 holds only with the comparison: forwarded invites produce several
  responders and S refuses to guess (**A7.3**). A4: a phisher's key is detected only if R
  compares with the *real* S.
* No guessing surface at all: nothing in this design is a code.

**Verdict.** Survives as the no-code path, with the unverified state made loud. Secure against a
passive reader with no human action at all; secure against an active one only after a
person-to-person comparison.

---

## (c) Short-code PAKE through a dumb relay (here: through the mailbox itself)

**Spec** ("code mode"). SPAKE2 over P-256 (`spake2.js`), with key confirmation. S's extension
makes a one-time code (40 bits; 8 base32 characters + 2 check characters), derives
`w = PBKDF2(code ; ctx = iid ‖ S bundle)` and puts SPAKE2's first message `X = x·G + w·M` in
the invite. S tells R the code by voice/Signal/in person. R types it; R's client computes
`Y = y·G + w·N` and `K = y·(X − w·M)`.

```
S → R  invite   hy1inv.1.<iid>.<S bundle>.<X>.<label>.<exp>~           (public; X is not secret)
R → S  hello    hy1hello.<iid>.<R bundle>.<Y>.<sig_R>.<tag_R>.<label>~
S → R  welcome  hy1welcome.<iid>.<tag_S>.<sig_S>~
TT  = len-prefixed( ctx, iid, S bundle, R bundle, X, Y, K, w )
h   = SHA-256(TT);   ke, kcA, kcB = HKDF(h, …)
tag_R = HMAC(kcB, "hello"‖h);   tag_S = HMAC(kcA, "welcome"‖h)
pair circle = HKDF( ECDH(S.dh, R.dh) ‖ ke ; salt = H(sorted bundles) )
```

The mailbox is the "dumb relay": it carries only public points, tags and signatures. No separate
relay service is required, so nothing needs hosting and nobody learns who uses it.

**Attacks.**
* Offline guessing (**A8.4**): G holds X, Y, both tags and the whole transcript. For every one of
  the 256 codes of an 8-bit test configuration it computes the unmasked points and every
  candidate shared point it can; no tag verifies — and the same code path *does* find the code
  when handed the private scalar, so the missing ingredient is demonstrably the scalar.
* Online guessing: one guess per hello, 3 tolerated, then the invite dies — ≤ 3/2⁴⁰ (**A8.1**).
  Measured against theory with a deliberately weak 8-bit code (**A8.2, A8.3**), with
  calibration runs showing the same attacker script wins 100% when handed the code.
* Active MITM: both identity bundles are inside `ctx` and `TT`, so swapping them, relaying
  unmodified, or replacing the whole invite all fail closed (**A2.1–A2.5, A9.2**).
* A passive reader who learns the code **later** still cannot reconstruct `K = xyG` (**A1.2**) —
  unlike (a), a leaked-after-use code is harmless.
* Downgrade: stripping `X` makes a code-holder refuse (`downgrade`) and an inviter that issued
  a code refuse a proof-less hello (**A10.4**).
* A7: the invite is not a capability; a replayed hello is idempotent (**A7.2**).
* Weaknesses: the code *is* the 2nd channel, so a code leaked before use plus a mailbox
  attacker pairs as R (**A10.5**, detected afterwards by three independent alarms; **A10.6**,
  not detectable if G also removes R's mail). The SPAKE2 implementation is hand-rolled over a
  hand-rolled variable-time BigInt curve and is **not audited**. A PAKE alone yields only a
  pairwise symmetric key — either side could forge the other — so by itself it is (a) with a
  speakable key; the long-term identity exchange is what makes it per-recipient.

**Verdict.** Survives, and is the right *authenticator* for first contact. Not sufficient as a
whole design without (b)'s identity keys inside it.

---

## (d) Email-address-bound public-key directory (WKD / Keybase-style)

**Spec.** R's key is published against `rae@gmail.com`: Web Key Directory
(`https://openpgpkey.<domain>/.well-known/openpgpkey/…`), a keyserver that verifies the address
by mailing a link, or social-proof sites. S looks the key up by address and seals to it.

**Attacks.**
* The party that must vouch for the binding is the party in the threat model. For `gmail.com`
  the WKD operator is Google; for a keyserver the "verification" is a link mailed to the
  mailbox, which the mailbox operator can follow (A1 → registers a key of its choosing). Control
  **A9.3** performs the substitution at lookup: S gets no second channel to notice, and the
  attacker opens every token.
* A6 fails twice: a later mailbox takeover can re-register (an address-based system cannot tell
  rotation from takeover), and re-registration is how an address is "recovered".
* A4 is trivial: no key is bound to anything the invite says, only to the address, which is
  spoofable.
* Privacy: the lookup itself tells the directory that S is about to write to R — the thing the
  operator is meant not to learn.
* What it would need: a transparency log with independent witnesses and a client that audits it
  (CONIKS / Key Transparency), run by someone who is not the mailbox. That is infrastructure,
  an operator and a governance problem; it only *detects* after the fact; and for gmail.com it
  needs Google's cooperation. Keybase-style proofs additionally need R to hold a public account
  on a platform the adversary does not influence — a Gmail-only recipient usually does not.

**Verdict.** Rejected. No configuration available to this project survives A9 or A6.

---

## Other variants tried and thrown out

| Variant | Why it dies | Test |
|---|---|---|
| Single-use "join" link with a token in the URL | A3: a scanner burns it before the human clicks | A3.2 |
| Key in the URL fragment (`#k=`) of an email link | A1: the mailbox holds it | A3.3 |
| `key = HKDF(code)` with a speakable code | A8: offline search over the code space | A8.5 |
| Short SAS (≤ ~60 bits) without a commitment round | A9: birthday over both keys | A9.4 |
| Code sent by SMS / Google Chat / Meet chat / Drive | not a 2nd channel if Google reads it | (policy; UI wording) |
| Password-protected file/zip, password in the same thread | violates rule 1 | — |
| PGP / S-MIME | R must already have keys; same first-contact problem as (d); not a wrapper | — |

## Attack table

`✓` withstands, `✗` broken, `~` withstands only with a human act or under a stated condition.

| Adversary | (a) key by 2nd ch. | (b) per-recipient + SAS | (c) PAKE code (alone) | (d) directory | **b+c (built)** |
|---|---|---|---|---|---|
| A1 mailbox reader | ✓ ; ✗ if key leaks later | ✓ | ✓ ; ✓ if code leaks later | ✓ if keys honest | ✓ |
| A2 active network/relay | ✓ | ✗ before compare | ✓ fail-closed | ✗ | ✓ code mode; ~ sas mode |
| A3 scanner/prefetch | ✓ | ✓ | ✓ | ✓ | ✓ |
| A4 phisher (email only) | ~ | ~ | ✓ | ✗ | ✓ |
| A4 phisher + voice | ✗ | ✗ | ✗ | ✗ | ✗ (limit; exposed by the real S having no contact) |
| A5 forgery in circle | ✗ | ✓ signed | ✗ (symmetric) | ✓ if keys honest | ✓ signed envelope |
| A6 later mailbox takeover | ✓ history ; ✗ re-key | ✓ key change flagged | ✓ | ✗ | ✓ |
| A7 replay/forward | ✗ (key is the capability) | ~ | ✓ 3 tries then dead | n/a | ✓ code; ~ sas |
| A8 code guessing | ✗ if speakable | n/a | ✓ ≤ 3/2⁴⁰ | n/a | ✓ |
| A9 key substitution | ✓ (nothing exchanged) | ✗ before compare | ✓ | ✗ | ✓ code; ~ sas |
| A10 downgrade/user error | ✗ catastrophic | ~ unverified skipped | ~ code leaked before use | ~ | ~ guarded; limits A10.5/6 |

## Decision

* **Primary: (b) + (c) composed** — SPAKE2 authenticates the exchange of per-recipient identity
  keys; the long-term keys then carry signed envelopes and let S seal to R later without a new
  code. Chosen because it is the only candidate that withstands A1, A2, A3, A5, A6, A7, A8 and
  A9 simultaneously, and it turns the second channel from "a 68-character key" into "ten
  characters, once, harmless afterwards".
* **Fallback: (b) alone** when S and R have no voice-grade channel to say a code but can still
  compare a number later. It is honest only if `unverified` stays visible and blocks anything
  sensitive.
* **Retained: (a)** for groups and for people who already share a Signal thread (the existing
  hub path); not offered for inviting a stranger.
* **Rejected: (d).**
