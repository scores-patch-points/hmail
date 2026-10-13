# Wiring hyphae drive into the extension

Apply by the owner of `background.js` and `manifest.json`. Nothing under `extension/drive/` has been
imported or registered anywhere yet; the drive code is inert until these lines go in.

## background.js — 9 lines, at the top level (listeners must exist when the worker wakes)

```js
importScripts("drive/hash.js", "drive/seal.js", "drive/client.js", "drive/sweep.js", "drive/catalog.js", "drive/boot.js");
var hyDrive = HyDriveBoot.runner({
  storage: HyDriveSweep.chromeStorageAdapter(chrome.storage.local),
  getCircles: async function () { return (await chrome.storage.local.get("circles")).circles || {}; },
  getToken: HyDriveBoot.chromeIdentityToken(chrome),   // Brave: HyDriveBoot.webAuthFlowToken(chrome, { clientId: "<web client id>" })
});
HyDriveBoot.arm(chrome, hyDrive);                      // fresh boot (+15 s) and a 3-hourly alarm; both no-ops until settings.enabled
chrome.runtime.onMessage.addListener(function (msg, sender, send) {
  var p = HyDriveBoot.route(hyDrive, msg, sender, chrome.runtime.id);   // null unless msg.hyphae === "drive"
  if (!p) return; p.then(send, function (e) { send({ error: String(e && e.message || e) }); }); return true;
});
```

`getCircles` returns the same `{ kid: { kid, name, key } }` map the worker already keeps under
`circles`. The key is passed to the drive code *inside the worker*; it is never sent to a tab,
and `route()` refuses any message that has a `sender.tab` (a content script sits beside a page).

## manifest.json — 3 additions

```json
"permissions": ["storage", "activeTab", "scripting", "identity", "alarms"],
"host_permissions": ["https://www.googleapis.com/*"],
"oauth2": { "client_id": "<your>.apps.googleusercontent.com", "scopes": ["https://www.googleapis.com/auth/drive"] }
```

- `oauth2` is only read by `chrome.identity.getAuthToken` (Chrome). With `webAuthFlowToken`
  (Brave, Edge, Firefox-style flows) leave it out and register the extension's redirect URL
  (`chrome.identity.getRedirectURL()`) on a *Web application* OAuth client.
- Scope: `drive` to sweep existing files; `drive.file` is enough only for files hyphae itself
  uploaded. See DESIGN.md §9. The Google Cloud project needs the Drive API enabled and, while the
  app is unverified, the user added as a test user.

## Messages for popup.js (extension pages only; owner of popup.js decides the UI)

`chrome.runtime.sendMessage({ hyphae: "drive", op, args })`

| op | args | returns |
| --- | --- | --- |
| `status` | | settings, ledger counts, last run summary |
| `settings` / `set-settings` | `{ enabled, circleKid, folderId, names, mode, purge, includeShared, native, fullEveryDays }` | settings |
| `dry-run` | | `{ report }` with `plan[]` and `estimate` — writes nothing |
| `sweep` | `{ concurrency, maxFiles }` | `{ report }` (seals the backlog now) |
| `auto` | `{ force, full, dryRun }` | `{ ran, via: "full"\|"changes", report }` |
| `purge-all` | | deletes older plaintext revisions of verified files, re-verifying each |
| `unseal-one` / `unseal-all` | `{ id }` | restores plaintext in place |
| `read` | `{ id }` | `{ meta, bytes }` of one sealed file, for an extension page |
| `rebuild-index` | | `{ entries }` |

Defaults are conservative on purpose: `enabled: false`, `purge: false`, `names: "opaque"`,
`mode: "inplace"`, shared/not-owned files skipped, native Google files skipped. A UI should show
the dry-run report and the "key loss is data loss; back the circle up before purging" warning
before it sets `enabled` or `purge`.

## Two things to know when you wire it

- A long sweep belongs in an offscreen document or an extension tab; a Manifest V3 worker can be
  stopped mid-run. It is safe either way (per-file resume, DESIGN.md §8) — it just restarts at the
  next alarm.
- The extension's `package.json` is `"type": "module"`, so a bare Node `require()` of
  `extension/**/*.js` yields an empty namespace (crypto.js has the same property). The tests load
  the UMD files by evaluating their source; if you want plain `require` in Node, give `extension/`
  its own `package.json` with `{"type":"commonjs"}`.
