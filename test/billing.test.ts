// Shadow billing (M3.1): priceFor and monthUsage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, withGitHub, signIn, repo } from "./helpers.ts";
import { priceFor, monthUsage, createAgent, logToken } from "../src/gateway-api.ts";

test("priceFor picks the cheaper plan", () => {
  assert.deepEqual(priceFor(0), { solo: 5, team: 25, plan: null, cost: 0 });
  assert.deepEqual(priceFor(3), { solo: 5, team: 25, plan: "solo", cost: 5 });
  assert.deepEqual(priceFor(10), { solo: 10, team: 25, plan: "solo", cost: 10 });
  assert.deepEqual(priceFor(25), { solo: 25, team: 25, plan: "solo", cost: 25 });
  assert.deepEqual(priceFor(30), { solo: 30, team: 30, plan: "solo", cost: 30 });
});

test("monthUsage bills top-level agents × private repos this month; sub-agents bill to their root", async (t) => {
  const gh = withGitHub(t);
  const env = makeEnv();
  const ana = gh.addUser({ login: "ana", id: 101, installations: [{ id: 7, account: { login: "ana", id: 101, type: "User" }, repos: [repo("ana/api", "admin", true), repo("ana/web", "admin", false), repo("ana/ops", "admin", true)] }] });
  const s = await signIn(env, ana);
  const mk = (id: string, repos: string[], parent?: string) => createAgent(env.DB, { id, name: id, repos, accountable: "ana", account_id: s.accountId, parent: parent ?? null, depth: parent ? 1 : 0 });
  await mk("orbit", ["ana/api", "ana/web"]);
  await mk("orbit-w1", ["ana/api"], "orbit");
  await mk("idle", ["ana/ops"]);
  const mint = (agent_id: string, repo: string) => logToken(env.DB, { agent_id, repo, installation_id: 7, expires: "", ip_hash: "", run: "", minted_by: "", surface: "git" });
  await mint("orbit", "ana/api");
  await mint("orbit-w1", "ana/api");
  await mint("orbit", "ana/web");
  await env.DB.prepare("INSERT INTO gateway_tokens (agent_id,repo,installation_id,issued,expires) VALUES ('orbit','ana/ops',7,'2020-01-15T00:00:00Z','')").run();
  const u = await monthUsage(env, { id: s.accountId, login: "ana", plan: "free", kind: "user", actor: "ana", actorId: 101 });
  assert.equal(u.billable, 1); // orbit × ana/api (private); web is public; ops minted last month; idle never minted
  assert.deepEqual(u.grants.find((g) => g.repo === "ana/api"), { agent: "orbit", repo: "ana/api", private: true, mints: 2 });
  assert.equal(u.cost, 5);
});
