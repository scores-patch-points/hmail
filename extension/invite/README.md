# invite/ — bringing a Gmail-only person into hyphae

How a person with hyphae invites someone who has only a Gmail address, so content sealed to
them (mail, Drive files, Doc text) is unreadable to Google and to anyone with the mailbox.

| File | What it is |
|---|---|
| `THREATS.md` | adversaries A1–A10 (+ what was not modelled), what each can do, where each stands |
| `DESIGNS.md` | four candidate designs specified and attacked; the attack table; the decision |
| `VERDICT.md` | what is proven, what is only argued, what trust remains, what UX must make impossible |
| `GOOGLE-WRAPPER.md` | feasibility per Google surface; where the Invite control goes; the exact words |
| `WIRING.md` | the small hook-ups needed in files this folder does not own |
| `p256.js` | BigInt P-256 point arithmetic (cross-checked against WebCrypto) |
| `spake2.js` | SPAKE2 over P-256 with key confirmation — **not audited** |
| `hyinvite.js` | identity, invite/hello/welcome, pairing, safety number, signed envelopes, send guard |
| `sim.mjs` | in-process mock mailbox, scanner, web and people — no network, no real accounts |
| `attacks.test.mjs` | the adversarial suite |

```
node extension/invite/attacks.test.mjs            # full run, ~3-4 min
QUICK=1 node extension/invite/attacks.test.mjs    # reduced trial counts, ~30 s
```

Shape of the flow (code mode):

```
S's extension   invite  hy1inv…~   (public: S's key, SPAKE2 point, no secret)   ──► Gmail ──► R
S ── tells R a 10-character code by voice / Signal / in person (the second channel) ──► R
R's extension   hello   hy1hello…~ (public: R's key, SPAKE2 reply, proof of code) ──► Gmail ──► S
S's extension   welcome hy1welcome…~ (public: confirmation)                      ──► Gmail ──► R
after that      hy1.<kid>.<iv>.<ct>~ tokens under a per-pair circle, signed inside
```

Read `VERDICT.md` before trusting any of it.
