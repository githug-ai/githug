// Self-hosted mode (GITHUG_MODE=self-hosted): githug.ai-only parts off, in-app App setup,
// single-tenant signup (first-run admin + allowlist), no billing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call, withGitHub, repo, oauthSignIn } from "./helpers.ts";

const selfEnv = (extra: Record<string, unknown> = {}) =>
  makeEnv({ GITHUG_MODE: "self-hosted", GITHUG_ORIGIN: "https://githug.acme.dev", GITHUB_APP_ID: "", GITHUB_APP_SLUG: "", GITHUB_APP_PRIVATE_KEY: "", GITHUB_OAUTH_CLIENT_ID: "", GITHUB_OAUTH_CLIENT_SECRET: "", ...extra });
const basic = { authorization: "Basic " + btoa("admin:pass:word") };

test("self-hosted: / is the dashboard, docs point at the instance", async (t) => {
  withGitHub(t);
  const env = selfEnv();
  assert.equal((await call(env, "GET", "/")).headers.get("location"), "/app");
  for (const p of ["/ask", "/blog", "/pricing.md", "/llms.txt", "/sitemap.xml", "/gateway/compare", "/terms", "/roadmap"]) assert.equal((await call(env, "GET", p)).status, 404, p);
  const docs = await call(env, "GET", "/docs/index.md");
  assert.equal(docs.status, 200);
  const md = await docs.text();
  assert.match(md, /https:\/\/githug\.acme\.dev/);
  assert.doesNotMatch(md, /https:\/\/githug\.ai\//);
  assert.equal(docs.headers.get("x-robots-tag"), "noindex");
  const install = await (await call(env, "GET", "/install")).text();
  assert.match(install, /base="https:\/\/githug\.ai\/dl\/hug"/);
  assert.match(install, /--url https:\/\/githug\.acme\.dev/);
});

test("the setup page creates the App in one click and saves it; its creator becomes admin", async (t) => {
  const gh = withGitHub(t);
  const env = selfEnv();
  assert.equal((await call(env, "GET", "/gateway/setup/github-app")).status, 401);
  const form = await (await call(env, "GET", "/gateway/setup/github-app", { headers: basic })).text();
  assert.match(form, /githug githug\.acme\.dev/);
  assert.match(form, /https:\/\/githug\.acme\.dev\/gateway\/oauth\/callback/);
  assert.equal((await call(env, "GET", "/gateway/setup/github-app/callback?code=abcdef123")).status, 401, "the callback needs the setup login too");
  const done = await call(env, "GET", "/gateway/setup/github-app/callback?code=abcdef123", { headers: basic });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Enable Device Flow/);
  const saved = await env.DB.prepare("SELECT key, secret FROM instance_settings ORDER BY key").all();
  assert.deepEqual(saved.results.map((r: any) => `${r.key}:${r.secret}`), ["GITHUB_APP_ID:0", "GITHUB_APP_PRIVATE_KEY:1", "GITHUB_APP_SLUG:0", "GITHUB_OAUTH_CLIENT_ID:0", "GITHUB_OAUTH_CLIENT_SECRET:1"]);
  const pem = await env.DB.prepare("SELECT value FROM instance_settings WHERE key = 'GITHUB_APP_PRIVATE_KEY'").first<any>();
  assert.doesNotMatch(pem.value, /PRIVATE KEY/, "stored encrypted");

  // the saved App is live: /login now redirects to GitHub with its client id
  const login = await call(env, "GET", "/login");
  assert.match(login.headers.get("location")!, /client_id=Iv1\.self/);

  // the App's creator (ana) signs in as admin; a stranger can't
  const ana = gh.addUser({ login: "ana", id: 101, installations: [] });
  const a = await oauthSignIn(env, gh, ana);
  assert.ok(a.cookie, "admin signs in");
  assert.equal((await call(env, "GET", "/admin", { headers: { cookie: a.cookie! } })).status, 200);
  const eve = gh.addUser({ login: "eve", id: 666, installations: [] });
  const e = await oauthSignIn(env, gh, eve);
  assert.equal(e.res.status, 403);
  assert.equal(e.cookie, undefined);

  // the admin adds eve; now she can sign in, but isn't admin
  await call(env, "POST", "/admin/users", { form: { login: "eve" }, headers: { cookie: a.cookie! } });
  const e2 = await oauthSignIn(env, gh, eve);
  assert.ok(e2.cookie);
  assert.equal((await call(env, "GET", "/admin", { headers: { cookie: e2.cookie! } })).headers.get("location"), "/login?next=/admin");
});

test("GITHUG_ALLOW admits listed logins and pushers in listed orgs", async (t) => {
  const gh = withGitHub(t);
  const env = selfEnv({ GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "x", GITHUB_APP_PRIVATE_KEY: makeEnv().GITHUB_APP_PRIVATE_KEY, GITHUB_OAUTH_CLIENT_ID: "Iv1.self", GITHUB_OAUTH_CLIENT_SECRET: "s", GITHUG_ALLOW: "bo, acme", GITHUG_ADMIN: "ana" });
  const org = { login: "acme", id: 900, type: "Organization" as const };
  const ok = [
    gh.addUser({ login: "ana", id: 1 }),
    gh.addUser({ login: "bo", id: 2 }),
    gh.addUser({ login: "dev", id: 3, installations: [{ id: 50, account: org, repos: [repo("acme/core", "push")] }] }),
  ];
  for (const u of ok) assert.ok((await oauthSignIn(env, gh, u)).cookie, u.login);
  const reader = gh.addUser({ login: "reader", id: 4, installations: [{ id: 50, account: org, repos: [repo("acme/core", "pull")] }] });
  assert.equal((await oauthSignIn(env, gh, reader)).res.status, 403);
  const roles = await env.DB.prepare("SELECT login, role FROM instance_users ORDER BY login").all();
  assert.deepEqual(roles.results, [{ login: "ana", role: "admin" }, { login: "bo", role: "member" }, { login: "dev", role: "member" }]);
  // no billing on a self-host
  const s = (await oauthSignIn(env, gh, ok[1])).cookie!;
  assert.equal((await call(env, "GET", "/v1/usage", { headers: { cookie: s } })).status, 404);
});

test("before setup, nobody can sign in", async (t) => {
  const gh = withGitHub(t);
  const env = selfEnv({ GITHUB_APP_ID: "1", GITHUB_OAUTH_CLIENT_ID: "Iv1.self", GITHUB_OAUTH_CLIENT_SECRET: "s" });
  const r = await oauthSignIn(env, gh, gh.addUser({ login: "eve", id: 666 }));
  assert.equal(r.res.status, 403);
});
