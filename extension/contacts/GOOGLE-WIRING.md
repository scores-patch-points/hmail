# Google Contacts source — wiring and honesty

`contacts/google.js` (global `HyGoogleContacts`) turns Google contacts into the list
`store.importGoogle(list)` in `contacts/core.js` takes:

```js
{ name: string /* may be "" */, emails: [string /* lower-cased, valid, unique */], source: "csv" | "api" }
```

`name` is `""` when the contact has no name and no organisation, so core can use the Matrix
display name instead of showing an address as a name. `source` is `"csv"` for anything read from
an export file (including `.vcf`) and `"api"` for the People API.

## Recommendation: use the file route

| | File route (default) | API route |
|---|---|---|
| Google permission | **none** | OAuth token with a **sensitive** scope |
| Google verification needed | no | yes, for anyone but the project owner's listed test users |
| hyphae talks to Google | never | `people.googleapis.com` |
| Freshness | as of the export | live |
| User effort | export once, drop the file | consent screen, token handling |

Use the file route. It is the only one that is true to "the operator wants to know nothing about
users" without a Google review in the way, and it is what the sheet's file input already expects.

**The API route is still the right one** when the project owner is using their own account in
testing mode (they are a listed test user, so no verification is needed) — for example to
dogfood live sync before deciding whether a verified app is worth it.

## File route — how a caller uses it

`google.js` is dependency-free and has no `chrome.*` calls; it can be loaded as a content script
file (before `sheet.js`), in the service worker (`importScripts("contacts/google.js")`), or in a
page.

```js
// Whole text (sheet.js already has the file's text):
var r = HyGoogleContacts.parseExport(text);   // CSV (both flavours) or vCard, sniffed; { format: "csv"|"vcard" } forces one
// Large file, without holding it as one string:
var r = await HyGoogleContacts.parseFile(file);                        // File / Blob; streams; reads UTF-16 exports
// Chunks from anywhere:
var p = HyGoogleContacts.createParser();  p.push(chunk); /* … */  var r = p.end();

if (!r.ok) { /* r.error is "no-email-column: …", "no-vcard: …", "empty: …" or "too-large: …" */ }
else {
  var res = await store.importGoogle(r.contacts);   // { added, merged, skipped, conflicts }
  // r.stats   { records, contacts, withoutEmail, invalidEmails, duplicates, merged }
  // r.warnings[]  human-readable: size/contact cap hit, malformed addresses ignored
  // r.truncated   true when a cap stopped the read — tell the user, don't hide it
}
```

Input handled: Google CSV (`E-mail 1 - Value`, repeated `E-mail N - Value`, ` ::: ` multi-value
cells), Outlook CSV (`E-mail Address`, `E-mail 2 Address`, …), vCard 2.1/3.0/4.0 (folded lines,
`item1.EMAIL` groups, multiple `EMAIL`, `FN`/`N`, quoted-printable), quoted fields with embedded
commas/newlines/doubled quotes, UTF-8 BOM, UTF-16 BOM (via `parseFile`), CRLF/LF/CR, comma/semicolon/tab.

Defensive rules (all tested): lower-case + trim addresses; malformed ones are dropped and counted;
duplicates inside the file are collapsed (a person listed twice with a shared address and the same
name becomes one contact); an over-long CSV cell or vCard line is dropped *whole* — never cut,
because a cut cell could hold half an address that still looks valid; a size cap never flushes a
half-read record; names are stripped of control, zero-width and bidi-override characters; column
names are never used as object keys (Maps only), so `__proto__` columns are inert.

Limits (`HyGoogleContacts.LIMITS`, overridable per call with `{ limits: {…} }`): 64 MiB read,
100 000 contacts, 50 addresses per contact, 4 096 characters per cell, 1 000 columns, 200 per name.

Not handled: Exchange X.500 addresses (`/O=EXCHANGELABS/…`, Outlook type `EX`) are dropped — they
are not routable addresses. Localised Google CSV headers are matched only loosely (any column whose
header contains "mail", or begins "correo"/"courriel", is read; every cell is validated as an
address anyway), so an unusual locale can silently miss a column — `stats.withoutEmail` will be high.

## API route — how a worker calls it

```js
// in the service worker, after the user has pressed an explicit "Sync Google contacts" button
var r = await HyGoogleContacts.fetchContacts({
  accessToken: token,               // string, or async ({refresh}) => string — called again once on a 401
  fetch: fetch,                     // pass the worker's own fetch; this file never reaches for a global
  include: ["connections"],         // add "otherContacts" to include people you only ever emailed
  signal: abortController.signal,   // optional
  onProgress: function (p) {}       // optional; { source, pages, contacts } — counts only
});
await store.importGoogle(r.contacts);     // r.complete === false means a source failed or a cap hit; see r.warnings
```

Requests made (both `GET`, `Authorization: Bearer …`, `credentials: "omit"`, token never in a URL):

```
https://people.googleapis.com/v1/people/me/connections?personFields=names%2CemailAddresses&pageSize=1000[&pageToken=…]
https://people.googleapis.com/v1/otherContacts?readMask=names%2CemailAddresses&pageSize=1000[&pageToken=…]
```

Errors reject with an `Error` whose `name` is `HyGoogleContactsError` and whose `.code` is one of:

| code | meaning | retried? |
|---|---|---|
| `unauthorized` | 401 — token expired/revoked | once, only if `accessToken` is a function (asked with `{refresh:true}`) |
| `insufficient-scope` | 403 — token lacks the contacts scope | no |
| `api-disabled` | 403 — People API not enabled in the Cloud project | no |
| `rate-limited` | 429, or 403 with a rate/quota reason | yes, exponential backoff + jitter, honours `Retry-After`, 5 tries |
| `server` | 5xx | yes, same |
| `network` | `fetch` rejected | yes, same |
| `bad-response` | unexpected status/body | no |
| `bad-token` | token empty or contains whitespace/control characters (header injection) | no |
| `aborted` | `signal` fired | no |

If one source of several fails (say `otherContacts` is denied), the result still resolves with the
rest, `complete: false` and a warning; it rejects only if every requested source failed.

### Scope — exactly what is needed, and the verification fact

| Data | Scope |
|---|---|
| `people.connections.list` (your saved contacts) | `https://www.googleapis.com/auth/contacts.readonly` |
| `otherContacts.list` ("Other contacts": people you've emailed) | `https://www.googleapis.com/auth/contacts.other.readonly` |

**Both are *sensitive* scopes** (`contacts.readonly` is the narrowest scope that reads saved
contacts; there is no smaller one). For any app other than the owner's own listed test users, using
a sensitive scope requires Google's **OAuth app verification**. Until verified, other users see
the "Google hasn't verified this app" screen and the project is capped at 100 new users "over the entire
lifetime of the project" (Google's *Manage App Audience* page, read 2026-10-13).

**State of this project:** a Google Cloud project for this exists (Slides, Drive, IAM APIs
enabled; the People API is **not** enabled yet and would have to be). A verification attempt was
made for a *different* scope (a Gmail scope) and is **parked**. That attempt does not cover
`contacts.readonly`; a People-scope verification would be a new submission. Nothing in this module
or this document performs, starts, or depends on any consent or verification step.

While the consent screen is in *Testing* with the owner as a test user, the owner can authorise their
own account without verification (Testing status: up to 100 listed test users). Per the same Google
page, "authorizations by a test user will expire seven days from the time of consent", refresh tokens
included, so the owner would re-consent weekly.

**Checked against Google's published docs on 2026-10-13:** the two endpoints, `pageSize` 1–1000
(default 100), `pageToken`, `personFields` (connections) / `readMask` (otherContacts) names, the
`connections` / `otherContacts` + `nextPageToken` response keys, and which scope authorises each
(`connections.list` accepts `contacts` or `contacts.readonly`; `otherContacts.list` requires
`contacts.other.readonly`). **Not confirmed from the page text I could read:** that these three
carry Google's "sensitive" label — the scopes table I fetched came back without its sensitivity
markers. That `contacts.readonly` is sensitive is my knowledge of Google's classification; the
OAuth consent-screen configuration page in the Cloud console shows the label per scope and is the
place to confirm it for this project.

### Manifest

For **this module** the API route needs exactly one optional host permission and nothing else:

```json
"optional_host_permissions": ["https://people.googleapis.com/*"]
```

Request it at the moment the user presses sync (`chrome.permissions.request({ origins:
["https://people.googleapis.com/*"] })`) and drop it afterwards if you like. Note `manifest.json`
already lists `"<all_urls>"` as an optional host permission; if the user has granted that, this
one is already covered, but requesting the narrow origin is the one to prefer. The file route needs
**no** permission change at all. Do the fetch from the service worker, not a content script (a
content script's fetch is bound by the page's CORS/CSP).

**What this does not cover:** *getting* an access token. `google.js` deliberately does not. The
usual extension routes add something beyond the host permission: `chrome.identity.getAuthToken`
needs the `"identity"` permission and an `"oauth2": { client_id, scopes }` block;
`chrome.identity.launchWebAuthFlow` needs `"identity"`. The route that adds **no** extension
permission is to obtain the token on the web app origin (`mail.hyphae.social`, which the bridge
already serves) with Google Identity Services' token client and hand it to the worker over the
existing bridge — that is a design for the owner of the bridge, and I have not built or tested it.

Keep the token in memory only: never write it to `chrome.storage`, never send it to a content
script, discard it after the import.

## What is and isn't proven

Proven (by `node extension/contacts/google.test.mjs`, 214 checks, run locally, no network):

- Parsing of fixtures shaped like Google CSV, Outlook CSV and vCard 2.1/3.0/4.0, including BOM,
  CRLF/LF/CR, quoted commas/newlines/quotes, ` ::: ` cells, folded lines, quoted-printable,
  UTF-16, huge PHOTO blocks, hostile headers and cells; identical results for every chunking down
  to one character; size/contact caps; 200 000-row, ~16 MB CSV parsed in a few seconds.
- The API client against an **in-process mock** of the People API: pagination, request URLs,
  header-only token, 401 refresh-once, 403 classification, 429/5xx/network backoff, caps, abort,
  hostile JSON keys, and that no global `fetch`/XHR/WebSocket/beacon/`console` is touched.
- That every contact produced is accepted by the real `contacts/core.js` `importGoogle` (6 added
  from the Google CSV fixture; re-import adds 0).

**Not proven:**

- Anything against the real People API. The URLs, field masks, page size, response shapes and
  error bodies: the URLs, parameters and response keys match Google's docs (read 2026-10-13), but
  the error-body shapes are from my knowledge, and I made no real call. The 403 reason strings
  (`ACCESS_TOKEN_SCOPE_INSUFFICIENT`, `SERVICE_DISABLED`, `rateLimitExceeded`, …) are matched by
  substring and may not match every real response, which would degrade to a generic `forbidden`.
- That a real Google export matches the fixtures column-for-column (I wrote them in the documented
  shape; I did not have a real export, and was told not to use real contacts).
- Any OAuth flow, token issuance, consent screen, verification outcome, or the 7-day testing-mode
  token expiry.
- Localised export headers beyond the loose "mail" match, and Apple/other vCard dialects beyond
  the properties named above.
- Browser behaviour: tests ran in Node (including `Blob`/`TextDecoder`), not in the extension.

Nothing here logs, phones home, or stores anything; contacts exist only in the arrays returned.
