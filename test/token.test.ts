// Minting and scope checks: POST /v1/token, /v1/pr scope, /v1/commits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call, withGitHub, signIn, repo } from "./helpers.ts";
import * as gw from "../src/gateway-api.ts";

async function setup(t: any) {
  const gh = withGitHub(t);
  const env = makeEnv();
  const ana = gh.addUser({ login: "ana", id: 101, email: "ana@example.com", installations: [{ id: 7, account: { login: "ana", id: 101, type: "User" }, repos: [repo("ana/api", "admin", true), repo("ana/web", "admin")] }] });
  const s = await signIn(env, ana);
  const res = await call(env, "POST", "/v1/agents", { body: { id: "orbit", repos: ["ana/api"] }, headers: s.bearer });
  assert.equal(res.status, 200, await res.clone().text());
  const { key } = (await res.json()) as any;
  return { gh, env, s, key, auth: { authorization: `Bearer ${key}` } };
}

test("an agent key mints a 1-hour token for exactly its one repo, with trailers", async (t) => {
  const { gh, env, auth } = await setup(t);
  const res = await call(env, "POST", "/v1/token", { body: { repo: "ana/api", run: "r1" }, headers: auth });
  assert.equal(res.status, 200);
  const j = (await res.json()) as any;
  assert.equal(j.token, "ghs_1");
  assert.deepEqual(gh.minted[0].body.repositories, ["api"]);
  assert.deepEqual(gh.minted[0].body.permissions, { contents: "write", pull_requests: "write", issues: "write", metadata: "read" });
  assert.ok(j.trailers.includes("Accountable: ana"));
  assert.ok(!j.trailers.some((t: string) => t.startsWith("Co-authored-by")), "graph credit is off by default");
  assert.ok(j.trailers.includes("Run: r1"));
  const log = await env.DB.prepare("SELECT agent_id, repo, run, minted_by FROM gateway_tokens").all();
  assert.deepEqual(log.results, [{ agent_id: "orbit", repo: "ana/api", run: "r1", minted_by: "agent:orbit" }]);
});

test("out-of-scope repo, bad key and disabled agent are refused", async (t) => {
  const { gh, env, s, auth } = await setup(t);
  assert.equal((await call(env, "POST", "/v1/token", { body: { repo: "ana/web" }, headers: auth })).status, 403);
  assert.equal((await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: { authorization: "Bearer ghg_" + "x".repeat(43) } })).status, 401);
  assert.equal((await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: { authorization: `Bearer ${s.key}` } })).status, 401, "an account key isn't an agent key");
  assert.equal((await call(env, "POST", "/v1/agents/orbit/disable", { headers: s.bearer })).status, 200);
  assert.equal((await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: auth })).status, 403);
  assert.equal(gh.minted.length, 0);
});

test("mints are rate-limited per agent, not only per IP", async (t) => {
  const { env, auth } = await setup(t);
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: { ...auth, "cf-connecting-ip": `198.51.100.${i}` } })).status;
  assert.equal(last, 429);
});

test("mint failures don't leak GitHub's error text", async (t) => {
  const { gh, env, auth } = await setup(t);
  gh.handle = (async () => new Response(JSON.stringify({ message: "secret internal detail" }), { status: 500 })) as any;
  globalThis.fetch = gh.handle as any;
  const res = await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: auth });
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /secret internal detail/);
});

test("/v1/commits records attestations only for the agent's own repos", async (t) => {
  const { env, auth } = await setup(t);
  const sha = "a".repeat(40);
  assert.equal((await call(env, "POST", "/v1/commits", { body: { repo: "ana/web", shas: [sha] }, headers: auth })).status, 403);
  assert.equal((await call(env, "POST", "/v1/commits", { body: { repo: "ana/api", shas: ["abc"] }, headers: auth })).status, 400);
  const res = await call(env, "POST", "/v1/commits", { body: { repo: "Ana/API", shas: [sha, sha.toUpperCase()] }, headers: auth });
  assert.deepEqual(await res.json(), { ok: true, attested: 1 });
  const rows = await env.DB.prepare("SELECT repo, sha, agent_id FROM gateway_commits").all();
  assert.deepEqual(rows.results, [{ repo: "ana/api", sha, agent_id: "orbit" }]);
});

test("/v1/pr refuses repos outside the agent's scope and cross-fork heads", async (t) => {
  const { env, auth } = await setup(t);
  assert.equal((await call(env, "POST", "/v1/pr", { body: { repo: "ana/web", head: "x", base: "main", title: "t" }, headers: auth })).status, 403);
  assert.equal((await call(env, "POST", "/v1/pr", { body: { repo: "ana/api", head: "evil:x", base: "main", title: "t" }, headers: auth })).status, 400);
});

test("graph credit on adds Co-authored-by; workflows opt-in adds workflows: write and is removed from sub-agents", async (t) => {
  const { gh, env, s, auth } = await setup(t);
  const on = await call(env, "POST", "/v1/agents/orbit/credit", { body: { on: true }, headers: s.bearer });
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { ok: true, credit_human: true, trailer: true });
  let j = (await (await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: auth })).json()) as any;
  assert.ok(j.trailers.includes("Co-authored-by: ana <ana@example.com>"));

  // No email on record: the reply says the trailer can't appear, and no empty Co-authored-by goes out.
  await env.DB.prepare("UPDATE gateway_users SET email = '' WHERE login = 'ana'").run();
  const noEmail = (await (await call(env, "POST", "/v1/agents/orbit/credit", { body: { on: true }, headers: s.bearer })).json()) as any;
  assert.equal(noEmail.trailer, false);
  assert.match(noEmail.note, /hasn't signed in/);
  j = (await (await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: auth })).json()) as any;
  assert.ok(!j.trailers.some((t: string) => t.startsWith("Co-authored-by")));
  await env.DB.prepare("UPDATE gateway_users SET email = 'ana@example.com' WHERE login = 'ana'").run();

  const { setAgentWorkflows } = await import("../src/gateway-api.ts");
  assert.equal(await setAgentWorkflows(env.DB, "orbit", true, s.accountId ?? "gh:101"), true);
  await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: auth });
  assert.equal(gh.minted.at(-1).body.permissions.workflows, "write");

  const child = (await (await call(env, "POST", "/v1/agents/children", { body: { name: "w1" }, headers: auth })).json()) as any;
  assert.equal(child.agent.permissions.workflows, "write", "a sub-agent inherits it");
  assert.equal(child.agent.credit_human, true, "and graph credit");
  await setAgentWorkflows(env.DB, "orbit", false, s.accountId ?? "gh:101");
  const row = (await env.DB.prepare("SELECT permissions FROM gateway_agents WHERE id = 'orbit-w1'").first()) as any;
  assert.equal(JSON.parse(row.permissions).workflows, undefined, "turning it off removes it from sub-agents");
});

test("a reinstalled App (new installation id) mints at once, not after the cache expires", async (t) => {
  const { gh, env, auth } = await setup(t);
  assert.equal((await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: auth })).status, 200);
  // uninstall + reinstall: GitHub gives the repo a new installation id; ours is cached
  for (const r of ["ana/api", "ana/web"]) gh.appInstallations.set(r, 8);
  const res = await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: auth });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(gh.minted.at(-1)!.installation, 8);
});

test("an account can put its agent on more repos it can push to, and the key then mints for them", async (t) => {
  const { gh, env, s, auth } = await setup(t);
  const add = (id: string, repos: unknown, headers: Record<string, string> = s.bearer) => call(env, "POST", `/v1/agents/${id}/repos`, { body: { repos }, headers });

  // Before: one repo, so a token request without a repo defaults to it; after, it must name one.
  const res = await add("orbit", ["ana/web", "ANA/api"]);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { ok: true, agent: "orbit", repos: ["ana/api", "ana/web"], added: ["ana/web"] });
  assert.equal((await call(env, "POST", "/v1/token", { body: { repo: "ana/web" }, headers: auth })).status, 200);
  const noRepo = await call(env, "POST", "/v1/token", { body: {}, headers: auth });
  assert.equal(noRepo.status, 400);
  assert.match(((await noRepo.json()) as any).error, /works on ana\/api, ana\/web/);

  // Adding again is a no-op.
  assert.deepEqual(((await (await add("orbit", ["ana/web"])).json()) as any).added, []);

  // Not installed / no push, bad input, someone else's agent, an agent key, a sub-agent: refused.
  assert.match(((await (await add("orbit", ["ana/secret"])).json()) as any).error, /isn't installed on ana\/secret/);
  assert.equal((await add("orbit", [])).status, 400);
  assert.equal((await add("orbit", ["not a repo"])).status, 400);
  const bo = gh.addUser({ login: "bo", id: 202, installations: [{ id: 8, account: { login: "bo", id: 202, type: "User" }, repos: [repo("bo/x", "admin")] }] });
  assert.equal((await add("orbit", ["bo/x"], (await signIn(env, bo)).bearer)).status, 404);
  assert.equal((await add("orbit", ["ana/web"], auth)).status, 401, "an agent can't widen its own scope");
  const child = await call(env, "POST", "/v1/agents/children", { body: { name: "w1", repos: ["ana/api"] }, headers: auth });
  assert.equal(child.status, 200, await child.clone().text());
  const subAdd = await add("orbit-w1", ["ana/web"]);
  assert.equal(subAdd.status, 400);
  assert.match(((await subAdd.json()) as any).error, /sub-agent/);
});

test("/v1/trailers follows the agent's settings as they are now, without minting", async (t) => {
  const { gh, env, s, auth } = await setup(t);
  const trailers = async (body: any, headers: any = auth) => {
    const r = await call(env, "POST", "/v1/trailers", { body, headers });
    return { status: r.status, j: (await r.json()) as any };
  };
  let r = await trailers({ repo: "ana/api", run: "r1" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.j.trailers, ["Accountable: ana", "Agent: orbit", "Run: r1"]);
  await call(env, "POST", "/v1/agents/orbit/credit", { body: { on: true }, headers: s.bearer });
  r = await trailers({ repo: "ana/api" });
  assert.deepEqual(r.j.trailers, ["Co-authored-by: ana <ana@example.com>", "Accountable: ana", "Agent: orbit"]);
  assert.equal(gh.minted.length, 0, "no token minted");
  assert.equal((await trailers({ repo: "ana/web" })).status, 403);
  assert.equal((await trailers({ repo: "ana/api" }, { authorization: "Bearer ghg_nope" })).status, 401);
  await call(env, "POST", "/v1/agents/orbit/disable", { headers: s.bearer });
  assert.equal((await trailers({ repo: "ana/api" })).status, 403);
});

test("the audit-log IP hash is keyed, stable per address, and not a bare SHA-256", async () => {
  const a = makeEnv();
  const b = makeEnv();
  const h = await gw.hashIp(a, "198.51.100.7");
  assert.match(h, /^[0-9a-f]{24}$/);
  assert.equal(h, await gw.hashIp(a, "198.51.100.7"), "stable for one address and key");
  assert.notEqual(h, await gw.hashIp(a, "198.51.100.8"));
  assert.notEqual(h, await gw.hashIp(b, "198.51.100.7"), "a different key gives a different hash");
  assert.notEqual(h, (await gw.sha256Hex("198.51.100.7")).slice(0, 24), "not the unkeyed hash an attacker could precompute");
  assert.equal(await gw.hashIp(a, "unknown"), "");
});

test("when an agent's own App can't mint, the response says it fell back to the shared App", async (t) => {
  const { env, auth } = await setup(t);
  const plain = (await (await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: auth })).json()) as any;
  assert.equal(plain.fallback, undefined, "no warning for an agent that never had its own App");
  // orbit has an App installed under an installation GitHub doesn't know, so its mint fails.
  await env.DB.prepare("INSERT INTO gateway_apps (agent_id,app_id,slug,owner_login,owner_type,private_key,bot_id,installation_id,installation_login,created) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind("orbit", 55, "orbit-githug", "ana", "User", await gw.encryptSecret(env, env.GITHUB_APP_PRIVATE_KEY), 77, 9999, "ana", new Date().toISOString())
    .run();
  const j = (await (await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: auth })).json()) as any;
  assert.ok(j.token, "the shared App still mints");
  assert.equal(j.named, false);
  assert.equal(j.fallback, true);
  assert.match(j.warning, /orbit's own GitHub App failed; this token acts as the shared App/);
  assert.ok(!JSON.stringify(j).includes("Not Found"), "GitHub's error text stays in the server log");
});

test("a PR opened as the agent says when it fell back to the shared App", async (t) => {
  const { env, auth } = await setup(t);
  const open = async () => (await (await call(env, "POST", "/v1/pr", { body: { repo: "ana/api", head: "x", base: "main", title: "t", as: "agent" }, headers: auth })).json()) as any;
  const plain = await open();
  assert.equal(plain.number, 1);
  assert.equal(plain.fallback, undefined, "no warning for an agent without its own App");
  await env.DB.prepare("INSERT INTO gateway_apps (agent_id,app_id,slug,owner_login,owner_type,private_key,bot_id,installation_id,installation_login,created) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind("orbit", 55, "orbit-githug", "ana", "User", await gw.encryptSecret(env, env.GITHUB_APP_PRIVATE_KEY), 77, 9999, "ana", new Date().toISOString())
    .run();
  const j = await open();
  assert.equal(j.opened_as, "agent");
  assert.equal(j.fallback, true);
  assert.match(j.warning, /orbit's own GitHub App failed; this PR was opened as the shared App/);
});

test("githug's read token is scoped to one repo and cached encrypted", async (t) => {
  const { gh, env } = await setup(t);
  const sha = "a".repeat(40);
  gh.commitInfo.set(`ana/api@${sha}`, { login: "ana", verified: false });
  assert.deepEqual(await gw.githubCommitIdentity(env, "ana/api", sha), { login: "ana", signed: false });
  const read = gh.minted.at(-1);
  assert.deepEqual(read.body.repositories, ["api"], "one repo, not the whole installation");
  assert.deepEqual(read.body.permissions, { contents: "read", pull_requests: "read", metadata: "read" });
  const stored = await env.CACHE.get("gw:rtok:7:ana/api");
  assert.ok(stored && !stored.includes("ghs_"), "the cached value is ciphertext");
  const before = gh.minted.length;
  await gw.githubCommitIdentity(env, "ana/api", sha);
  assert.equal(gh.minted.length, before, "second read uses the cache");
  // without an encryption key nothing is cached
  const bare = { ...env, GATEWAY_ENC_KEY: undefined, CACHE: env.CACHE };
  await env.CACHE.delete("gw:rtok:7:ana/api");
  await gw.githubCommitIdentity(bare, "ana/api", sha);
  assert.equal(await env.CACHE.get("gw:rtok:7:ana/api"), null, "no plaintext fallback");
});
