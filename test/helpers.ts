/**
 * Test harness: the real Worker (src/worker.ts) on Node bindings (src/node/bindings.ts),
 * with GitHub faked at the fetch layer. Each test gets a fresh in-memory database.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteD1, SqliteKV, DirR2, MemoryRateLimit, DirAssets, migrate } from "../src/node/bindings.ts";
import worker from "../src/worker.ts";
import * as gw from "../src/gateway-api.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

export const ADMIN_TOKEN = "a".repeat(40);

export function makeEnv(extra: Record<string, unknown> = {}) {
  const db = new SqliteD1(":memory:");
  migrate(db, join(ROOT, "migrations"));
  return {
    DB: db,
    CACHE: new SqliteKV(db, "CACHE"),
    RELEASES: new DirR2(mkdtempSync(join(tmpdir(), "githug-r2-"))),
    ASSETS: new DirAssets(join(ROOT, "public")),
    WRITE_LIMITER: new MemoryRateLimit(30, 60),
    VERIFY_LIMITER: new MemoryRateLimit(300, 60),
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "githug-gateway",
    GITHUB_OAUTH_CLIENT_ID: "Iv1.test",
    GITHUB_OAUTH_CLIENT_SECRET: "secret",
    GATEWAY_ENC_KEY: randomBytes(32).toString("base64"),
    ADMIN_TOKEN,
    STATS_USER: "admin",
    STATS_PASSWORD: "pass:word",
    ...extra,
  } as any;
}

export type Env = ReturnType<typeof makeEnv>;

/** Calls the Worker like the platform would; waitUntil work is awaited before returning. */
export async function call(env: Env, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; form?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "cf-connecting-ip": "203.0.113.9", ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.form) {
    body = new URLSearchParams(opts.form);
    headers["content-type"] = "application/x-www-form-urlencoded";
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} };
  const res = await (worker as any).fetch(new Request(`https://githug.test${path}`, { method, headers, body, redirect: "manual" }), env, ctx);
  await Promise.allSettled(pending);
  return res as Response;
}

// ---------------------------------------------------------------------------
// fake GitHub
// ---------------------------------------------------------------------------
export interface FakeRepo {
  full_name: string;
  private?: boolean;
  permissions: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
}
export interface FakeInstallation {
  id: number;
  account: { login: string; id: number; type: "User" | "Organization" };
  repos: FakeRepo[];
}
export interface FakeUser {
  login: string;
  id: number;
  email?: string | null;
  token: string;
  installations: FakeInstallation[];
}

export class FakeGitHub {
  users = new Map<string, FakeUser>(); // by token
  /** repo (lowercase) → installation id of the shared App */
  appInstallations = new Map<string, number>();
  minted: { installation: number; body: any }[] = [];
  codes = new Map<string, string>(); // OAuth code → token
  calls: string[] = [];
  /** "owner/repo@sha" → GitHub's view of a commit (author account, signature). */
  commitInfo = new Map<string, { login: string | null; verified: boolean }>();

  addUser(u: Omit<FakeUser, "token" | "installations"> & { installations?: FakeInstallation[] }): FakeUser {
    const user = { email: null, installations: [], ...u, token: `ghu_${u.login}_${u.id}` } as FakeUser;
    this.users.set(user.token, user);
    for (const i of user.installations) for (const r of i.repos) this.appInstallations.set(r.full_name.toLowerCase(), i.id);
    return user;
  }

  private json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  }

  handle = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const auth = String((init.headers as any)?.Authorization ?? (init.headers as any)?.authorization ?? "").replace(/^Bearer /, "");
    this.calls.push(`${method} ${url.pathname}`);
    if (url.host === "github.com" && url.pathname === "/login/oauth/access_token") {
      const body = JSON.parse(String(init.body ?? "{}"));
      const token = this.codes.get(body.code);
      return token ? this.json({ access_token: token, expires_in: 28800, refresh_token: "ghr_x" }) : this.json({ error: "bad_verification_code" });
    }
    if (url.host !== "api.github.com") return this.json({ message: `unexpected host ${url.host}` }, 500);
    if (/^\/app-manifests\/[^/]+\/conversions$/.test(url.pathname) && method === "POST") {
      return this.json({ id: 4242, slug: "githug-acme", pem: privateKey, client_id: "Iv1.self", client_secret: "shh", webhook_secret: null, owner: { login: "ana", type: "User" } }, 201);
    }
    const user = this.users.get(auth);
    const p = url.pathname;
    let m: RegExpExecArray | null;
    if (p === "/user") return user ? this.json({ login: user.login, id: user.id, email: user.email }) : this.json({ message: "Bad credentials" }, 401);
    if (p === "/user/installations") return user ? this.json({ installations: user.installations.map((i) => ({ id: i.id, account: i.account })) }) : this.json({ message: "Bad credentials" }, 401);
    if ((m = /^\/user\/installations\/(\d+)\/repositories$/.exec(p))) {
      const inst = user?.installations.find((i) => i.id === Number(m![1]));
      if (!inst) return this.json({ message: "Not Found" }, 404);
      return this.json({ repositories: url.searchParams.get("page") && url.searchParams.get("page") !== "1" ? [] : inst.repos });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(p))) {
      const id = this.appInstallations.get(m[1].toLowerCase());
      return id ? this.json({ id }) : this.json({ message: "Not Found" }, 404);
    }
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p)) && method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      this.minted.push({ installation: Number(m[1]), body });
      return this.json({ token: `ghs_${this.minted.length}`, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: body.permissions ?? {} }, 201);
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]{40})$/.exec(p))) {
      const info = this.commitInfo.get(`${m[1].toLowerCase()}@${m[2]}`);
      return info ? this.json({ sha: m[2], author: info.login ? { login: info.login } : null, commit: { verification: { verified: info.verified } } }) : this.json({ message: "Not Found" }, 404);
    }
    if ((m = /^\/app\/installations\/(\d+)$/.exec(p))) return this.json({ id: Number(m[1]), account: { login: "acme" } });
    if (/^\/users\/[^/]+%5Bbot%5D$/.test(p)) return this.json({ id: 999 });
    return this.json({ message: `fake GitHub: no route for ${method} ${p}` }, 404);
  };
}

/** Installs a fake GitHub as global fetch for the duration of a test. */
export function withGitHub(t: { after: (fn: () => void) => void }): FakeGitHub {
  const gh = new FakeGitHub();
  const real = globalThis.fetch;
  globalThis.fetch = gh.handle as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return gh;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** A human who has signed in: grant stored, account created. Returns a session cookie and an account key. */
export async function signIn(env: Env, u: FakeUser) {
  await gw.upsertGatewayUser(env, { login: u.login, github_id: u.id, email: u.email ?? null, access_token: u.token, refresh_token: null, expires_in: null });
  const accountId = await gw.upsertAccount(env.DB, { login: u.login, github_id: u.id }, "human");
  const session = await gw.createSession(env.DB, accountId, "test");
  const key = await gw.createAccountKey(env.DB, accountId, "test");
  return { accountId, cookie: `githug_session=${session}`, key, bearer: { authorization: `Bearer ${key}` } };
}

export const repo = (full_name: string, perm: "admin" | "push" | "pull" | "triage", priv = false): FakeRepo => ({
  full_name,
  private: priv,
  permissions: { admin: perm === "admin", push: perm === "admin" || perm === "push", triage: perm !== "pull", pull: true },
});

/** Signs in through the real OAuth routes (state cookie and all); returns the session cookie or the failing response. */
export async function oauthSignIn(env: Env, gh: FakeGitHub, u: FakeUser): Promise<{ cookie?: string; res: Response }> {
  const code = `code_${u.login}`;
  gh.codes.set(code, u.token);
  const start = await call(env, "GET", "/login?next=/app");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const res = await call(env, "GET", `/gateway/oauth/callback?code=${code}&state=${state}`, { headers: { cookie: `githug_oauth_state=${state}` } });
  const m = /githug_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  return { cookie: m?.[1] ? `githug_session=${m[1]}` : undefined, res };
}
