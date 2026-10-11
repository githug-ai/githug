// Minting and scope checks: POST /v1/token, /v1/pr scope, /v1/commits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call, withGitHub, signIn, repo } from "./helpers.ts";

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
  assert.equal((await call(env, "POST", "/v1/agents/orbit/credit", { body: { on: true }, headers: s.bearer })).status, 200);
  let j = (await (await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: auth })).json()) as any;
  assert.ok(j.trailers.includes("Co-authored-by: ana <ana@example.com>"));

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
