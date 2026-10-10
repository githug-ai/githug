import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call } from "./helpers.ts";

test("worker boots on Node bindings: / is the dashboard, docs render", async () => {
  const env = makeEnv();
  const home = await call(env, "GET", "/");
  assert.equal(home.status, 302);
  assert.equal(home.headers.get("location"), "/app");
  const docs = await call(env, "GET", "/docs");
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /githug/);
});

test("the githug.ai site isn't part of core", async () => {
  const env = makeEnv();
  for (const p of ["/ask", "/blog", "/pricing.md", "/llms.txt", "/sitemap.xml", "/stats", "/terms"]) assert.equal((await call(env, "GET", p)).status, 404, p);
});
