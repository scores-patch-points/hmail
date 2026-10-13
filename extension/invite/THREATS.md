# Threat model — inviting a Gmail user who does not have hyphae

Scope: person **S** has hyphae. Person **R** has only a Gmail address. S wants R to be able to read
what S sends — email, Drive files, Docs text — while Google, the mailbox, and any intermediary
cannot. This file says who we are defending against, what each can do, and where the prototype
(`hyinvite.js`, `spake2.js`, `p256.js`) stands. Test IDs refer to `attacks.test.mjs`.

## Ground rules (these are not negotiable, and the design is built from them)

1. **A key never travels on the channel of the ciphertext it unlocks.** Not in the invite email,
   not in a Doc, not in a link sent through Gmail.
2. **The invite is untrusted in transit by design.** It contains no secret and no capability
   that Google, a scanner, or a forwarded copy could use. (What it does grant is stated exactly
   under A7 and A8: the right to *try* a 40-bit guess three times.)
3. **An email address is a label, never an authenticator.** `From:` is spoofable and the mailbox
   is the thing under attack. No key is ever bound to an address by anything a mail server says.
4. **No server, no hosted account.** "Account" means an identity key pair the recipient makes
   locally. (A Matrix account is not needed and nothing here depends on one or on a hyphae chat.)
   The operator learns nothing: the only URL
   in an invite is the static install page; there is no per-invite URL, no registry, no relay.
5. **Verification needs a second channel, and nothing removes that.** A person-to-person check
   (voice, Signal, in person) is the root of trust. Everything else is making that check as
   short, forgiving and hard to skip as possible.

## What we protect, and what we do not

| | Protected | Not protected |
|---|---|---|
| Content | email bodies, file bytes, Doc text sealed with hy1 tokens under a pair key | anything the user types outside hyphae's editor |
| Authorship | each message carries a signature by the sender's identity key, inside the AEAD | deniability (signed on purpose) |
| First contact | code mode: forged/relayed invite or hello is refused; sas mode: detectable by comparing a number | sas mode *before* the comparison, against an active rewriter |
| Metadata | nothing | who wrote to whom, when, size, **the subject (plaintext today — the adapter does not seal it; the design replaces it with a fixed label, not yet built)**, that hyphae is in use, the pair's constant circle id |
| Availability | nothing | anyone with the invite email can burn it (3 wrong tries) — a nuisance, not a breach |
| Forward secrecy | none | a later device compromise opens every message ever sent to that pair |

## Adversaries

Each: capability → what it can do against the invite flow → verdict. "Defended" means a test
plays it and fails; "limit" means it succeeds by design and the test asserts what exposes it.

### A1 — Google, or anyone with read access to the mailbox (invites, links, attachments, Drive)
*Capability:* reads every byte of every mail, every Drive file, forever; can run any analysis
offline, with unbounded compute, over the whole history.
*Against us:* sees the invite (no secret in it), the hello and welcome (public points, tags,
signatures), every sealed token. Needs a key, which was never in the mailbox. In code mode the
transcript offers no offline test of a code guess (SPAKE2); even a recorded transcript plus the
*later-leaked* code gives only `x·G` and `y·G`, not the shared point.
*Verdict:* **defended** — A1.1, A1.2, A1.3, A1.4, A8.4. *Still visible:* the relationship, the
timing, the sizes, the subject (plaintext until the label scheme is built), and the invite text ("Sam wants to send you private
messages (hyphae)").

### A2 — active network attacker, malicious relay or homeserver
*Capability:* modify, drop, delay, duplicate, reorder, inject; run a man-in-the-middle between S
and R on every channel the flow uses. Only mail is assumed; the three messages are plain strings,
so any other carrier (a paste, a messenger) is attacked the same way.
*Against us:* code mode — every field of the invite, hello and welcome is bound into a
transcript MAC; a flip, a swap of either identity key, or a relayed-but-unmodified exchange all
fail closed (A2.1–A2.5, A2.7 fuzz). Dropping and delaying are denial of service only (A2.3).
sas mode — a full MITM *does* pair (see A9). *Verdict:* **defended** in code mode; **limit** in
sas mode before the safety-number comparison.

### A3 — automated link scanners and prefetchers (Gmail, corporate gateways, previewers)
*Capability:* fetches every URL in every mail, usually more than once, before any human; may
rewrite URLs through a wrapper; may re-wrap or quote text.
*Against us:* the invite has exactly one URL, a static public page. There is nothing to consume.
The invite's state lives on S's device and is changed only by a hello carrying proof of the
code. *Verdict:* **defended** — A3.1, A2.6. Control A3.2 shows the same scanner destroys a
single-use magic-link design; control A3.3 shows a key in a link fragment is read by the mailbox.

### A4 — phisher spoofing S's invite
*Capability:* sends R a convincing invite "from S" pointing at the attacker's key, perhaps with a
look-alike extension link, perhaps a follow-up phone call.
*Against us:* the invite carries no secret to steal and R's client never shows a code or key to
read out. A spoofed invite alone gets nothing: R needs a code, and codes only come from the
inviter. The name an invite claims is shown as a *claim* and never becomes the contact's name
(R chooses the label). *Not defended:* a phisher who also telephones R with the code. R then
pairs with the phisher, authentically, and no cryptography can tell that "Sam" on the phone was
not Sam. What exposes it: the real Sam's app has no contact for R and no number to read.
A malicious *extension* behind a look-alike link is outside this design: the trust root for the
code is the browser's extension store, not the email. *Verdict:* **defended** for the email-only
phisher (A4.1, A4.2, A4.4); **limit** for the voice phisher (A4.3).

### A5 — forgery inside a shared-key circle
*Capability:* any holder of a circle key can produce tokens indistinguishable from any other
holder's. The hy1 format has no author field, by design (anonymity within the circle).
*Against us:* the pair circle has two holders; either could write "as" the other, so envelopes
are **signed** with the sender's ECDSA identity key *inside* the token, and receivers verify
against the key pinned at pairing. Groups are the same with a member list. Replays of a genuine
old message remain genuine: the signed timestamp and id expose them. *Verdict:* **defended**
(A5.2–A5.5); **limit, detected** for replay (A5.6); control A5.1 shows the existing format
cannot do this. *Requires* the reader to use `Agent.open()` and show `authentic`, which today's
reveal path does not (see WIRING.md).

### A6 — later takeover of R's mailbox, or S's
*Capability:* full read/write of one party's mailbox after pairing; can send mail as them,
delete mail, set filters.
*Against us:* the mailbox never held a key, so history is unreadable (A6.1). Mail "from R" that
is not a valid signed token authenticates as nothing. A new invite from R's address with a
different key is flagged as a key change and never silently replaces the verified contact
(A6.1, A6.2). *Not defended:* the same attacker *before* pairing combined with a leaked code
(A10.5/A10.6). *Out of scope:* a device compromise, which holds the keys.

### A7 — replay or forward of an invite to a third party
*Capability:* holds a copy of the invite (forwarded, or read from the mailbox) and replays it,
or answers it from another device.
*Against us:* code mode — the invite is not a capability to *read* anything; it is the right to
make at most 3 wrong guesses at a 40-bit code, after which it dies (A7.1, A8.1). A byte-identical
replay of R's hello is idempotent and raises nothing (A7.2). sas mode — a forwarded invite can be
answered by anyone; S sees several responders, refuses to send to an ambiguous address, and a
voice comparison picks the real one (A7.3). Expired and spent invites are refused (A7.4).
*Verdict:* **defended**. *Cost:* anyone holding the email can kill a code invite (DoS).

### A8 — online / offline guessing of short human-readable codes
*Capability:* unbounded compute offline; online, whatever rate the design allows.
*Against us:* the code is 40 bits (8 Crockford characters + 2 check characters). Offline: no
verifier exists (SPAKE2; A8.4 enumerates every code against the real transcript and finds none,
with a positive control that does find it when the private scalar is supplied). Online: the
inviter tolerates 3 wrong proofs, so success ≤ 3/2⁴⁰ ≈ 2.7·10⁻¹² per invite (A8.1; the
8-bit calibration runs A8.2/A8.3 measure the real rate against the theory). Fake invites aimed at
R yield at most 3 answered guesses (A8.6). A mistyped code is caught on R's device and costs the
invite nothing (A8.7). Control A8.5: `key = HKDF(code)` is broken offline in seconds.
*Verdict:* **defended**, with the code strength tied to the try budget (see VERDICT.md).

### A9 — key substitution at first contact (TOFU) by a registry or relay
*Capability:* swap the public key the other side will use.
*Against us:* there is no registry. Code mode binds both bundles into the password context and
the transcript (A9.2). sas mode offers a 130-bit safety number; a MITM pairs but the numbers
differ, `confirmSafetyNumber` fails, the contact stays `unverified`, and `sealTo` refuses it
unless the caller says `allowUnverified` (A9.1). Short strings are grindable (control A9.4, a
20-bit string falls in ~560 candidate keys); the real number is not (A9.5). Control A9.3: an
address-bound directory run by the mailbox operator substitutes the key invisibly.
*Verdict:* **defended** in code mode; **limit, detected** in sas mode.

### A10 — downgrade: S accidentally sends plaintext, or the key/code, by email
*Capability:* none needed; the user does it.
*Against us:* `Agent.guardSend()` sits on the Send path with the secrets this agent already
holds and refuses: the live code in nine spellings, a circle/pair/identity key, the share and
written-code formats, and plaintext (or plaintext beside a token) to a contact with a sealed
relationship (A10.1–A10.3). Stripping the code part from an invite does not drop R into an
unverified pairing: a joiner who holds a code refuses (`downgrade`) and an inviter that issued a
code refuses a proof-less hello (A10.4). *Not defended:* a code spoken or typed into a channel
Google can read, **before** R uses it (A10.5, detected after the fact; A10.6, not detectable if
the attacker also controls R's mailbox). The guard cannot see another application, a phone, or a
code paraphrased in words.

## Adversaries we did not model

* **A11 — endpoint compromise** (malware, a hostile extension, a page script reading the DOM).
  Out of scope; mitigations (closed shadow roots, editor outside Gmail's DOM) live in the adapter.
* **A12 — the operator.** There is no operator service in this flow. The install page and the
  extension store listing are the trust roots for *code*, not for messages.
* **A13 — compulsion** of S or R, or of their second channel.
* **A14 — traffic analysis.** The pair circle id is constant per pair and visible in every token.

## What each adversary still learns, in one line

Google sees: S emailed R; when; how big; the subject (plaintext today); that both use hyphae; S's
public identity key. It does not see: content, file bytes, the code, any key.
