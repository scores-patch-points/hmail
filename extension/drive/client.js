/*
 * hyphae drive — a small Google Drive v3 REST client.
 *
 * It takes an OAuth access token (a string, or a function that returns one,
 * called again with { refresh: true } after a 401) and does no sign-in of its
 * own. Nothing here knows about keys: it moves bytes and metadata. Sealing
 * lives in seal.js and the policy in sweep.js.
 *
 * Scopes, and why:
 *   https://www.googleapis.com/auth/drive.file   least privilege. Only files
 *       this app created or the user opened with it. Enough to seal what
 *       hyphae itself uploads; it cannot see or sweep the existing Drive.
 *   https://www.googleapis.com/auth/drive        needed to sweep EXISTING files
 *       (list them, replace their content, delete old revisions). A restricted
 *       scope: fine for the user's own unverified build, but a store listing
 *       needs Google's verification and security assessment.
 *   drive.readonly / drive.metadata.readonly can look but cannot seal.
 *
 * What it does for the caller: bearer auth, retry with exponential backoff and
 * jitter on 429 / 5xx / rate-limit 403 (honouring Retry-After), a request
 * spacing gate (qps), ranged + resumable downloads, and resumable uploads that
 * only commit on the final chunk — so a caller can verify before it commits.
 *
 * Worker/offscreen/Node only: it is given a token, so never load it in a page.
 */
(function (root, factory) {
  var hash = root.HyHash;
  if (!hash && typeof require === "function") hash = require("./hash.js");
  var api = factory(hash);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HyDriveClient = api;
})(typeof self !== "undefined" ? self : globalThis, function (HyHash) {
  "use strict";

  var API = "https://www.googleapis.com/drive/v3";
  var UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  var UNIT = 256 * 1024;                  // resumable chunks are multiples of this
  var DEFAULT_UPLOAD_CHUNK = 32 * UNIT;   // 8 MiB
  var FILE_FIELDS = "id,name,mimeType,size,md5Checksum,sha256Checksum,modifiedTime,version,headRevisionId," +
    "ownedByMe,shared,trashed,parents,properties,capabilities(canEdit,canTrash,canDelete,canAddChildren)," +
    "contentRestrictions(readOnly),shortcutDetails(targetId)";
  var RATE_REASONS = ["rateLimitExceeded", "userRateLimitExceeded", "sharingRateLimitExceeded", "backendError", "internalError"];
  var QUOTA_REASONS = ["dailyLimitExceeded", "quotaExceeded", "storageQuotaExceeded", "teamDriveFileLimitExceeded"];

  function apiError(code, status, reason, message) {
    var e = new Error("drive: " + message);
    e.code = code; e.status = status; e.reason = reason || null;
    return e;
  }
  function esc(s) { return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
  function qs(params) {
    var u = new URLSearchParams();
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null) u.set(k, String(params[k]));
    });
    var s = u.toString();
    return s ? "?" + s : "";
  }
  function defaultSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function concat(list, n) {
    var out = new Uint8Array(n), o = 0;
    for (var i = 0; i < list.length; i++) { out.set(list[i], o); o += list[i].length; }
    return out;
  }

  /**
   * create({ token, fetch?, sleep?, qps?, maxRetries?, signal?, base?, uploadBase? })
   */
  function create(opts) {
    opts = opts || {};
    var doFetch = opts.fetch || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    if (!doFetch) throw new Error("drive: no fetch available");
    var sleep = opts.sleep || defaultSleep;
    var now = opts.now || Date.now;
    var spacing = opts.qps === 0 ? 0 : Math.ceil(1000 / (opts.qps || 8));
    var maxRetries = opts.maxRetries === undefined ? 6 : opts.maxRetries;
    var base = opts.base || API, uploadBase = opts.uploadBase || UPLOAD;
    var signal = opts.signal || null;
    var tokenSource = opts.token;
    var cachedToken = typeof tokenSource === "string" ? tokenSource : null;
    var nextSlot = 0;
    var stats = { requests: 0, retries: 0, rateLimited: 0, bytesDown: 0, bytesUp: 0 };

    async function bearer(refresh) {
      if (typeof tokenSource === "string") return tokenSource;
      if (!tokenSource) throw apiError("auth", 0, null, "no access token supplied");
      if (!cachedToken || refresh) cachedToken = await tokenSource({ refresh: !!refresh });
      if (!cachedToken) throw apiError("auth", 0, null, "token source returned nothing");
      return cachedToken;
    }
    async function gate() {
      if (signal && signal.aborted) throw apiError("aborted", 0, null, "aborted");
      if (!spacing) return;
      var t = now();
      var at = Math.max(t, nextSlot);
      nextSlot = at + spacing;
      if (at > t) await sleep(at - t);
    }
    function backoff(attempt, retryAfter) {
      if (retryAfter > 0) return Math.min(retryAfter * 1000, 120000);
      return Math.min(60000, 1000 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 1000);
    }
    async function readError(resp) {
      var text = "";
      try { text = await resp.text(); } catch (e) { /* body gone */ }
      var reason = null, message = resp.status + " " + (resp.statusText || "");
      try {
        var j = JSON.parse(text);
        var er = j && j.error;
        if (er) {
          message = (er.message || message);
          reason = (er.errors && er.errors[0] && er.errors[0].reason) || er.status || null;
        }
      } catch (e) { /* not JSON */ }
      return { reason: reason, message: message };
    }
    function classify(status, reason, message) {
      if (status === 404) return apiError("not-found", status, reason, message);
      if (status === 401) return apiError("auth", status, reason, message);
      if (status === 403 || status === 400) {
        if (QUOTA_REASONS.indexOf(reason) >= 0) return apiError("quota", status, reason, message);
        if (status === 403) return apiError("forbidden", status, reason, message);
      }
      if (status === 429) return apiError("rate-limit", status, reason, message);
      if (status === 410) return apiError("gone", status, reason, message);
      return apiError("http", status, reason, message);
    }

    /** One logical request, with retries. okStatus lists non-2xx statuses that are success (308, 416...). */
    async function call(method, url, o) {
      o = o || {};
      var attempt = 0, refreshed = false;
      for (;;) {
        await gate();
        var headers = {};
        Object.keys(o.headers || {}).forEach(function (k) { headers[k] = o.headers[k]; });
        if (!o.noAuth) headers.Authorization = "Bearer " + await bearer(false);
        var resp;
        stats.requests++;
        try {
          resp = await doFetch(url, { method: method, headers: headers, body: o.body, signal: signal || undefined });
        } catch (e) {
          if (signal && signal.aborted) throw apiError("aborted", 0, null, "aborted");
          if (o.noRetryNetwork) throw apiError("network", 0, null, "network error: " + (e && e.message));
          if (attempt++ >= maxRetries) throw apiError("network", 0, null, "network error: " + (e && e.message));
          stats.retries++;
          await sleep(backoff(attempt, 0));
          continue;
        }
        if (resp.ok || (o.okStatus && o.okStatus.indexOf(resp.status) >= 0)) return resp;
        var ra = parseFloat(resp.headers && resp.headers.get && resp.headers.get("retry-after"));
        var info = await readError(resp);
        if (resp.status === 401 && !refreshed && !o.noAuth && typeof tokenSource === "function") {
          refreshed = true;
          await bearer(true);
          continue;
        }
        var transient = resp.status === 429 || resp.status >= 500 ||
          (resp.status === 403 && RATE_REASONS.indexOf(info.reason) >= 0);
        if (transient && attempt < maxRetries) {
          attempt++;
          stats.retries++;
          if (resp.status === 429 || resp.status === 403) stats.rateLimited++;
          await sleep(backoff(attempt, isNaN(ra) ? 0 : ra));
          continue;
        }
        throw classify(resp.status, info.reason, info.message);
      }
    }
    async function json(method, url, o) {
      var resp = await call(method, url, o);
      var text = await resp.text();
      return text ? JSON.parse(text) : {};
    }

    // ---- metadata ---------------------------------------------------------------
    var client = {
      FILE_FIELDS: FILE_FIELDS, stats: stats, esc: esc, UNIT: UNIT,

      about: function () {
        return json("GET", base + "/about" + qs({ fields: "user(permissionId,emailAddress,displayName),storageQuota" }));
      },
      /** One page of files.list: { files, nextPageToken }. */
      list: function (p) {
        p = p || {};
        return json("GET", base + "/files" + qs({
          q: p.q, pageSize: p.pageSize || 1000, pageToken: p.pageToken, orderBy: p.orderBy,
          fields: p.fields || ("nextPageToken,files(" + FILE_FIELDS + ")"),
          spaces: "drive", supportsAllDrives: true, includeItemsFromAllDrives: true,
        }));
      },
      /** Every page; calls onFile(file) for each. */
      listAll: async function (p, onFile) {
        var token = null, n = 0;
        do {
          var page = await client.list({ q: p.q, fields: p.fields, orderBy: p.orderBy, pageSize: p.pageSize, pageToken: token });
          var files = page.files || [];
          for (var i = 0; i < files.length; i++) { n++; if ((await onFile(files[i])) === false) return n; }
          token = page.nextPageToken || null;
        } while (token);
        return n;
      },
      get: function (id, fields) {
        return json("GET", base + "/files/" + encodeURIComponent(id) + qs({ fields: fields || FILE_FIELDS, supportsAllDrives: true }));
      },
      patch: function (id, body, params) {
        var p = { fields: (params && params.fields) || FILE_FIELDS, supportsAllDrives: true };
        if (params && params.addParents) p.addParents = params.addParents;
        if (params && params.removeParents) p.removeParents = params.removeParents;
        return json("PATCH", base + "/files/" + encodeURIComponent(id) + qs(p), {
          headers: { "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify(body || {}),
        });
      },
      /** Reversible: moves to trash. Never calls files.delete. */
      trash: function (id) { return client.patch(id, { trashed: true }); },
      untrash: function (id) { return client.patch(id, { trashed: false }); },
      /** Irreversible. The sweep calls it only on an explicit purge, after read-back. */
      deletePermanently: async function (id) {
        await call("DELETE", base + "/files/" + encodeURIComponent(id) + qs({ supportsAllDrives: true }));
      },
      create: function (metadata) {
        return json("POST", base + "/files" + qs({ fields: FILE_FIELDS, supportsAllDrives: true }), {
          headers: { "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify(metadata || {}),
        });
      },
      /** Files carrying a given custom property. */
      findByProperty: async function (key, value, extraQ) {
        var q = "properties has { key='" + esc(key) + "' and value='" + esc(value) + "' } and trashed = false" + (extraQ ? " and " + extraQ : "");
        var out = [];
        await client.listAll({ q: q }, function (f) { out.push(f); });
        return out;
      },

      // ---- revisions ----------------------------------------------------------------
      revisions: async function (id) {
        var out = [], token = null;
        do {
          var r = await json("GET", base + "/files/" + encodeURIComponent(id) + "/revisions" + qs({
            fields: "nextPageToken,revisions(id,modifiedTime,size,md5Checksum,keepForever)", pageSize: 200, pageToken: token,
          }));
          out = out.concat(r.revisions || []);
          token = r.nextPageToken || null;
        } while (token);
        return out;
      },
      deleteRevision: async function (id, revId) {
        await call("DELETE", base + "/files/" + encodeURIComponent(id) + "/revisions/" + encodeURIComponent(revId));
      },
      unpinRevision: function (id, revId) {
        return json("PATCH", base + "/files/" + encodeURIComponent(id) + "/revisions/" + encodeURIComponent(revId) + qs({ fields: "id,keepForever" }), {
          headers: { "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify({ keepForever: false }),
        });
      },

      // ---- changes ------------------------------------------------------------------
      startPageToken: async function () {
        var r = await json("GET", base + "/changes/startPageToken" + qs({ supportsAllDrives: true }));
        return r.startPageToken;
      },
      /** One page of changes: { changes: [{fileId, removed, file}], nextPageToken?, newStartPageToken? }. */
      changes: function (pageToken) {
        return json("GET", base + "/changes" + qs({
          pageToken: pageToken, pageSize: 500, spaces: "drive", includeRemoved: true, restrictToMyDrive: true,
          supportsAllDrives: true, includeItemsFromAllDrives: true,
          fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(" + FILE_FIELDS + "))",
        }));
      },

      // ---- download -------------------------------------------------------------------
      /** A streaming Response of the file's bytes (or one of its revisions). range: "bytes=0-61". */
      download: async function (id, o) {
        o = o || {};
        var url = base + "/files/" + encodeURIComponent(id) +
          (o.revisionId ? "/revisions/" + encodeURIComponent(o.revisionId) : "") +
          qs({ alt: "media", supportsAllDrives: true });
        var headers = o.range ? { Range: o.range } : {};
        var resp = await call("GET", url, { headers: headers });
        if (o.range && resp.status === 200 && !/^bytes=0-/.test(o.range)) throw apiError("range", 200, null, "server ignored the Range header");
        return resp;
      },
      exportFile: function (id, mimeType) {
        return call("GET", base + "/files/" + encodeURIComponent(id) + "/export" + qs({ mimeType: mimeType }));
      },
      /** Feed a Response body to onChunk(Uint8Array), awaiting each. */
      pump: async function (resp, onChunk) {
        var total = 0;
        function feed(u8) {
          total += u8.length;
          stats.bytesDown += u8.length;
          return Promise.resolve(onChunk(u8)).catch(function (e) { e.fromConsumer = true; throw e; });
        }
        if (resp.body && resp.body.getReader) {
          var rd = resp.body.getReader();
          for (;;) {
            var r = await rd.read();
            if (r.done) break;
            if (r.value && r.value.length) await feed(r.value);
          }
        } else {
          await feed(new Uint8Array(await resp.arrayBuffer()));
        }
        return total;
      },
      /**
       * Download a whole file (or revision) into onChunk, resuming with a Range
       * request from the byte already delivered if the connection drops.
       * Returns the byte count.
       */
      downloadTo: async function (id, onChunk, o) {
        o = o || {};
        var received = 0, attempt = 0;
        for (;;) {
          try {
            var resp = await client.download(id, {
              revisionId: o.revisionId,
              range: received > 0 ? "bytes=" + received + "-" : null,
            });
            if (received > 0 && resp.status !== 206) throw apiError("range", resp.status, null, "resume needs a 206");
            await client.pump(resp, function (u8) { received += u8.length; return onChunk(u8); });
            return received;
          } catch (e) {
            if (e.fromConsumer || e.code === "aborted" || (e.code && e.code !== "network" && e.code !== "http")) throw e;
            if (e.status && e.status < 500 && e.status !== 429) throw e;
            if (attempt++ >= maxRetries) throw e;
            stats.retries++;
            await sleep(backoff(attempt, 0));
          }
        }
      },

      // ---- resumable upload -------------------------------------------------------------
      /**
       * Start a resumable upload; nothing is committed until finish() sends the
       * last bytes, so a caller can verify everything it has read and still
       * abort. totalSize must be exact (seal.sealedSize gives it).
       *   o: { fileId? (update in place) | parents? (create), metadata?, totalSize,
       *        contentType?, chunkSize?, fields? }
       * Returns { write(u8), finish() -> file resource, abort(), sha256(), md5(), sent }.
       */
      startUpload: async function (o) {
        var total = o.totalSize;
        if (typeof total !== "number" || total < 1) throw apiError("upload", 0, null, "totalSize is required and must be positive");
        var chunkSize = o.chunkSize || DEFAULT_UPLOAD_CHUNK;
        if (chunkSize % UNIT !== 0) throw apiError("upload", 0, null, "upload chunk must be a multiple of 256 KiB");
        var meta = {};
        Object.keys(o.metadata || {}).forEach(function (k) { meta[k] = o.metadata[k]; });
        if (!o.fileId && o.parents) meta.parents = o.parents;
        var url = uploadBase + "/files" + (o.fileId ? "/" + encodeURIComponent(o.fileId) : "") +
          qs({ uploadType: "resumable", supportsAllDrives: true, fields: o.fields || FILE_FIELDS });
        var init = await call(o.fileId ? "PATCH" : "POST", url, {
          headers: {
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": o.contentType || "application/octet-stream",
            "X-Upload-Content-Length": String(total),
          },
          body: JSON.stringify(meta),
        });
        var session = init.headers.get("location");
        if (!session) throw apiError("upload", init.status, null, "no upload session URL returned");

        var pending = [], pendingLen = 0, sent = 0, closed = false, result = null;
        var sha = HyHash.sha256(), md5 = HyHash.md5(), shaHex = null, md5Hex = null;

        function takePending(n) {
          var out = new Uint8Array(n), p = 0;
          while (p < n) {
            var piece = pending[0], need = n - p;
            if (piece.length <= need) { out.set(piece, p); p += piece.length; pending.shift(); }
            else { out.set(piece.subarray(0, need), p); pending[0] = piece.subarray(need); p += need; }
          }
          pendingLen -= n;
          return out;
        }
        function persistedFrom(resp) {
          var r = resp.headers.get("range"), m = r && /bytes=0-(\d+)/.exec(r);
          return m ? parseInt(m[1], 10) + 1 : 0;
        }
        async function status() {
          var resp = await call("PUT", session, {
            noAuth: true, okStatus: [308],
            headers: { "Content-Range": "bytes */" + total },
          });
          if (resp.status === 308) return { done: false, persisted: persistedFrom(resp) };
          return { done: true, file: JSON.parse(await resp.text() || "{}") };
        }
        async function sendChunk(buf, isFinal) {
          var start = sent, end = start + buf.length - 1, offset = 0, attempt = 0;
          for (;;) {
            var from = start + offset;
            var piece = offset ? buf.subarray(offset) : buf;
            var resp = null, netErr = null;
            try {
              resp = await call("PUT", session, {
                noAuth: true, okStatus: [308], noRetryNetwork: true,
                headers: { "Content-Range": "bytes " + from + "-" + end + "/" + total, "Content-Type": o.contentType || "application/octet-stream" },
                body: piece,
              });
            } catch (e) {
              if (e.code === "aborted" || e.code === "not-found" || e.code === "gone" || e.code === "auth") {
                if (e.code === "not-found" || e.code === "gone") throw apiError("upload-expired", e.status, null, "upload session is gone");
                throw e;
              }
              if (e.code === "quota" || e.code === "forbidden") throw e;
              netErr = e;
            }
            if (resp) {
              stats.bytesUp += piece.length;
              if (resp.status === 308) {
                var persisted = persistedFrom(resp);
                if (persisted >= end + 1) { sent = end + 1; return null; }
                if (persisted < start) throw apiError("upload", 308, null, "server lost bytes before this chunk (" + persisted + " < " + start + ")");
                offset = persisted - start;
                continue;
              }
              var text = await resp.text();
              if (!isFinal) throw apiError("upload", resp.status, null, "upload completed before the final chunk");
              sent = end + 1;
              return text ? JSON.parse(text) : {};
            }
            // a network error or exhausted 5xx retries: ask the server where it is
            if (attempt++ >= maxRetries) throw netErr;
            stats.retries++;
            await sleep(backoff(attempt, 0));
            var st = await status();
            if (st.done) {
              if (!isFinal) throw apiError("upload", 200, null, "upload completed before the final chunk");
              sent = end + 1;
              return st.file;
            }
            if (st.persisted >= end + 1) { sent = end + 1; return null; }
            offset = Math.max(0, st.persisted - start);
          }
        }

        var uploader = {
          get sent() { return sent + pendingLen; },
          write: async function (u8) {
            if (closed) throw apiError("upload", 0, null, "upload is closed");
            if (!u8 || !u8.length) return;
            sha.update(u8); md5.update(u8);
            pending.push(u8); pendingLen += u8.length;
            // strictly greater: at least one byte stays back for finish(), so the
            // commit can never happen inside write().
            while (pendingLen > chunkSize) await sendChunk(takePending(chunkSize), false);
          },
          finish: async function () {
            if (closed) throw apiError("upload", 0, null, "upload is closed");
            if (sent + pendingLen !== total) {
              closed = true;
              throw apiError("upload-size", 0, null, "wrote " + (sent + pendingLen) + " bytes, declared " + total);
            }
            var rest = takePending(pendingLen);
            closed = true;
            result = await sendChunk(rest, true);
            return result;
          },
          /** Walk away without committing: the session simply expires on Drive's side. */
          abort: async function () {
            closed = true;
            pending = []; pendingLen = 0;
          },
          // digests of every byte written; call after finish() (they finalize the hash)
          sha256: function () { if (shaHex === null) shaHex = HyHash.hex(sha.digest()); return shaHex; },
          md5: function () { if (md5Hex === null) md5Hex = HyHash.hex(md5.digest()); return md5Hex; },
        };
        return uploader;
      },
    };
    return client;
  }

  return { create: create, FILE_FIELDS: FILE_FIELDS, UNIT: UNIT, esc: esc };
});
