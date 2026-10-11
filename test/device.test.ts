// `hug init`'s device login logs each outcome through hooks.pageView, so the signup funnel shows
// people who reached GitHub and stopped. Pending polls aren't logged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call, withGitHub } from "./helpers.ts";
import { hooks } from "../src/core.ts";

test("device login logs start, approved, expired and error", async (t) => {
  const gh = withGitHub(t);
  const seen: string[] = [];
  hooks.pageView = async (_env, id) => void seen.push(id);
  t.after(() => void (hooks.pageView = undefined));
  const env = makeEnv();
  const ana = gh.addUser({ login: "ana", id: 1 });

  assert.equal((await call(env, "POST", "/v1/device/code")).status, 200);
  gh.codes.set("dev_fake_0001", ana.token);
  assert.equal((await call(env, "POST", "/v1/device/token", { body: { device_code: "dev_fake_0001" } })).status, 200);
  gh.codes.set("dev_fake_0002", "expired");
  assert.equal((await call(env, "POST", "/v1/device/token", { body: { device_code: "dev_fake_0002" } })).status, 400);
  assert.equal((await call(env, "POST", "/v1/device/token", { body: { device_code: "dev_unknown_03" } })).status, 400);

  assert.deepEqual(seen, ["/evt/device/start", "/evt/device/approved", "/evt/device/expired", "/evt/device/error"]);
});
