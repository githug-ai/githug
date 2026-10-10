// Verify: commit claims vs githug's records, and why claims alone aren't "verified".
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call, withGitHub, signIn, repo } from "./helpers.ts";
import { verifyCommitData, parseTrailers } from "../src/gateway-api.ts";

const SHA = "b".repeat(40);

async function setup(t: any) {
  const gh = withGitHub(t);
  (t as any).gh = gh;
  const env = makeEnv();
  const ana = gh.addUser({ login: "ana", id: 101, installations: [{ id: 7, account: { login: "ana", id: 101, type: "User" }, repos: [repo("ana/api", "admin")] }] });
  const s = await signIn(env, ana);
  const { key } = (await (await call(env, "POST", "/v1/agents", { body: { id: "orbit", repos: ["ana/api"] }, headers: s.bearer })).json()) as any;
  const auth = { authorization: `Bearer ${key}` };
  await call(env, "POST", "/v1/token", { body: { repo: "ana/api", run: "r1" }, headers: auth });
  return { env, auth };
}

const commit = (over: Partial<{ sha: string; message: string; date: string; author_email: string; author_name: string }> = {}) => ({
  sha: SHA,
  message: "Fix it\n\nAccountable: ana\nAgent: orbit\nRun: r1",
  date: new Date().toISOString(),
  author_email: "orbit@agents.githug.ai",
  author_name: "orbit",
  ...over,
});

test("matching claims without a push attestation are only 'consistent'", async (t) => {
  const { env } = await setup(t);
  const r = await verifyCommitData(env, "ana/api", commit());
  assert.equal(r.verdict, "consistent");
  assert.equal(r.attested, false);
  assert.ok(r.checks.some((c) => !c.ok && /Not attested/.test(c.label)));
});

test("a commit attested with the agent's key at push is 'verified'", async (t) => {
  const { env, auth } = await setup(t);
  await call(env, "POST", "/v1/commits", { body: { repo: "ana/api", shas: [SHA], run: "r1" }, headers: auth });
  // even with a bogus author date: the attestation's server time anchors the key-log check
  const r = await verifyCommitData(env, "ana/api", commit({ date: "2001-01-01T00:00:00Z" }));
  assert.equal(r.verdict, "verified");
  assert.equal(r.attested, true);
});

test("an attestation for a different agent or repo doesn't count", async (t) => {
  const { env, auth } = await setup(t);
  await call(env, "POST", "/v1/commits", { body: { repo: "ana/api", shas: [SHA] }, headers: auth });
  const r = await verifyCommitData(env, "ana/other", commit());
  assert.notEqual(r.verdict, "verified");
});

test("contradicting claims are 'partial'; unknown or absent agents are 'not_githug'", async (t) => {
  const { env } = await setup(t);
  assert.equal((await verifyCommitData(env, "ana/api", commit({ message: "x\n\nAccountable: mallory\nAgent: orbit" }))).verdict, "partial");
  assert.equal((await verifyCommitData(env, "ana/api", commit({ author_email: "ghost@agents.githug.ai", message: "x" }))).verdict, "not_githug");
  assert.equal((await verifyCommitData(env, "ana/api", commit({ author_email: "ana@example.com", message: "plain" }))).verdict, "not_githug");
});

test("/v1/verify fails contradicting agent commits, passes consistent and human ones", async (t) => {
  const { env } = await setup(t);
  const post = (commits: any[]) => call(env, "POST", "/v1/verify", { body: { repo: "ana/api", commits } }).then((r) => r.json() as any);
  const ok = await post([commit(), commit({ sha: "c".repeat(40), author_email: "ana@example.com", message: "human" })]);
  assert.equal(ok.pass, true);
  assert.equal(ok.agent_commits, 1);
  assert.equal(ok.attested, 0);
  const bad = await post([commit({ message: "x\n\nAccountable: mallory\nAgent: orbit" })]);
  assert.equal(bad.pass, false);
  assert.equal(bad.failing, 1);
});

test("trailers are parsed anywhere in the message (squash merges)", () => {
  const t = parseTrailers("feat: x\n\n* first\nAgent: orbit\n\n* second\nRun: r2\nCo-authored-by: Ana <ana@x>");
  assert.deepEqual(t.agent, ["orbit"]);
  assert.deepEqual(t.run, ["r2"]);
  assert.deepEqual(t["co-authored-by"], ["Ana <ana@x>"]);
});

test("strict mode (require: attested) fails unattested and unknown commits, passes signed allowlisted humans", async (t) => {
  const { env, auth } = await setup(t);
  const attested = "a".repeat(40);
  await call(env, "POST", "/v1/commits", { body: { repo: "ana/api", shas: [attested] }, headers: auth });
  const post = (commits: any[], allow: string[] = []) =>
    call(env, "POST", "/v1/verify", { body: { repo: "ana/api", require: "attested", allow, commits } }).then((r) => r.json() as any);
  const human = (over: any = {}) => commit({ sha: "d".repeat(40), author_email: "ana@example.com", author_name: "ana", message: "by hand", author_login: "ana", signed: true, ...over });

  const ok = await post([commit({ sha: attested }), human()], ["ana"]);
  assert.equal(ok.require, "attested");
  assert.equal(ok.pass, true, JSON.stringify(ok.commits.map((c: any) => c.checks)));

  // a consistent (unattested) agent commit fails in strict mode
  assert.equal((await post([commit()], ["ana"])).pass, false);
  // a human not on the list, or unsigned, fails
  assert.equal((await post([human({ author_login: "mallory" })], ["ana"])).pass, false);
  const unsigned = await post([human({ signed: false })], ["ana"]);
  assert.equal(unsigned.pass, false);
  assert.ok(unsigned.commits[0].checks.some((c: any) => /isn't signed/.test(c.label)));
  // default mode is unchanged: humans and consistent agent commits pass
  const lax = await call(env, "POST", "/v1/verify", { body: { repo: "ana/api", commits: [commit(), human({ author_login: "mallory", signed: false })] } }).then((r) => r.json() as any);
  assert.equal(lax.pass, true);
});

test("strict mode trusts GitHub's view of a commit over what the Action posts", async (t) => {
  const { env } = await setup(t);
  const gh = (t as any).gh;
  const sha = "e".repeat(40);
  // the Action claims a signed commit by ana; GitHub says it's unsigned (a spoofed author email)
  gh.commitInfo.set(`ana/api@${sha}`, { login: "ana", verified: false });
  const body = { repo: "ana/api", require: "attested", allow: ["ana"], commits: [commit({ sha, author_email: "ana@example.com", message: "x", author_login: "ana", signed: true })] };
  const r = (await (await call(env, "POST", "/v1/verify", { body })).json()) as any;
  assert.equal(r.pass, false);
  gh.commitInfo.set(`ana/api@${sha}`, { login: "ana", verified: true });
  const r2 = (await (await call(env, "POST", "/v1/verify", { body: { ...body, commits: [{ ...body.commits[0], sha }] } })).json()) as any;
  assert.equal(r2.pass, true);
});
