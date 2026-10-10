// Sub-agent rules (M2.6): prefix, subset, depth, cascades.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call, withGitHub, signIn, repo } from "./helpers.ts";

async function setup(t: any) {
  const gh = withGitHub(t);
  const env = makeEnv();
  const ana = gh.addUser({ login: "ana", id: 101, installations: [{ id: 7, account: { login: "ana", id: 101, type: "User" }, repos: [repo("ana/api", "admin"), repo("ana/web", "admin")] }] });
  const s = await signIn(env, ana);
  const res = await call(env, "POST", "/v1/agents", { body: { id: "orbit", repos: ["ana/api"] }, headers: s.bearer });
  const { key } = (await res.json()) as any;
  const spawn = (k: string, body: any) => call(env, "POST", "/v1/agents/children", { body, headers: { authorization: `Bearer ${k}` } });
  return { env, s, key, spawn };
}

test("children get a prefixed id, inherit accountable, and stay within the parent's scope", async (t) => {
  const { env, key, spawn } = await setup(t);
  const ok = await spawn(key, { name: "w1" });
  assert.equal(ok.status, 200);
  const child = ((await ok.json()) as any).agent;
  assert.equal(child.id, "orbit-w1");
  assert.equal(child.accountable, "ana");
  assert.equal(child.accountable_id, 101);
  assert.deepEqual(child.repos, ["ana/api"]);
  assert.equal((await spawn(key, { name: "w2", repos: ["ana/web"] })).status, 400);
  assert.equal((await spawn(key, { name: "w3", permissions: { administration: "write" } })).status, 400);
  assert.equal((await spawn(key, { name: "w4", permissions: { contents: "read" } })).status, 200);
  assert.equal((await spawn(key, { name: "Bad_Name" })).status, 400);
  const row = await env.DB.prepare("SELECT parent, depth FROM gateway_agents WHERE id = 'orbit-w1'").first();
  assert.deepEqual(row, { parent: "orbit", depth: 1 });
});

test("depth is capped at 3", async (t) => {
  const { key, spawn } = await setup(t);
  let k = key;
  for (const n of ["a", "b", "c"]) {
    const r = await spawn(k, { name: n });
    assert.equal(r.status, 200, n);
    k = ((await r.json()) as any).key;
  }
  const deep = await spawn(k, { name: "d" });
  assert.equal(deep.status, 400);
  assert.match(((await deep.json()) as any).error, /at most 3/);
});

test("disabling cascades; a child can't mint or be enabled under a disabled parent", async (t) => {
  const { env, s, key, spawn } = await setup(t);
  const childKey = ((await (await spawn(key, { name: "w1" })).json()) as any).key;
  assert.equal((await call(env, "POST", "/v1/agents/orbit/disable", { headers: s.bearer })).status, 200);
  assert.equal((await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: { authorization: `Bearer ${childKey}` } })).status, 403);
  assert.equal((await call(env, "POST", "/v1/agents/orbit-w1/enable", { headers: s.bearer })).status, 409);
  // re-enable the parent only: the child stays off until someone enables it
  assert.equal((await call(env, "POST", "/v1/agents/orbit/enable", { headers: s.bearer })).status, 200);
  assert.equal((await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: { authorization: `Bearer ${childKey}` } })).status, 403);
  assert.equal((await call(env, "POST", "/v1/agents/orbit-w1/enable", { headers: s.bearer })).status, 200);
  assert.equal((await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: { authorization: `Bearer ${childKey}` } })).status, 200);
});

test("a disabled child under an enabled parent stays blocked even with a valid key", async (t) => {
  const { env, s, key, spawn } = await setup(t);
  const childKey = ((await (await spawn(key, { name: "w1" })).json()) as any).key;
  const grandKey = ((await (await spawn(childKey, { name: "g" })).json()) as any).key;
  await call(env, "POST", "/v1/agents/orbit-w1/disable", { headers: s.bearer });
  assert.equal((await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: { authorization: `Bearer ${grandKey}` } })).status, 403);
  assert.equal((await spawn(grandKey, { name: "x" })).status, 403);
});

test("rotating a key disables the sub-agents the old key could have made", async (t) => {
  const { env, s, key, spawn } = await setup(t);
  const childKey = ((await (await spawn(key, { name: "w1" })).json()) as any).key;
  const page = await call(env, "POST", "/app/agents/orbit/rotate", { headers: { cookie: s.cookie } });
  const html = await page.text();
  assert.match(html, /Also disabled its 1 sub-agent/);
  assert.equal((await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: { authorization: `Bearer ${key}` } })).status, 401);
  assert.equal((await call(env, "POST", "/v1/token", { body: { repo: "ana/api" }, headers: { authorization: `Bearer ${childKey}` } })).status, 403);
});
