// account-core against an in-test homeserver double (not Synapse): sign in, create with
// email confirmation, reset by email, the authenticator-code hint, and what is refused.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("../account-core.js");
const { create } = globalThis.HyAccount;

function server() {
  const users = { "alice": { pw: "correct horse", email: "alice@example.com" } };
  const sessions = {}; let confirmed = new Set(); const sids = {};
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", c => b += c); req.on("end", () => {
      const j = b ? JSON.parse(b) : {};
      const send = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      const u = req.url;
      if (u === "/_matrix/client/v3/login") {
        const id = j.identifier || {};
        let name = id.type === "m.id.user" ? id.user.replace(/^@|:.*$/g, "") : Object.keys(users).find(k => users[k].email === id.address);
        const usr = users[name];
        if (usr && usr.needCode && !j.password.endsWith("123456")) return send(403, { errcode: "M_FORBIDDEN", error: "authenticator code required" });
        const pw = usr && usr.needCode ? j.password.slice(0, -6) : j.password;
        if (!usr || usr.pw !== pw) return send(403, { errcode: "M_FORBIDDEN", error: "Invalid username or password" });
        return send(200, { user_id: "@" + name + ":hyphae.social", access_token: "tok_" + name, device_id: "D1" });
      }
      if (u.startsWith("/_matrix/client/v3/register/email/requestToken")) { const sid = "s" + Object.keys(sids).length; sids[sid] = j.email; return send(200, { sid }); }
      if (u === "/_matrix/client/v3/register") {
        if (users[j.username]) return send(400, { errcode: "M_USER_IN_USE", error: "taken" });
        if (!j.auth) return send(401, { session: "S", flows: [{ stages: ["m.login.email.identity"] }] });
        if (!confirmed.has(j.auth.threepid_creds.sid)) return send(401, { session: "S", flows: [{ stages: ["m.login.email.identity"] }] });
        users[j.username] = { pw: j.password, email: sids[j.auth.threepid_creds.sid] };
        return send(200, { user_id: "@" + j.username + ":hyphae.social", access_token: "tok_new", device_id: "D2" });
      }
      if (u === "/_matrix/client/v3/account/password/email/requestToken") {
        if (!Object.values(users).some(x => x.email === j.email)) return send(400, { errcode: "M_THREEPID_NOT_FOUND", error: "no" });
        const sid = "r" + Object.keys(sids).length; sids[sid] = j.email; return send(200, { sid });
      }
      if (u === "/_matrix/client/v3/account/password") {
        const sid = j.auth.threepid_creds.sid;
        if (!confirmed.has(sid)) return send(401, { session: "P", flows: [] });
        Object.values(users).find(x => x.email === sids[sid]).pw = j.new_password; return send(200, {});
      }
      send(404, { errcode: "M_UNRECOGNIZED" });
    });
  });
  return { srv, users, confirm: (sid) => confirmed.add(sid), sids };
}

test("account", async () => {
  const s = server(); await new Promise(r => s.srv.listen(0, r));
  const acct = create({ fetch, homeserver: "http://127.0.0.1:" + s.srv.address().port });

  // sign in by username and by email; a wrong password is refused
  assert.equal((await acct.login("alice", "correct horse")).userId, "@alice:hyphae.social");
  assert.equal((await acct.login("Alice@Example.com", "correct horse")).accessToken, "tok_alice");
  await assert.rejects(acct.login("alice", "nope"), /isn't right/);

  // the authenticator code is asked for only when the server says so
  s.users.alice.needCode = true;
  await assert.rejects(acct.login("alice", "correct horse"), (e) => e.needCode === true);
  assert.equal((await acct.login("alice", "correct horse", "123 456")).userId, "@alice:hyphae.social");
  s.users.alice.needCode = false;

  // create: refuses weak input before any request, waits for the email, then signs in
  await assert.rejects(acct.registerStart("al", "x@y.zz", "longenoughpw"), /Username/);
  await assert.rejects(acct.registerStart("bobby", "nope", "longenoughpw"), /email/);
  await assert.rejects(acct.registerStart("bobby", "bob@example.com", "short"), /10 characters/);
  await assert.rejects(acct.registerStart("alice", "a@example.com", "longenoughpw"), /taken/);
  const p = await acct.registerStart("bobby", "bob@example.com", "longenoughpw");
  assert.equal(p.done, false);
  assert.equal((await acct.registerFinish(p)).done, false);
  s.confirm(p.sid);
  const done = await acct.registerFinish(p);
  assert.equal(done.done, true); assert.equal(done.session.userId, "@bobby:hyphae.social");
  assert.equal((await acct.login("bob@example.com", "longenoughpw")).userId, "@bobby:hyphae.social");

  // reset: unknown email is said plainly; known email waits for the link, then the password changes
  await assert.rejects(acct.resetStart("ghost@example.com"), /No account uses that email/);
  const r = await acct.resetStart("bob@example.com");
  assert.equal((await acct.resetFinish(r, "brand new password")).done, false);
  s.confirm(r.sid);
  assert.equal((await acct.resetFinish(r, "brand new password")).done, true);
  assert.equal((await acct.login("bobby", "brand new password")).userId, "@bobby:hyphae.social");
  await assert.rejects(acct.login("bobby", "longenoughpw"), /isn't right/);

  s.srv.close();
});
