# hmail

Send private email through your own Gmail. The app's **Connect Google** flow is
a real OAuth (send-only token, held only in your browser). Mail is encrypted in
the browser with keys that travel through Matrix.

Hosted at **https://mail.hyphae.social** (landing `/`, app `/app/`, policy
`/privacy/`, terms `/terms/`). The hosted build ships one Google-verified OAuth
client, so users just click **Continue with Google**; the 4-step wizard below is
only for self-hosting with your own client.

## The model

The app is a **skin on Gmail**. Its data — lists, recipients, config, send
history — lives in the browser, never on Matrix. Matrix is the layer that
**encrypts and connects people outside of google**:

- Every send is AES-256-GCM encrypted under a fresh per-send key.
- Gmail carries ciphertext only: the subject is `[hmail <id>] …`, the body is
  base64 ciphertext. Logging into Gmail normally shows nothing readable.
- The key + manifest is handed to each recipient who has a **Matrix MXID** on
  their row, in an end-to-end-encrypted DM (Megolm) — the "outside of google"
  channel that decrypts it. No MXID = ciphertext only, unreadable.

**OAuth is real and in-app** (Google Identity Services, the app's own client
ID): the send-only `gmail.send` token is issued to the browser and never leaves
it. **No third party holds a token** — no EmailJS, no relay, no server.

**First run — two things, nothing else:**

1. **connect google — one time, then done.** A **Continue with Google** button.
   If the OAuth client isn't set up yet, the app shows a 4-step tutorial with
   deep links and a paste-your-Client-ID field (see `docs/google-oauth-setup.md`).
2. **your password for this site.** A shared password — the one you type to get
   in each time. Share it with the other admins.

**Every visit after:** just the password.

**Under the hood (never shown):** the operator's Matrix session on hyphae.social
is derived from a hash of the email + site password (`src/lib/secrets.ts`) and
used only as the connection + key-delivery channel. The site password is never
stored; the only thing persisted in the browser is the Gmail address. The OAuth
token lives in sessionStorage and dies with the tab.

## Self-hosting setup (a guided wizard, ~10 min, once)

Only needed if you run your own copy with your own Google client. The app walks
you through it in-app (when no client ID is baked in) — or follow
`docs/google-oauth-setup.md`. The four steps:

1. Enable the Gmail API.
2. Create a **Web application** OAuth client; add your site origin + localhost
   to **Authorized JavaScript origins** (no redirect URIs needed).
3. Add the `gmail.send` scope **only** (never `gmail.readonly`/`modify`/
   `compose` — those are restricted scopes) and your own account as a **test
   user**.
4. Paste the Client ID into the app (it's public — it ships in the bundle).

When `VITE_GOOGLE_CLIENT_ID` is set at build time it always wins and the wizard
is hidden.

## Google verification

The hosted deployment needs Google's OAuth verification (a sensitive scope, no
CASA assessment because the app is send-only). Everything the submission needs
— consent-screen values, scope justification, demo script — is in
`GOOGLE-OAUTH-VERIFICATION-hmail.md` at the workspace root. The public pages it
requires are part of this repo: `index.html` (landing), `privacy/`, `terms/`,
logo at `public/logo-120.png`.

Config (public) comes from repo Variables (Settings → Secrets and variables →
Actions → Variables): `VITE_GOOGLE_CLIENT_ID`, `VITE_SUPPORT_EMAIL` (required;
rendered into the policy), plus `VITE_MATRIX_HOMESERVER` and `VITE_OWNER` as
desired.

## Who sees what

| Party | Sees | Can't see |
| --- | --- | --- |
| Google/Gmail | recipient, from, ciphertext | plaintext, the key |
| Matrix/hyphae.social | operator session, E2EE key DMs | your lists (browser-only), plaintext mail |
| Nobody else | — | the shared site password (never stored), the AES keys (only in encrypted DMs) |

No third party holds a token: the `gmail.send` OAuth token is issued to the
browser (Google Identity Services) and never leaves it. Google sees the
recipient, from, and ciphertext — and only that.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. First run: **Continue with Google** (with the
built-in 4-step wizard if the OAuth isn't set up yet) + site password; after
that it's just the password. Set the Client ID in `.env` or paste it in-app.

Verify the build:

```bash
npm run build
npm run preview
```

## Deployment

Pushes to `main` build and deploy to GitHub Pages via `.github/workflows/deploy.yml`,
reading the public config from repo Variables (above). One-time setup: enable
Pages with **Source: GitHub Actions**, set the custom domain
`mail.hyphae.social` (Settings → Pages) and add a `CNAME` DNS record for it
pointing at `<user>.github.io`, then push. The workflow fails if
`VITE_SUPPORT_EMAIL` is unset or a `%VITE_…%` placeholder survives into a built
page.

## Security notes

- The **site password is not stored** — it only derives the Matrix account
  password (the sole place it exists). Change it in Settings and it rotates
  that account's password.
- **Data stays in the browser** — lists, config and history never touch Matrix.
- **Send-only OAuth** — `gmail.send` scope, token held only in this tab, no
  third party in the path.
- **Mail is ciphertext to Google** — per-send AES key, delivered to each
  recipient's E2EE Matrix DM. Without the Matrix channel, nothing is readable.
- Matrix E2EE and the underlying client come from the hmail lineage
  (`matrix-js-sdk` with Rust crypto).

## Stack

Vite + React + TypeScript, Tailwind + shadcn/ui primitives, `lucide-react`,
`matrix-js-sdk` (Rust crypto), Google Identity Services + the Gmail API.

## License

MIT. See `LICENSE`.