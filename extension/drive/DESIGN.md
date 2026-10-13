# hyphae drive — sealing a Google Drive

Goal: everything in the user's Drive that *can* be encrypted client-side is, with the circle key held
only in the extension worker; old content can be cycled through and sealed; new content is sealed
on fresh boot. This note says what that does and does not buy. Read §2 and §10 before promising
anyone "your Drive is encrypted".

## 1. In one paragraph

Uploaded files (pdf, images, office files, text, zips, anything with binary content) are replaced
in place by a sealed blob, `hyd1`, under a circle key. Names are replaced by opaque ones and kept
inside the sealed file, with a sealed index file as a cache. Google Docs, Sheets, Slides and the
other native Google types cannot be sealed. A sweep walks the Drive, an auto mode repeats it on
startup, every file is read back and decrypted before anything irreversible happens, and every
step has an undo.

## 2. What can and cannot be encrypted

| Kind of thing | Sealed? | Why |
| --- | --- | --- |
| Uploaded binary files (pdf, jpg, png, docx/xlsx/pptx as files, txt, csv, zip, mp4…) | **Yes** — the bytes | Drive stores them as opaque blobs; we replace the blob |
| Google Docs / Sheets / Slides / Forms / Drawings / Sites / Jamboard | **No** | They have no file content on Drive. They live in Google's own format and are edited, rendered (canvas) and co-edited by Google's servers, which must read the plaintext to do it. A sealed Doc cannot be opened in the Docs editor |
| Opt-in `native: "export-copy"` | A **sealed copy** only | Exports Doc/Sheet/Slide/Drawing to docx/xlsx/pptx/png (Drive caps an export at 10 MB), seals the export. The original stays plaintext unless you also pass `trashOriginal`, and trashing it kills live editing and links. The export is lossy (comments, suggestions, version history, add-ons). Off by default |
| Folders, shortcuts | Nothing to seal | Folders have no content; shortcuts point elsewhere |
| Files you don't own, files shared with others | **Skipped by default** | Rewriting a shared file hands your collaborators ciphertext; rewriting someone else's file rewrites *their* file. Opt in with `includeShared` / `includeNotOwned` |
| Files with read-only content restrictions, or that you cannot edit | Skipped | The update would be refused |
| Shared drives | Not covered | Not exercised; `supportsAllDrives` is set but ownership rules differ |

## 3. What Google still sees

After a full sweep with defaults:

- **That a file exists**, when it was created and last modified (modified time becomes the time of
  sealing; the original is kept only inside the sealed metadata), its **size** (plaintext size plus
  about 16 bytes per MiB plus a few hundred bytes — so size still tells large from small and often file *type*),
  its owner, who it is shared with, and when and from where you open it.
- **Folder names and the folder structure.** Folders are not sealed. A file called `hy-….hyd` inside
  a folder called "Chemo 2026" still tells a story. Sealing folder names would need an index as the
  single source of truth for them (folders have no content to hide a name in); not built.
- **That you use hyphae**: the extension marks sealed files with Drive custom properties
  (`hysealed`, `hykid` = circle id, `hymd5`). `properties` are visible to any app with access. The
  circle id is already visible in every `hy1.` token, so this adds nothing a token doesn't.
- Not seen: content, original names, original MIME types (replaced by `application/octet-stream`),
  and, in the index, folder paths.

What stops working on a sealed file: Drive search by content, previews and thumbnails, opening in
Docs/Office online, Google's sharing as a way to *show* someone a file (they get ciphertext unless
they hold the circle and the extension), Drive for desktop/mobile viewing, malware/DLP scanning.
That is the point, and it is the price.

## 4. Names — decision

**Sealed by default (`names: "opaque"`)**: a sealed file is renamed `hy-<24 random base32>.hyd`. Not
a hash of the real name (that would let anyone test guessed names). The real name, type, size and
mtime are the first record inside the sealed file (META), so the file describes itself; a **sealed
index** (`catalog.js`, one `.hyd` file found by property `hyindex`) maps file id → name/type/size/
mtime/path so a UI can list a Drive without opening every file. The index is a cache: lose it and
`rebuild()` re-reads each file's first ~1 KiB with a ranged request. Alternatives `names: "suffix"`
(`name.ext.hyd`) and `names: "keep"` exist for people who prefer a browsable Drive to name privacy.
Why opaque is the default: the user's goal was "everything in Drive encrypted", and file names are
frequently the most sensitive part of a file (`Divorce settlement.pdf`).

## 5. The sealed format (`hyd1`)

Built from crypto.js's primitive — **AES-256-GCM under the circle's 32-byte key, circle id bound in
as additional data** — and not weaker. What a blob needs beyond a token is streaming, so:

```
header   62 B, plain      "HYD1" | version 1 | flags 0 | circle id (8) | chunk size u32 | salt (32) | nonce base (12)
records  u32 length (top bit = final) | AES-GCM ciphertext+tag
           #0      META   {v, name, mime, size, mtime, id, path}   JSON
           #1..n   DATA   plaintext chunks, chunk size each, last may be shorter
           #n+1    FINAL  chunk count u32 | length u64 | sha256 | md5     (the manifest)
```

- **Per-file subkey**: `HKDF-SHA256(circle key, salt = header.salt, info = "hyphae-drive-v1/file-key" | circle id)`.
  The circle key never encrypts file data directly; a file and a `hy1.` token can't be confused; no
  (key, nonce) pair repeats across files however many are sealed. (crypto.js uses one random 96-bit
  IV per token under the circle key; that is fine for short text, not for an unbounded number of
  chunks.)
- **Nonce** = header nonce base with the record index folded into its last four bytes.
- **Additional data** for every record = the entire header | type byte | record index. So a record
  can't be moved, repeated or dropped (index), re-labelled as another circle (circle id is in the
  header, and also in the key derivation), spliced in from another file (salt/nonce/header), or
  relabelled by changing the chunk size (header is authenticated).
- **Manifest = the FINAL record.** A file without an authenticated FINAL record, or with any byte
  after it, is refused — that is what makes truncation at a record boundary detectable. The manifest
  repeats count, length and sha256/md5 of the plaintext, and the opener recomputes them.
- **Streaming contract**: plaintext is handed out as each record authenticates, but the file is only
  whole once `end()` returns. Anything durable that consumes the stream must not commit before then;
  `sweep.js` honours that (its upload cannot commit until the final chunk is sent).
- **Bounds**: a header may not ask for a chunk size above 16 MiB, and a frame may not claim more
  than chunk size + 16, so a hostile file cannot make us buffer gigabytes.
- **Errors** are typed: `auth` (wrong key or changed), `no-key`, `tampered`, `truncated`,
  `trailing-data`, `bad-frame`, `bad-header`, `manifest`.

Throughput in Node, pure-JS hashing included: ~35–50 MB/s each way. The hashes are the slow part;
they exist so read-back can be compared with Drive's own `md5Checksum`/`sha256Checksum`.

## 6. In place or sibling — decision

| | **In place (default)** | Sibling |
| --- | --- | --- |
| File id, share links, folder, comments | **Kept** | New id; shares and links break |
| How | Resumable `files.update` of content + name + properties in one commit | New file next to the original |
| Original plaintext afterwards | An **older revision** of the same file | The original, in the **trash** |
| To really remove it | `revisions.delete` of the older revisions | `files.delete` (irreversible) |
| Needs | edit permission on the file | add-children on the parent |
| Rollback if read-back fails | Re-upload the previous revision into the head | Trash the sibling; original untouched |

In place is the default because breaking people's links to every file is not an acceptable side
effect of "encrypt my Drive", and because a single atomic commit is easier to reason about than
create-then-trash. Its cost is that the plaintext survives as a revision until purged, which is why
purge is a first-class step (§7), not an afterthought.

## 7. Order of operations for one file, and what "verified" means

1. **Classify** from the listing (never touch folders, native files, sealed files, shared or
   not-owned files, read-only files).
2. **Read** the original as a stream, hashing it as it passes.
3. **Seal and send** each chunk into a resumable upload. The upload cannot commit until the last
   bytes are sent (the uploader always holds at least one byte back).
4. **Check before commit.** Bytes read must equal Drive's reported size and `sha256Checksum` (else
   `md5Checksum`); the file's `version`/`headRevisionId` must not have moved. Otherwise abort: Drive
   was never written to.
5. **Commit.** Same file id; old content becomes the previous revision. Ledger says `committing`
   first.
6. **Read back.** Download the sealed head and open it with the key: every record authenticates, the
   manifest matches, and the plaintext's sha256 equals what was read in step 2. Drive's checksum of
   the sealed upload must equal what we sent. Failure → restore the previous revision into the head
   and report; the file ends where it started.
7. **Record** `hymd5` (md5 of the sealed head) as a property. A sealed mark is trusted only while the
   head md5 still equals it, so a plaintext version uploaded onto a sealed file later is noticed
   and sealed again rather than silently skipped.
8. **Purge — only on request.** Re-checks that the revision immediately before the head has the
   plaintext's md5, then deletes older revisions. `purge: true` does this right after step 6;
   `purgeAll()` does it later, re-verifying each file. Until then the plaintext is on Drive.

"Never delete the only copy until the sealed copy is verified" is therefore enforced three ways:
nothing is deleted by default; purge re-reads the sealed head itself; and it requires the previous
revision to match the sealed plaintext by md5.

**Undo**: `unsealOne` / `unsealAll` stream the file through the opener (nothing committed until the
manifest has verified) and write plaintext back into the *same* file id with name and type restored
from META and the marks removed; the restored content's Drive checksum is compared with the
manifest. `readSealed` opens one file in memory without writing anything.

## 8. Resumable, idempotent, rate-limit aware

- **Never double-seals.** A file is skipped if it carries the sealed property (and its md5 still
  matches) *or* its first bytes are a valid `hyd1` header (unmarked files sealed by something else
  are adopted: marked, not touched again).
- **Resumable.** Progress is a ledger keyed by Drive file id (no names) in storage the owner
  supplies (`chrome.storage.local` adapter included). A run killed anywhere is simply continued:
  re-listing skips sealed files without reading content; a file killed between commit and
  read-back is `committing` in the ledger and is verified by the next run. Failed files keep an
  attempt count (default 3).
- **Rate limits.** A spacing gate (default 6 requests/s), exponential backoff with jitter on 429,
  5xx and rate-limit 403s honouring `Retry-After`, a token refresh on 401, resumable uploads that
  resume from the server's reported offset. Quota errors (`storageQuotaExceeded`) and auth errors
  abort the sweep with a typed reason; other file errors don't stop it.
- **Auto mode** is off until `settings.enabled`. First run (and weekly, and whenever the Drive
  changes token is stale) is a full sweep; every other boot reads the Drive **changes feed** from
  the saved token and processes new, edited, moved and newly shared files plus earlier failures.
  The token is taken *before* a full walk so nothing changed during it is missed. Startup runs are
  never interactive. `dryRun` does a complete read-only pass and writes nothing — not even the
  ledger or token.

## 9. Scopes, and where it runs

| Scope | Gives | Use it when |
| --- | --- | --- |
| `drive.file` | Only files this app created or the user opened with it | You only seal what hyphae itself uploads. **Cannot see or sweep the existing Drive.** Non-sensitive-adjacent: no heavy verification |
| `drive` | Everything | You want a sweep of existing files (list, replace content, delete revisions). Restricted scope: fine for the user's own unverified build ("unverified app" screen, 100 test users); a store listing needs Google's verification and annual security assessment |
| `drive.readonly` / `drive.metadata.readonly` | Read / list | Neither can seal |

The minimum for the stated goal (existing files, in place) is `drive`. `drive.file` is the minimum
for sealing-at-upload and is the better long-term home for new uploads (§10, first item).

Everything here runs where the key is: the worker, an offscreen document, or Node. The router
(`HyDriveBoot.route`) refuses any message with a `sender.tab`, i.e. from a content script, because a
content script lives beside a page, and nothing here — least of all opened plaintext — may reach
one. Keys are never in a request: the tests assert the circle key and a plaintext marker appear in
no request body or URL.

## 10. Honest limits

1. **A sweep seals after upload.** Google already had the plaintext, for as long as it sat there,
   and may hold derived data (search index, thumbnails, OCR/classification, caches, backups) that
   no API lets us purge. Only sealing *before* upload prevents that, and this module does not
   intercept uploads from the Drive web UI or Drive for desktop. It is "encrypted from now on", not
   "Google never saw it".
2. **Until purge, plaintext remains** as an older revision (in place) or in the trash (sibling).
   Drive eventually expires older revisions, commonly around 30 days unless pinned, but don't rely
   on that. Purge deletes version history irreversibly. Workspace admins and Vault can read revisions
   until then.
3. **Storage roughly doubles until purge** (old revision + sealed head). Near the quota, seal with
   `purge: true` or in small batches.
4. **Key loss is data loss.** A sealed file is unreadable without the circle key, and a purge
   removes the only other copy. The circle key must be backed up out of band *before* a purge.
   Anyone holding the key reads everything sealed to it; there is no per-file sharing and no
   revocation short of a new circle and re-sealing (unseal, then seal under the new circle).
5. **Commit race.** Drive has no precondition header on a content update. We check the version
   immediately before the final chunk, but an edit landing in that window would be overwritten
   (it remains as the previous revision and is not lost; the read-back still verifies our write).
6. **Not live-tested end to end.** See §11.
7. Sealed size leaks plaintext size (no padding); modified time becomes the seal time.
8. A Manifest V3 service worker can be stopped mid-sweep. Everything is resumable per file, and a
   long run belongs in an offscreen document or an extension tab; the worker alarm only starts it.
   Memory is bounded (one chunk + one upload chunk per file in flight), not the file size.
9. `chrome.identity.getAuthToken` does not work in Brave; `webAuthFlowToken` (implicit grant, own
   web client id, 1-hour tokens) is the fallback, and is untested against a real consent screen.
10. Default maximum file size is 4 GiB; Drive's own daily upload cap (about 750 GB/day) applies.
11. Native Google files remain plaintext on Google. That is most people's Drive. No client-side
    scheme fixes it, because the server edits them.

## 11. What was tested, and how

- **Where:** `extension/drive/test/` (`cd extension/drive/test && node run-all.js`; its `package.json`
  makes the files CommonJS under the module-typed repo root). `mock-drive.js` there is also a classic
  script (global `HyMockDrive`: `create()`, `seed()`, `list()`, `bytes()`, `fetch`) for demos.
- **Node, against the real code:** hashes vs `node:crypto`; the format (round trip at every
  boundary, any single flipped byte, every truncation, extension, reorder/repeat/drop, splice,
  re-label, wrong key, header chunk size, hostile lengths, subkey separation, writer-bug manifest);
  the client (retry/backoff/Retry-After, 401 refresh, typed errors, spacing gate, ranged and
  resumed download, resumable upload with network drop and 503, no commit before `finish()`); the
  sweep (idempotency, purge, two-phase purge, rollback, source corruption, edit during seal, crash
  recovery, cancel/resume, dry run, adoption, stale mark, shared/not-owned, folder scope, sibling,
  export-copy, unseal, index rebuild, quota, rate limits, concurrency, no key/plaintext on the
  wire); auto mode (off by default, no token/circle, full then changes feed, dry run writes
  nothing, stale token, weekly full, folder scope, retry, router refuses tabs, alarms).
- **Against a mock Drive** (`mock-drive.js`, an in-process fake of the endpoints the client uses,
  written from the documented behaviour — *not* Google). Everything above that touches Drive ran
  here only.
- **Live, once:** a 1,753-byte sealed blob (all 256 byte values in the plaintext) was uploaded to
  a throwaway folder in a real Drive through the Drive connector, downloaded back, found
  byte-identical, opened with the key, then trashed. That proves Drive stores binary content
  unmodified; it does **not** exercise this module's Drive client, the resumable protocol,
  revisions, the changes feed or any rate-limit behaviour against Google.
- **Mutation check:** 17 deliberate breakages of the safety guards were run against the suite; the
  four that first survived were an equivalent mutant (index in both nonce and AAD) and three real
  gaps, closed with new tests.
