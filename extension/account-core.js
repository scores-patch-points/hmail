/*
 * hyphae account — sign in, create an account, reset a password, against the hyphae
 * homeserver's Matrix client API. Pure: it is given fetch, so the same file runs in the
 * extension pages and in Node tests, and it touches no storage and no DOM.
 *
 * What it never does: keep a password. The password goes in the request body to the
 * homeserver and nowhere else. A session token is returned to the caller to keep.
 *
 * Email: a new account binds the email through the homeserver's own verification mail, and
 * that same bound address is what makes "forgot password" work. The homeserver sends the
 * mail; the person follows its link; this module polls until the homeserver accepts.
 *
 * The sign-in gate in front of hyphae.social (an authenticator code) is a second factor
 * the person types after the password; it is sent as the six digits appended to the
 * password, which is what the gate accepts. A server without the gate ignores nothing:
 * the code box is only shown when the server answers that a code is needed.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HyAccount = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  var HOMESERVER = "https://hyphae.social";

  function fail(code, message, extra) {
    var e = new Error(message);
    e.code = code;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }

  function secret() {
    var b = new Uint8Array(18);
    (globalThis.crypto || require("node:crypto").webcrypto).getRandomValues(b);
    var s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(97 + (b[i] % 26));
    return s + Date.now().toString(36);
  }

  function create(opts) {
    var f = opts.fetch, base = String(opts.homeserver || HOMESERVER).replace(/\/+$/, "");

    async function call(method, path, body, token) {
      var r;
      try {
        r = await f(base + path, {
          method: method,
          headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: "omit",
        });
      } catch (e) { throw fail("network", "Can't reach " + base.replace(/^https?:\/\//, "") + ". Check your connection."); }
      var j = {};
      try { j = await r.json(); } catch (e) { /* no body */ }
      return { status: r.status, json: j };
    }

    function explain(r) {
      var c = r.json && r.json.errcode, m = (r.json && r.json.error) || "";
      if (c === "M_LIMIT_EXCEEDED") return fail("rate", "Too many tries. Wait a moment and try again.");
      if (c === "M_USER_IN_USE") return fail("taken", "That username is taken.");
      if (c === "M_INVALID_USERNAME") return fail("username", m || "That username isn't allowed.");
      if (c === "M_WEAK_PASSWORD") return fail("weak", m || "That password is too weak.");
      if (c === "M_THREEPID_IN_USE") return fail("email-used", "That email already has an account. Sign in instead.");
      if (c === "M_THREEPID_NOT_FOUND") return fail("email-unknown", "No account uses that email.");
      if (c === "M_THREEPID_AUTH_FAILED") return fail("email-pending", "The email hasn't been confirmed yet.");
      if (c === "M_FORBIDDEN") return fail("forbidden", /code|authenticator|totp/i.test(m) ? "Enter the 6-digit code from your authenticator." : "That email, username or password isn't right.", /code|authenticator|totp/i.test(m) ? { needCode: true } : {});
      return fail(c || "error", m || "The server answered " + r.status + ".");
    }

    function session(j) {
      return { userId: j.user_id, accessToken: j.access_token, deviceId: j.device_id };
    }

    /** id: an email, "@name:server" or a bare username. code: optional authenticator digits. */
    async function login(id, password, code) {
      id = String(id || "").trim();
      if (!id || !password) throw fail("input", "Enter your email or username, and your password.");
      var ident = /^@/.test(id) ? { type: "m.id.user", user: id }
        : /@/.test(id) ? { type: "m.id.thirdparty", medium: "email", address: id.toLowerCase() }
        : { type: "m.id.user", user: id };
      var r = await call("POST", "/_matrix/client/v3/login", {
        type: "m.login.password", identifier: ident,
        password: String(password) + (code ? String(code).replace(/\s+/g, "") : ""),
        initial_device_display_name: "hyphae extension",
      });
      if (r.status !== 200) throw explain(r);
      return session(r.json);
    }

    async function usernameFree(name) {
      var r = await call("GET", "/_matrix/client/v3/register/available?username=" + encodeURIComponent(name));
      if (r.status === 200) return true;
      if (r.json && r.json.errcode === "M_USER_IN_USE") return false;
      throw explain(r);
    }

    /**
     * Start an account: returns a pending object { sid, secret, session, flow } once the
     * homeserver has mailed the confirmation link. Then finish() until it resolves.
     */
    async function registerStart(username, email, password) {
      username = String(username || "").trim().toLowerCase();
      email = String(email || "").trim().toLowerCase();
      if (!/^[a-z0-9._=\-\/]{3,40}$/.test(username)) throw fail("username", "Username: 3–40 letters, numbers, . _ -");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail("email", "Enter a real email address; it is how you reset your password.");
      if (String(password).length < 10) throw fail("weak", "Use at least 10 characters for your password.");
      var body = { username: username, password: password, initial_device_display_name: "hyphae extension" };
      var r = await call("POST", "/_matrix/client/v3/register", body);
      if (r.status === 200) return { done: true, session: session(r.json) };   // no verification required
      if (r.status !== 401) throw explain(r);
      var flows = (r.json.flows || []).map(function (fl) { return fl.stages || []; });
      var needsEmail = flows.some(function (st) { return st.indexOf("m.login.email.identity") !== -1; });
      var authSession = r.json.session;
      if (!needsEmail) {
        var d = await call("POST", "/_matrix/client/v3/register", Object.assign({}, body, { auth: { type: "m.login.dummy", session: authSession } }));
        if (d.status !== 200) throw explain(d);
        return { done: true, session: session(d.json) };
      }
      var sec = secret();
      var t = await call("POST", "/_matrix/client/v3/register/email/requestToken", { client_secret: sec, email: email, send_attempt: 1 });
      if (t.status !== 200) throw explain(t);
      return { done: false, sid: t.json.sid, secret: sec, authSession: authSession, body: body };
    }

    /** One poll of a pending registration. Resolves {done:true, session} or {done:false}. */
    async function registerFinish(p) {
      var r = await call("POST", "/_matrix/client/v3/register", Object.assign({}, p.body, {
        auth: { type: "m.login.email.identity", threepid_creds: { sid: p.sid, client_secret: p.secret }, session: p.authSession },
      }));
      if (r.status === 200) return { done: true, session: session(r.json) };
      if (r.status === 401) return { done: false };
      throw explain(r);
    }

    /** Ask the homeserver to mail a reset link. Returns the pending object for resetFinish. */
    async function resetStart(email) {
      email = String(email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw fail("email", "Enter the email on your account.");
      var sec = secret();
      var t = await call("POST", "/_matrix/client/v3/account/password/email/requestToken", { client_secret: sec, email: email, send_attempt: 1 });
      if (t.status !== 200) throw explain(t);
      return { sid: t.json.sid, secret: sec };
    }

    /** Set the new password once the link has been followed. {done:false} until then. */
    async function resetFinish(p, newPassword) {
      if (String(newPassword).length < 10) throw fail("weak", "Use at least 10 characters for your password.");
      var r = await call("POST", "/_matrix/client/v3/account/password", {
        new_password: newPassword, logout_devices: false,
        auth: { type: "m.login.email.identity", threepid_creds: { sid: p.sid, client_secret: p.secret } },
      });
      if (r.status === 200) return { done: true };
      if (r.status === 401) return { done: false };
      throw explain(r);
    }

    async function logout(token) {
      if (!token) return;
      try { await call("POST", "/_matrix/client/v3/logout", {}, token); } catch (e) { /* the local sign-out stands */ }
    }

    return { login: login, usernameFree: usernameFree, registerStart: registerStart, registerFinish: registerFinish,
      resetStart: resetStart, resetFinish: resetFinish, logout: logout };
  }

  return { create: create, HOMESERVER: HOMESERVER };
});
