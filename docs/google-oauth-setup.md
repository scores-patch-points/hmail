# Connect Google — self-hosting setup

> **Using the hosted hmail at https://mail.hyphae.social?** You don't need this
> page. Click **Continue with Google** and approve the one permission.
>
> This page is for running **your own copy** of hmail with **your own** Google
> OAuth client. For the hosted deployment's verification submission, see
> `GOOGLE-OAUTH-VERIFICATION-hmail.md` in the workspace root.

Four steps, once. About 10 minutes, no code, no credit card.

hmail asks Google for **one** sensitive permission, `gmail.send`, plus your
account's email address. Do **not** add `gmail.readonly`, `gmail.modify` or
`gmail.compose`: the app never reads your mailbox, and those scopes are
"restricted" and would require an annual third-party security assessment before
a public release.

---

## Step 1 — Turn on Gmail

Open this page and click **ENABLE**:

> https://console.cloud.google.com/apis/library/gmail.googleapis.com

Done when: the button now says **Manage** instead of **Enable**.

---

## Step 2 — Make your key

Open this page:

> https://console.cloud.google.com/apis/credentials

1. Click **+ CREATE CREDENTIALS** > **OAuth client ID**.
2. Application type: **Web application**.
3. Name it anything, e.g. `hmail`.
4. Find **Authorized JavaScript origins** > click **+ ADD URI** and add:
   - `http://localhost:5173`
   - the address your copy will live at, e.g. `https://mail.example.com`
5. **Ignore** "Authorized redirect URIs" — we don't use those. Leave it empty.
6. Click **CREATE**.

Done when: you see a **Client ID** that looks like
`1234567890-abcdefg.apps.googleusercontent.com`. Copy it — you'll paste it into
the app.

---

## Step 3 — Allow sending

Open this page:

> https://console.cloud.google.com/apis/credentials/consent

- If it asks for **User type**, pick **External**, then **Create**.
- Fill in an **App name** (use a name that doesn't contain "Google" or "Gmail")
  and your **Support email**. Save.
- Go to **Data access** (or the **Scopes** tab) > **ADD OR REMOVE SCOPES**,
  search for "Gmail", and tick **gmail.send** only. Save.
- Go to **Audience** (or **Test users**), click **ADD USERS**, and add the Gmail
  address(es) that will use your copy. Save.

Done when: your email is in the test-users list.

> Why test users? While the app is "in testing", Google only lets the people you
> list authorize it — right for one operator or a small team, and no review is
> needed. Going public means setting the app **In production** and completing
> Google's verification.

---

## Step 4 — Paste the key into the app

Either set `VITE_GOOGLE_CLIENT_ID` in `.env` and rebuild, or open the app >
**Settings** (or the setup screen) > paste your **Client ID** > save. Then click
**Continue with Google**.

- If it works: you're connected. Done.
- If it shows an error, it tells you the exact missing piece (usually a step 2
  origin or a step 3 scope/test user). Fix that one thing and retry.

---

## The whole thing in one breath

1. Enable Gmail API.
2. Create a Web OAuth client, add your origins.
3. Add the `gmail.send` scope (and nothing that reads mail) + your account as a
   test user.
4. Paste the client ID into the app.

Google sees what it sees (recipients, ciphertext); the token lives only in your
browser; no third party holds anything.
