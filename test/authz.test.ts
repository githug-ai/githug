// Account and org authorization: who may create, see and manage which agents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call, withGitHub, signIn, repo, ADMIN_TOKEN } from "./helpers.ts";
import * as gw from "../src/gateway-api.ts";

test("read or triage access to a repo is not enough to put an agent on it", async (t) => {
  const gh = withGitHub(t);
  const env = makeEnv();
  const bo = gh.addUser({ login: "bo", id: 202, installations: [{ id: 7, account: { login: "ana", id: 101, type: "User" }, repos: [repo("ana/api", "pull", true), repo("ana/docs", "triage"), repo("ana/web", "push")] }] });
  const s = await signIn(env, bo);
  for (const r of ["ana/api", "ana/docs"]) {
    const res = await call(env, "POST", "/v1/agents", { body: { id: `x-${r.split("/")[1]}`, repos: [r] }, headers: s.bearer });
    assert.equal(res.status, 400, r);
    assert.match(((await res.json()) as any).error, /isn't installed/);
  }
  const ok = await call(env, "POST", "/v1/agents", { body: { id: "webbot", repos: ["ana/web"] }, headers: s.bearer });
  assert.equal(ok.status, 200);
  const list = (await (await call(env, "GET", "/v1/repos", { headers: s.bearer })).json()) as any;
  assert.deepEqual(list.repos.map((r: any) => r.repo), ["ana/web"]);
});

test("accounts can't see or manage each other's agents", async (t) => {
  const gh = withGitHub(t);
  const env = makeEnv();
  const ana = gh.addUser({ login: "ana", id: 101, installations: [{ id: 7, account: { login: "ana", id: 101, type: "User" }, repos: [repo("ana/api", "admin")] }] });
  const bo = gh.addUser({ login: "bo", id: 202, installations: [] });
  const a = await signIn(env, ana);
  const b = await signIn(env, bo);
  assert.equal((await call(env, "POST", "/v1/agents", { body: { id: "orbit", repos: ["ana/api"] }, headers: a.bearer })).status, 200);
  assert.deepEqual(((await (await call(env, "GET", "/v1/agents", { headers: b.bearer })).json()) as any).agents, []);
  assert.equal((await call(env, "POST", "/v1/agents/orbit/disable", { headers: b.bearer })).status, 404);
  const page = await call(env, "GET", "/app/agents/orbit", { headers: { cookie: b.cookie } });
  assert.equal(page.headers.get("location"), "/app");
  const rot = await call(env, "POST", "/app/agents/orbit/rotate", { headers: { cookie: b.cookie } });
  assert.equal(rot.headers.get("location"), "/app");
  assert.equal((await call(env, "POST", "/v1/agents/orbit/rotate", { headers: b.bearer })).status, 404);
  assert.equal((await call(env, "POST", "/v1/agents/orbit/rotate", { headers: { cookie: a.cookie, origin: "https://evil.example" } })).status, 401);
});

test("cookie writes need our own Origin", async (t) => {
  const gh = withGitHub(t);
  const env = makeEnv();
  const ana = gh.addUser({ login: "ana", id: 101, installations: [{ id: 7, account: { login: "ana", id: 101, type: "User" }, repos: [repo("ana/api", "admin")] }] });
  const a = await signIn(env, ana);
  const res = await call(env, "POST", "/app/agents", { form: { id: "orbit", repo: "ana/api" }, headers: { cookie: a.cookie, origin: "https://evil.example" } });
  assert.equal(res.status, 403);
});

test("org acting needs push on an installed org repo; managing an org agent needs push on all its repos", async (t) => {
  const gh = withGitHub(t);
  const env = makeEnv();
  const org = { login: "acme", id: 900, type: "Organization" as const };
  const lead = gh.addUser({ login: "lead", id: 1, installations: [{ id: 50, account: org, repos: [repo("acme/core", "admin", true), repo("acme/site", "admin")] }] });
  const dev = gh.addUser({ login: "dev", id: 2, installations: [{ id: 50, account: org, repos: [repo("acme/core", "pull", true), repo("acme/site", "push")] }] });
  const reader = gh.addUser({ login: "reader", id: 3, installations: [{ id: 50, account: org, repos: [repo("acme/core", "pull", true)] }] });
  const L = await signIn(env, lead);
  const D = await signIn(env, dev);
  const R = await signIn(env, reader);

  // reader (read-only) can't act for the org
  const sw = await call(env, "POST", "/app/switch", { form: { account: "gh:900" }, headers: { cookie: R.cookie } });
  assert.equal(sw.headers.get("location"), "/app?switch=denied");

  // lead acts for the org and creates an agent on acme/core
  assert.equal((await call(env, "POST", "/app/switch", { form: { account: "gh:900" }, headers: { cookie: L.cookie } })).headers.get("location"), "/app");
  const created = await call(env, "POST", "/app/agents", { form: { id: "coreagent", repo: "acme/core" }, headers: { cookie: L.cookie } });
  assert.match(await created.text(), /GITHUG_AGENT_KEY=ghg_/);
  const agent = await gw.findAccountAgent(env.DB, "coreagent", "gh:900");
  assert.equal(agent?.accountable, "lead");
  assert.equal(agent?.accountable_id, 1);

  // dev can act for the org (push on acme/site) but not touch the agent on acme/core
  assert.equal((await call(env, "POST", "/app/switch", { form: { account: "gh:900" }, headers: { cookie: D.cookie } })).headers.get("location"), "/app");
  assert.equal((await call(env, "POST", "/app/agents/coreagent/rotate", { headers: { cookie: D.cookie } })).headers.get("location"), "/app");
  await call(env, "POST", "/app/agents/coreagent/disable", { headers: { cookie: D.cookie } });
  assert.equal((await gw.findAccountAgent(env.DB, "coreagent", "gh:900"))?.disabled, 0);
  await call(env, "POST", "/app/agents/coreagent/workflows", { form: { on: "1" }, headers: { cookie: D.cookie } });
  assert.equal((await gw.findAccountAgent(env.DB, "coreagent", "gh:900"))?.permissions?.workflows, undefined, "dev can't grant workflows on an agent outside their push access");
  await call(env, "POST", "/app/agents/coreagent/workflows", { form: { on: "1" }, headers: { cookie: L.cookie } });
  assert.equal((await gw.findAccountAgent(env.DB, "coreagent", "gh:900"))?.permissions?.workflows, "write");
  const denied = await call(env, "POST", "/app/agents", { form: { id: "sneaky", repo: "acme/core" }, headers: { cookie: D.cookie } });
  assert.match(await denied.text(), /isn&#39;t installed|isn't installed/);
});

test("admin API needs ADMIN_TOKEN; the stats password no longer works there", async (t) => {
  withGitHub(t);
  const env = makeEnv();
  const basic = { authorization: "Basic " + btoa("admin:pass:word") };
  assert.equal((await call(env, "GET", "/v1/agents", { headers: basic })).status, 401);
  assert.equal((await call(env, "GET", "/v1/agents", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).status, 200);
  assert.equal((await call(env, "POST", "/api/admin/sync-prs", { headers: basic })).status, 401);
  // the setup page still takes Basic, a ':' in the password works, junk doesn't 500
  assert.equal((await call(env, "GET", "/gateway/setup/github-app", { headers: basic })).status, 200);
  assert.equal((await call(env, "GET", "/gateway/setup/github-app", { headers: { authorization: "Basic %%%" } })).status, 401);
  const noAdmin = makeEnv({ ADMIN_TOKEN: "" });
  assert.equal((await call(noAdmin, "GET", "/v1/agents", { headers: { authorization: "Bearer " } })).status, 401);
});

test("admin agent create requires a real signed-in accountable human", async (t) => {
  const gh = withGitHub(t);
  const env = makeEnv();
  const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const body = { id: "ops", name: "ops", repos: ["ana/api"], accountable: "nobody" };
  assert.equal((await call(env, "POST", "/v1/agents", { body, headers: admin })).status, 400);
  await signIn(env, gh.addUser({ login: "ana", id: 101 }));
  const ok = await call(env, "POST", "/v1/agents", { body: { ...body, accountable: "ana" }, headers: admin });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as any).agent.accountable_id, 101);
});

test("setup-page Basic auth failures are rate-limited", async (t) => {
  withGitHub(t);
  const env = makeEnv();
  let status = 0;
  for (let i = 0; i < 31; i++) status = (await call(env, "GET", "/gateway/setup/github-app", { headers: { authorization: "Basic " + btoa("admin:wrong") } })).status;
  assert.equal(status, 429);
});

test("login state is bound to the browser that started it (login CSRF)", async (t) => {
  const gh = withGitHub(t);
  const env = makeEnv();
  const mallory = gh.addUser({ login: "mallory", id: 666 });
  gh.codes.set("c0de", mallory.token);
  const start = await call(env, "GET", "/login?next=/app");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const setCookie = start.headers.get("set-cookie")!;
  assert.match(setCookie, /githug_oauth_state=/);
  // the victim's browser, without the state cookie: no session, sent to start over
  const victim = await call(env, "GET", `/gateway/oauth/callback?code=c0de&state=${state}`);
  assert.equal(victim.status, 302);
  assert.match(victim.headers.get("location")!, /^\/login/);
  assert.doesNotMatch(victim.headers.get("set-cookie") ?? "", /githug_session=[^;]/);
  // the browser that started it signs in
  const start2 = await call(env, "GET", "/login?next=/app");
  const state2 = new URL(start2.headers.get("location")!).searchParams.get("state")!;
  const own = await call(env, "GET", `/gateway/oauth/callback?code=c0de&state=${state2}`, { headers: { cookie: `githug_oauth_state=${state2}` } });
  assert.equal(own.headers.get("location"), "/app");
  assert.match(own.headers.get("set-cookie") ?? "", /githug_session=/);
});

test("a renamed login re-claimed by someone else doesn't hand over their GitHub grant", async (t) => {
  const gh = withGitHub(t);
  const env = makeEnv();
  // ana (id 101) signs in, then renames on GitHub; cat (id 303) takes the login "ana".
  const ana = gh.addUser({ login: "ana", id: 101, installations: [] });
  const old = await signIn(env, ana);
  const cat = gh.addUser({ login: "ana", id: 303, installations: [{ id: 9, account: { login: "ana", id: 303, type: "User" }, repos: [repo("ana/secret", "admin", true)] }] });
  await gw.upsertGatewayUser(env, { login: "ana", github_id: 303, email: null, access_token: cat.token });
  // the first account's sessions/keys must not see cat's installations
  const repos = (await (await call(env, "GET", "/v1/repos?fresh=1", { headers: old.bearer })).json()) as any;
  assert.deepEqual(repos.repos, []);
  assert.equal(await gw.getUserToken(env, { login: "ana", id: 101 }), null);
  assert.equal(await gw.getUserToken(env, { login: "ana", id: 303 }), cat.token);
});
