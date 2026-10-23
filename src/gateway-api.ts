/**
 * githug Gateway v0 — agents as principals, backed by one GitHub App.
 *
 *   agent key ──▶ POST /v1/token ──▶ (app JWT) ──▶ installation token for ONE repo, 1h
 *
 * The GitHub App ("githug Gateway") is installed once by a human on their repos. The
 * gateway then mints per-agent, per-repo, short-lived installation tokens from it and
 * logs every issuance to D1. The app's private key never leaves the Worker; agents only
 * ever hold their own bearer key and the hour-long tokens it buys.
 *
 * Secrets (wrangler secret put): GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (PKCS#8 PEM),
 * GITHUB_APP_SLUG (the app's URL slug, for the bot's commit identity).
 *
 * B1.2 v1 (docs/ATTRIBUTION.md) adds humans as principals via GitHub user-to-server
 * OAuth (GITHUB_OAUTH_CLIENT_ID/SECRET) and per-agent author identity. OAuth tokens are
 * never stored plaintext — GATEWAY_ENC_KEY (base64 32 bytes) encrypts them at rest.
 */

export interface GatewayEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  GATEWAY_ENC_KEY?: string; // base64-encoded 32 bytes; AES-GCM key for gateway_users.oauth_*
}

export interface AgentRow {
  id: string;
  account_id: string | null;
  /** Lineage (M2.6): the agent that created this one (null = created by its human), and how deep. */
  parent: string | null;
  depth: number;
  name: string;
  repos: string[];
  /** Permission subset for minted tokens; null = DEFAULT_TOKEN_PERMISSIONS. */
  permissions: Record<string, string> | null;
  accountable: string;
  /** The accountable human's GitHub id, when known (stable across renames). */
  accountable_id: number | null;
  email: string; // git author email for this agent's commits; defaults to <id>@agents.githug.ai
  /** Add Co-authored-by for the accountable human (counts on their GitHub graph). Off by default. */
  credit_human: boolean;
  created: string;
  disabled: number;
  last_used: string | null;
}

export interface GatewayUser {
  login: string;
  email: string;
}

import { SITE_ORIGIN, BRAND, brandSlug, agentEmail, agentEmailRe } from "./site.js";
import { page, UI_CSS } from "./layout.js";

const GH = "https://api.github.com";

/**
 * What an agent's token can do unless the agent row narrows it further. Deliberately
 * excludes administration, workflows, members, secrets: an agent can push branches and
 * work issues/PRs, and nothing else. Pushing to main is the remote's branch protection.
 */
export const DEFAULT_TOKEN_PERMISSIONS: Record<string, string> = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  metadata: "read",
};
/**
 * Opt-in per agent: the default set plus `workflows: write`, which GitHub requires for any
 * push that touches .github/workflows. Workflows run with the repo's secrets, so only a
 * human can turn it on (dashboard), and the agent's GitHub App must hold the Workflows
 * permission or GitHub refuses the mint.
 */
export const WORKFLOW_TOKEN_PERMISSIONS: Record<string, string> = { ...DEFAULT_TOKEN_PERMISSIONS, workflows: "write" };

export function canChangeWorkflows(agent: AgentRow): boolean {
  return agent.permissions?.workflows === "write";
}

const UA = "githug-gateway/0.1 (+https://github.com/githug-ai/githug)";
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

// ---------------------------------------------------------------------------
// small crypto helpers
// ---------------------------------------------------------------------------
function b64url(input: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A new agent bearer key. Prefix makes it greppable in secret scanners. */
export function newAgentKey(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return "ghg_" + b64url(b);
}

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// token encryption at rest (AES-256-GCM, WebCrypto) — gateway_users.oauth_*
// ---------------------------------------------------------------------------
async function encKey(env: GatewayEnv): Promise<CryptoKey> {
  if (!env.GATEWAY_ENC_KEY) throw new Error("gateway not configured: GATEWAY_ENC_KEY");
  const raw = fromB64(env.GATEWAY_ENC_KEY);
  if (raw.length !== 32) throw new Error("GATEWAY_ENC_KEY must decode to 32 bytes (openssl rand -base64 32)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Random 12-byte IV per call; stored as base64(iv || ciphertext). Throws if GATEWAY_ENC_KEY is unset. */
export async function encryptSecret(env: GatewayEnv, plaintext: string): Promise<string> {
  const key = await encKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return b64(out);
}

export async function decryptSecret(env: GatewayEnv, stored: string): Promise<string> {
  const key = await encKey(env);
  const raw = fromB64(stored);
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// Imported signing keys, by PEM: the shared App's plus one per named agent App (M2.1).
const keyCache = new Map<string, CryptoKey>();

async function signingKey(pem: string): Promise<CryptoKey> {
  const hit = keyCache.get(pem);
  if (hit) return hit;
  if (!/BEGIN PRIVATE KEY/.test(pem)) {
    throw new Error("GITHUB_APP_PRIVATE_KEY must be PKCS#8 (BEGIN PRIVATE KEY). Convert: openssl pkcs8 -topk8 -nocrypt -in app.pem");
  }
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  if (keyCache.size > 50) keyCache.clear();
  keyCache.set(pem, key);
  return key;
}

/** GitHub App JWT (RS256, 9 minutes, 60s clock skew) for any App id + PKCS#8 key. */
async function appJwtFor(appId: string | number, pem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(appId) }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await signingKey(pem), new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
}

/** The shared githug Gateway App's JWT. */
export async function appJwt(env: GatewayEnv): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new Error("gateway not configured: GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY");
  return appJwtFor(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
}

/**
 * GitHub's manifest conversion returns a PKCS#1 key ("BEGIN RSA PRIVATE KEY"); WebCrypto
 * only imports PKCS#8. Wrap it: SEQUENCE { INTEGER 0, SEQUENCE { rsaEncryption, NULL }, OCTET STRING pkcs1 }.
 */
export function pkcs1ToPkcs8Pem(pem: string): string {
  if (/BEGIN PRIVATE KEY/.test(pem)) return pem;
  const pkcs1 = new Uint8Array(pemToDer(pem));
  const len = (n: number) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
  const tlv = (tag: number, body: number[]) => [tag, ...len(body.length), ...body];
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const der = tlv(0x30, [0x02, 0x01, 0x00, ...algId, ...tlv(0x04, [...pkcs1])]);
  const b = b64(new Uint8Array(der));
  return `-----BEGIN PRIVATE KEY-----\n${b.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

async function gh(path: string, token: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${GH}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": UA,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.message || res.statusText;
    throw new Error(`GitHub ${res.status} on ${path}: ${msg}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// GitHub App: installation lookup + token minting
// ---------------------------------------------------------------------------

/** Which installation of the app covers this repo (cached 1h). Throws if the app isn't installed there. */
export async function installationForRepo(env: GatewayEnv, repo: string, fresh = false): Promise<number> {
  const cacheKey = `gw:inst:${repo.toLowerCase()}`;
  const hit = fresh ? null : await env.CACHE.get(cacheKey);
  if (hit) return Number(hit);
  const data = await gh(`/repos/${repo}/installation`, await appJwt(env));
  const id = Number(data.id);
  await env.CACHE.put(cacheKey, String(id), { expirationTtl: 3600 });
  return id;
}

/**
 * Runs fn with the repo's installation. A cached installation can be stale (the App was
 * uninstalled and reinstalled, so the id changed): on a GitHub 404, look it up again once.
 */
async function withInstallation<T>(env: GatewayEnv, repo: string, fn: (installationId: number) => Promise<T>): Promise<T> {
  const id = await installationForRepo(env, repo);
  try {
    return await fn(id);
  } catch (e) {
    if (!/^GitHub 404/.test((e as Error).message)) throw e;
    const fresh = await installationForRepo(env, repo, true);
    if (fresh === id) throw e;
    return fn(fresh);
  }
}

export interface MintedToken {
  token: string;
  expires_at: string;
  permissions: Record<string, string>;
}

/** Mint an installation token restricted to exactly one repository and a permission subset. */
export async function mintInstallationToken(
  env: GatewayEnv,
  installationId: number,
  repo: string,
  permissions: Record<string, string> = DEFAULT_TOKEN_PERMISSIONS,
): Promise<MintedToken> {
  const [, name] = repo.split("/");
  const data = await gh(`/app/installations/${installationId}/access_tokens`, await appJwt(env), {
    method: "POST",
    body: JSON.stringify({ repositories: [name], permissions }),
  });
  return { token: data.token, expires_at: data.expires_at, permissions: data.permissions ?? {} };
}

/**
 * The commit identity for the app's bot user: `<id>+<slug>[bot]@users.noreply.github.com`
 * (cached 24h). Looked up with an installation token: the app JWT is only good for
 * app-level endpoints, not /users.
 */
export async function botIdentity(env: GatewayEnv, installationToken: string): Promise<{ login: string; email: string } | null> {
  const slug = env.GITHUB_APP_SLUG;
  if (!slug) return null;
  const cacheKey = `gw:bot:${slug}`;
  const hit = await env.CACHE.get(cacheKey);
  if (hit) return JSON.parse(hit);
  try {
    const u = await gh(`/users/${slug}%5Bbot%5D`, installationToken);
    const ident = { login: `${slug}[bot]`, email: `${u.id}+${slug}[bot]@users.noreply.github.com` };
    await env.CACHE.put(cacheKey, JSON.stringify(ident), { expirationTtl: 86_400 });
    return ident;
  } catch (e) {
    console.error("botIdentity failed:", (e as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// agents (D1)
// ---------------------------------------------------------------------------
function rowToAgent(r: any): AgentRow {
  let repos: string[] = [];
  try {
    repos = JSON.parse(r.repos ?? "[]");
  } catch {
    repos = [];
  }
  let permissions: Record<string, string> | null = null;
  try {
    permissions = r.permissions ? JSON.parse(r.permissions) : null;
  } catch {
    permissions = null;
  }
  // Backfills rows created before the email column existed; see createAgent for new rows.
  const email = r.email ?? agentEmail(r.id);
  return { id: r.id, account_id: r.account_id ?? null, parent: r.parent ?? null, depth: r.depth ?? 0, name: r.name, repos, permissions, accountable: r.accountable ?? "", accountable_id: r.accountable_id ?? null, email, credit_human: !!r.credit_human, created: r.created, disabled: r.disabled ?? 0, last_used: r.last_used ?? null };
}

export function validRepo(repo: unknown): repo is string {
  return typeof repo === "string" && REPO_RE.test(repo);
}

export async function createAgent(
  db: D1Database,
  input: { id: string; name: string; repos: string[]; accountable: string; accountable_id?: number | null; account_id?: string | null; permissions?: Record<string, string> | null; email?: string; parent?: string | null; depth?: number; credit_human?: boolean },
): Promise<{ agent: AgentRow; key: string }> {
  const key = newAgentKey();
  const created = new Date().toISOString();
  const permissions = input.permissions ?? null;
  const email = input.email?.trim() || agentEmail(input.id);
  await db
  const credit = !!input.credit_human;
  await db
    .prepare("INSERT INTO gateway_agents (id,name,key_hash,repos,accountable,accountable_id,created,disabled,permissions,email,account_id,parent,depth,credit_human) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?)")
    .bind(input.id, input.name, await sha256Hex(key), JSON.stringify(input.repos), input.accountable, input.accountable_id ?? null, created, permissions ? JSON.stringify(permissions) : null, email, input.account_id ?? null, input.parent ?? null, input.depth ?? 0, credit ? 1 : 0)
    .run();
  return { agent: { id: input.id, account_id: input.account_id ?? null, parent: input.parent ?? null, depth: input.depth ?? 0, name: input.name, repos: input.repos, permissions, accountable: input.accountable, accountable_id: input.accountable_id ?? null, email, credit_human: credit, created, disabled: 0, last_used: null }, key };
}

/** The agent behind a key. A sub-agent under a disabled ancestor comes back disabled. */
export async function findAgentByKey(db: D1Database, key: string): Promise<AgentRow | null> {
  if (!/^ghg_[A-Za-z0-9_-]{40,50}$/.test(key)) return null;
  const r = await db.prepare("SELECT * FROM gateway_agents WHERE key_hash = ?").bind(await sha256Hex(key)).first<any>();
  if (!r) return null;
  const agent = rowToAgent(r);
  if (!agent.disabled && agent.parent && (await ancestorDisabled(db, agent.parent))) agent.disabled = 1;
  return agent;
}

/** Whether this agent or any agent above it is disabled. */
async function ancestorDisabled(db: D1Database, id: string): Promise<boolean> {
  const r = await db
    .prepare(
      `WITH RECURSIVE up(id, parent, disabled) AS (SELECT id, parent, disabled FROM gateway_agents WHERE id = ?1
         UNION SELECT a.id, a.parent, a.disabled FROM gateway_agents a JOIN up u ON a.id = u.parent)
       SELECT COUNT(*) n FROM up WHERE disabled = 1`,
    )
    .bind(id)
    .first<any>();
  return (r?.n ?? 0) > 0;
}

/** Disables every agent below this one (not the agent itself); returns how many. */
export async function disableDescendants(db: D1Database, id: string): Promise<number> {
  const r = await db
    .prepare(
      `WITH RECURSIVE tree(id) AS (SELECT id FROM gateway_agents WHERE parent = ?1 UNION SELECT a.id FROM gateway_agents a JOIN tree t ON a.parent = t.id)
       UPDATE gateway_agents SET disabled = 1 WHERE disabled = 0 AND id IN (SELECT id FROM tree)`,
    )
    .bind(id)
    .run();
  return r.meta?.changes ?? 0;
}

/** All agents (admin), or only those owned by one account. */
export async function listAgents(db: D1Database, accountId?: string): Promise<AgentRow[]> {
  const q = accountId
    ? db.prepare("SELECT * FROM gateway_agents WHERE account_id = ? ORDER BY created DESC").bind(accountId)
    : db.prepare("SELECT * FROM gateway_agents ORDER BY created DESC");
  return ((await q.all<any>()).results ?? []).map(rowToAgent);
}

/**
 * Disables/enables an agent; with accountId, only if that account owns it. Disabling
 * cascades to every descendant (M2.6); enabling is just this agent, so a parent coming
 * back doesn't silently revive workers someone switched off, and a sub-agent can't be
 * enabled while an agent above it is disabled.
 */
export async function setAgentDisabled(db: D1Database, id: string, disabled: boolean, accountId?: string): Promise<boolean | "parent_disabled"> {
  const owned = accountId
    ? await db.prepare("SELECT parent FROM gateway_agents WHERE id = ? AND account_id = ?").bind(id, accountId).first<any>()
    : await db.prepare("SELECT parent FROM gateway_agents WHERE id = ?").bind(id).first<any>();
  if (!owned) return false;
  if (!disabled) {
    if (owned.parent && (await ancestorDisabled(db, owned.parent))) return "parent_disabled";
    await db.prepare("UPDATE gateway_agents SET disabled = 0 WHERE id = ?").bind(id).run();
    return true;
  }
  await db
    .prepare(
      `WITH RECURSIVE tree(id) AS (SELECT ?1 UNION SELECT a.id FROM gateway_agents a JOIN tree t ON a.parent = t.id)
       UPDATE gateway_agents SET disabled = 1 WHERE id IN (SELECT id FROM tree)`,
    )
    .bind(id)
    .run();
  return true;
}

export const MAX_AGENT_DEPTH = 3;
const MAX_DESCENDANTS = 100;

/** The chain from the root agent down to this one: ["orbit", "orbit-w1"]. */
export async function agentChain(db: D1Database, agent: AgentRow): Promise<string[]> {
  if (!agent.parent) return [agent.id];
  const rs = await db
    .prepare(
      `WITH RECURSIVE up(id, parent, depth) AS (SELECT id, parent, depth FROM gateway_agents WHERE id = ?1
         UNION SELECT a.id, a.parent, a.depth FROM gateway_agents a JOIN up u ON a.id = u.parent)
       SELECT id FROM up ORDER BY depth`,
    )
    .bind(agent.id)
    .all<any>();
  return (rs.results ?? []).map((r) => r.id);
}

/**
 * An agent creates a sub-agent (M2.6): id prefixed with the parent's, accountable and
 * account inherited, repos and permissions a subset of the parent's, depth ≤ 3, and at
 * most 100 descendants under one root.
 */
export async function createChildAgent(
  db: D1Database,
  parent: AgentRow,
  input: { name: string; repos?: string[]; permissions?: Record<string, string> | null },
): Promise<{ agent: AgentRow; key: string } | { error: string }> {
  const suffix = input.name.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/.test(suffix)) return { error: "name must be up to 20 lowercase letters, digits, dashes" };
  const id = `${parent.id}-${suffix}`;
  if (id.length > 40) return { error: `'${id}' is too long; use a shorter name` };
  if (parent.depth + 1 > MAX_AGENT_DEPTH) return { error: `agents nest at most ${MAX_AGENT_DEPTH} deep` };
  const repos = input.repos?.length ? input.repos : parent.repos;
  const parentRepos = new Set(parent.repos.map((r) => r.toLowerCase()));
  if (!repos.every((r) => parentRepos.has(r.toLowerCase()))) return { error: "a sub-agent can only work on its parent's repos" };
  const parentPerms = parent.permissions ?? DEFAULT_TOKEN_PERMISSIONS;
  const rank = (v: string | undefined) => (v === "write" ? 2 : v === "read" ? 1 : 0);
  const perms = input.permissions ?? null;
  if (perms && !Object.entries(perms).every(([k, v]) => rank(v) > 0 && rank(v) <= rank(parentPerms[k]))) return { error: "a sub-agent's permissions must be a subset of its parent's" };
  const root = (await agentChain(db, parent))[0];
  const count = await db
    .prepare(`WITH RECURSIVE tree(id) AS (SELECT ?1 UNION SELECT a.id FROM gateway_agents a JOIN tree t ON a.parent = t.id) SELECT COUNT(*) n FROM tree`)
    .bind(root)
    .first<any>();
  if ((count?.n ?? 0) > MAX_DESCENDANTS) return { error: `at most ${MAX_DESCENDANTS} sub-agents under ${root}` };
  try {
    return await createAgent(db, { id, name: id, repos, accountable: parent.accountable, accountable_id: parent.accountable_id, account_id: parent.account_id, permissions: perms ?? parent.permissions, parent: parent.id, depth: parent.depth + 1, credit_human: parent.credit_human });
  } catch (e) {
    return { error: /UNIQUE|constraint/i.test((e as Error).message) ? `'${id}' already exists` : "could not create the sub-agent" };
  }
}

// ---------------------------------------------------------------------------
// installations an account can use (M1.3). Source of truth is GitHub, asked with the
// human's own user-to-server token: it only returns installations of this App that the
// human can access, and only the repos in them they can access.
// ---------------------------------------------------------------------------
export interface AccountRepo {
  repo: string; // owner/repo
  installation_id: number;
  private: boolean;
}

/** The human whose GitHub grant an account acts through: login for display, GitHub id for lookups. */
export interface Actor {
  login: string;
  id?: number | null;
}

/** Push (or higher) on the repo. Read or triage access isn't enough to put a writing agent on it. */
function canPush(r: any): boolean {
  const p = r?.permissions ?? {};
  return !!(p.push || p.maintain || p.admin);
}

/** Repos in one of this App's installations that the user's token can push to. */
async function pushableRepos(installationId: number, token: string): Promise<AccountRepo[]> {
  const out: AccountRepo[] = [];
  for (let page = 1; page <= 10; page++) {
    const rs = await gh(`/user/installations/${installationId}/repositories?per_page=100&page=${page}`, token);
    for (const r of rs.repositories ?? []) if (canPush(r)) out.push({ repo: r.full_name, installation_id: installationId, private: !!r.private });
    if ((rs.repositories ?? []).length < 100) break;
  }
  return out;
}

/**
 * Syncs gateway_installations from GitHub and returns every repo the account may put agents
 * on: repos in this App's installations that the acting human can push to (cached 60s).
 */
export async function accountRepos(env: GatewayEnv, account: Account, fresh = false): Promise<AccountRepo[]> {
  const actor = accountActor(account);
  const cacheKey = `gw:acctrepos2:${account.id}:${actor.id ?? actor.login}`;
  if (!fresh) {
    const hit = await env.CACHE.get(cacheKey);
    if (hit) return JSON.parse(hit);
  }
  const token = await getUserToken(env, actor);
  if (!token) return [];
  const inst = await gh("/user/installations?per_page=100", token);
  // An org account only sees its own org's installation, through the acting member's eyes.
  if (account.kind === "org") inst.installations = (inst.installations ?? []).filter((i: any) => String(i.account?.login ?? "").toLowerCase() === account.login.toLowerCase());
  const repos: AccountRepo[] = [];
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM gateway_installations WHERE account_id = ?").bind(account.id)];
  for (const i of inst.installations ?? []) {
    stmts.push(
      env.DB.prepare("INSERT INTO gateway_installations (installation_id,account_id,target_login,target_type,synced) VALUES (?,?,?,?,?)")
        .bind(i.id, account.id, i.account?.login ?? null, i.account?.type ?? null, now),
    );
    repos.push(...(await pushableRepos(i.id, token)));
  }
  await env.DB.batch(stmts);
  await env.CACHE.put(cacheKey, JSON.stringify(repos), { expirationTtl: 60 });
  return repos;
}

/** The App's public install page; `state` round-trips through the OAuth-during-install callback. */
export function installUrl(env: GatewayEnv, state: string): string {
  return `https://github.com/apps/${env.GITHUB_APP_SLUG ?? "githug-gateway"}/installations/new?state=${encodeURIComponent(state)}`;
}

export async function logToken(
  db: D1Database,
  t: { agent_id: string; repo: string; installation_id: number; expires: string; ip_hash: string; run: string; minted_by: string; surface: string },
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare("INSERT INTO gateway_tokens (agent_id,repo,installation_id,issued,expires,ip_hash,run,minted_by,surface) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(t.agent_id, t.repo, t.installation_id, now, t.expires, t.ip_hash, t.run, t.minted_by, t.surface),
    db.prepare("UPDATE gateway_agents SET last_used = ? WHERE id = ?").bind(now, t.agent_id),
  ]);
}

// ---------------------------------------------------------------------------
// gateway_users (D1) — humans as principals, B1.2 v1 (docs/ATTRIBUTION.md)
// ---------------------------------------------------------------------------

export async function findGatewayUser(db: D1Database, who: string | Actor): Promise<GatewayUser | null> {
  const actor = typeof who === "string" ? { login: who } : who;
  const r = actor.id
    ? await db.prepare("SELECT login, email FROM gateway_users WHERE github_id = ?").bind(actor.id).first<any>()
    : await db.prepare("SELECT login, email FROM gateway_users WHERE login = ?").bind(actor.login).first<any>();
  return r ? { login: r.login, email: r.email } : null;
}

/** Upserts the OAuth grant for a GitHub login, encrypting tokens before they touch D1. */
export async function upsertGatewayUser(
  env: GatewayEnv,
  u: { login: string; github_id: number; email: string | null; access_token: string; refresh_token?: string | null; expires_in?: number | null },
): Promise<void> {
  const email = u.email || `${u.github_id}+${u.login}@users.noreply.github.com`;
  const oauthToken = await encryptSecret(env, u.access_token);
  const oauthRefresh = u.refresh_token ? await encryptSecret(env, u.refresh_token) : null;
  const oauthExpires = u.expires_in ? new Date(Date.now() + u.expires_in * 1000).toISOString() : null;
  // One grant per GitHub user, and a login belongs only to its current holder: drop this
  // user's row under an old login, and a previous holder's grant under this login (they
  // renamed; their grant must not answer for the new holder, or vice versa).
  await env.DB.prepare("DELETE FROM gateway_users WHERE (github_id = ?1 AND login <> ?2) OR (login = ?2 AND github_id IS NOT ?1)").bind(u.github_id, u.login).run();
  await env.DB.prepare(
    `INSERT INTO gateway_users (login,github_id,email,oauth_token,oauth_refresh,oauth_expires,created) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(login) DO UPDATE SET github_id=excluded.github_id, email=excluded.email,
       oauth_token=excluded.oauth_token, oauth_refresh=excluded.oauth_refresh, oauth_expires=excluded.oauth_expires`,
  )
    .bind(u.login, u.github_id, email, oauthToken, oauthRefresh, oauthExpires, new Date().toISOString())
    .run();
}

/**
 * The PR-surface credential for the next B1.2 slice (opening PRs/comments/reviews as the
 * accountable human, per docs/ATTRIBUTION.md). Not called by anything yet. Refreshes
 * automatically when the stored token is within 5 minutes of expiry.
 */
export async function getUserToken(env: GatewayEnv, who: string | Actor): Promise<string | null> {
  const actor = typeof who === "string" ? { login: who } : who;
  // By GitHub id when known: logins can be renamed and then claimed by someone else.
  const row = actor.id
    ? await env.DB.prepare("SELECT login, oauth_token, oauth_refresh, oauth_expires FROM gateway_users WHERE github_id = ?").bind(actor.id).first<any>()
    : await env.DB.prepare("SELECT login, oauth_token, oauth_refresh, oauth_expires FROM gateway_users WHERE login = ?").bind(actor.login).first<any>();
  if (!row?.oauth_token) return null;
  const login = row.login;
  const expiresSoon = row.oauth_expires && new Date(row.oauth_expires).getTime() - Date.now() < 5 * 60 * 1000;
  if (expiresSoon && row.oauth_refresh) {
    try {
      const refreshToken = await decryptSecret(env, row.oauth_refresh);
      const refreshed = await exchangeOAuthRefresh(env, refreshToken);
      const oauthToken = await encryptSecret(env, refreshed.access_token);
      const oauthRefresh = refreshed.refresh_token ? await encryptSecret(env, refreshed.refresh_token) : row.oauth_refresh;
      const oauthExpires = refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString() : null;
      await env.DB.prepare("UPDATE gateway_users SET oauth_token=?, oauth_refresh=?, oauth_expires=? WHERE login=?").bind(oauthToken, oauthRefresh, oauthExpires, login).run();
      return refreshed.access_token;
    } catch (e) {
      console.error("oauth refresh failed:", (e as Error).message);
      // fall through and hand back the token on hand; it may still be briefly valid
    }
  }
  return decryptSecret(env, row.oauth_token);
}

interface OAuthTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

async function oauthTokenRequest(env: GatewayEnv, params: Record<string, string>): Promise<OAuthTokenResponse> {
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) throw new Error("gateway not configured: GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET");
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ client_id: env.GITHUB_OAUTH_CLIENT_ID, client_secret: env.GITHUB_OAUTH_CLIENT_SECRET, ...params }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error_description || data.error || `GitHub OAuth ${res.status}`);
  return data;
}

/** Exchanges the `code` from /gateway/oauth/callback for a user-to-server access token. */
export async function exchangeOAuthCode(env: GatewayEnv, code: string, redirectUri: string): Promise<OAuthTokenResponse> {
  return oauthTokenRequest(env, { code, redirect_uri: redirectUri });
}

async function exchangeOAuthRefresh(env: GatewayEnv, refreshToken: string): Promise<OAuthTokenResponse> {
  return oauthTokenRequest(env, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/** GET /user with a user-to-server token — the login/id/email to upsert into gateway_users. */
export async function fetchGithubUser(token: string): Promise<{ login: string; id: number; email: string | null }> {
  const u = await gh("/user", token);
  return { login: u.login, id: u.id, email: u.email ?? null };
}

const OAUTH_STATE_TTL = 600; // 10 minutes

/**
 * CSRF state for the OAuth dance, stored in CACHE (KV) so it survives across isolates.
 * The stored value is where to send the user after login (a same-site path).
 */
export async function createOAuthState(cache: KVNamespace, next = "/app"): Promise<string> {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  const state = b64url(b);
  await cache.put(`oauth-state:${state}`, next, { expirationTtl: OAUTH_STATE_TTL });
  return state;
}

/** Verifies and single-use-consumes a state value; returns its next path, or null if missing/expired/used. */
export async function consumeOAuthState(cache: KVNamespace, state: string): Promise<string | null> {
  const key = `oauth-state:${state}`;
  const next = await cache.get(key);
  if (!next) return null;
  await cache.delete(key);
  return next;
}

/** Only same-site absolute paths survive as a post-login redirect ("//evil.com" does not). */
export function safeNextPath(next: string | undefined): string {
  return next && /^\/(?![\/\\])[\w\-./?=&%]*$/.test(next) ? next : "/app";
}

// ---------------------------------------------------------------------------
// accounts + sessions (M1.1/M1.2, migration 0010)
// ---------------------------------------------------------------------------
export const SESSION_COOKIE = "githug_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;

export interface Account {
  id: string;
  login: string; // GitHub login of the user, or of the org for an org account
  plan: string;
  kind?: "user" | "org";
  /** The signed-in human acting for this account; their GitHub token makes GitHub calls. */
  actor?: string;
  /** That human's GitHub id (stable across renames). */
  actorId?: number | null;
}

export function accountActor(account: Account): Actor {
  return { login: account.actor ?? account.login, id: account.actorId ?? null };
}

/** Creates the account on first sign-in (recording how it arrived) and refreshes the login after. */
export async function upsertAccount(db: D1Database, u: { login: string; github_id: number }, via: "human" | "agent"): Promise<string> {
  const id = `gh:${u.github_id}`;
  await db
    .prepare(
      `INSERT INTO accounts (id,login,github_id,plan,created_via,created) VALUES (?,?,?,'free',?,?)
       ON CONFLICT(id) DO UPDATE SET login=excluded.login`,
    )
    .bind(id, u.login, u.github_id, via, new Date().toISOString())
    .run();
  return id;
}

/** Starts a session and returns the raw cookie value; only its hash is stored. */
export async function createSession(db: D1Database, accountId: string, userAgent: string | null): Promise<string> {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  const raw = b64url(b);
  const now = Date.now();
  await db
    .prepare("INSERT INTO sessions (id_hash,account_id,user_agent,created,expires) VALUES (?,?,?,?,?)")
    .bind(await sha256Hex(raw), accountId, (userAgent ?? "").slice(0, 200), new Date(now).toISOString(), new Date(now + SESSION_TTL_SECONDS * 1000).toISOString())
    .run();
  return raw;
}

export async function sessionAccount(db: D1Database, raw: string | undefined): Promise<Account | null> {
  if (!raw || raw.length > 100) return null;
  const r = await db
    .prepare("SELECT a.id, a.login, a.plan, a.github_id, s.acting_account_id acting FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id_hash = ? AND s.expires > ?")
    .bind(await sha256Hex(raw), new Date().toISOString())
    .first<any>();
  return r ? { id: r.id, login: r.login, plan: r.plan, kind: "user", actor: r.login, actorId: r.github_id ?? null, acting: r.acting ?? null } as Account & { acting: string | null } : null;
}

export async function deleteSession(db: D1Database, raw: string | undefined): Promise<void> {
  if (raw && raw.length <= 100) await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Hex(raw)).run();
}

export async function tokenStats(db: D1Database): Promise<{
  total: number;
  last24h: number;
  byAgent: { agent_id: string; n: number; last: string }[];
  recent: { agent_id: string; repo: string; run: string; issued: string; expires: string }[];
}> {
  const cutoff = new Date(Date.now() - 86_400_000).toISOString();
  const tot = await db.prepare("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN issued > ? THEN 1 ELSE 0 END),0) d FROM gateway_tokens").bind(cutoff).first<any>();
  const by = (await db.prepare("SELECT agent_id, COUNT(*) n, MAX(issued) last FROM gateway_tokens GROUP BY agent_id ORDER BY n DESC LIMIT 20").all<any>()).results ?? [];
  const recent = (await db.prepare("SELECT agent_id, repo, COALESCE(run,'') run, issued, expires FROM gateway_tokens ORDER BY issued DESC LIMIT 50").all<any>()).results ?? [];
  return {
    total: tot?.n ?? 0,
    last24h: tot?.d ?? 0,
    byAgent: by.map((r: any) => ({ agent_id: r.agent_id, n: r.n, last: r.last })),
    recent: recent.map((r: any) => ({ agent_id: r.agent_id, repo: r.repo, run: r.run, issued: r.issued, expires: r.expires })),
  };
}

// ---------------------------------------------------------------------------
// GitHub App registration (manifest flow) — a one-time admin page
// ---------------------------------------------------------------------------

/**
 * The instance's GitHub App, from a manifest (one click at /gateway/setup/github-app). The
 * name must be unique on GitHub, so a self-host passes its own. Sign-in is the App's own
 * user-to-server OAuth (callback below); "Enable Device Flow" for `hug login` is a checkbox
 * in the App's settings that manifests can't set.
 */
export function appManifest(origin: string, name = "githug Gateway"): object {
  return {
    name: name.slice(0, 34),
    url: origin === "https://githug.ai" ? "https://githug.ai/gateway" : origin,
    description: "Agents as principals: one short-lived, repo-scoped token per agent, minted from this app and logged.",
    hook_attributes: { url: `${origin}/api/gateway/github/webhook`, active: false },
    redirect_url: `${origin}/gateway/setup/github-app/callback`,
    callback_urls: [`${origin}/gateway/oauth/callback`],
    request_oauth_on_install: true,
    public: false,
    default_permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read", statuses: "write", checks: "write" },
    default_events: ["push", "pull_request"],
  };
}

/** Exchanges a manifest code (valid 1h) for the new App: id, slug, PEM, OAuth client id/secret, owner. */
export async function convertAppManifest(code: string): Promise<{ id: number; slug: string; pem: string; client_id: string; client_secret: string; webhook_secret: string | null; owner: { login: string; type: string } }> {
  const res = await fetch(`${GH}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", "User-Agent": UA, "X-GitHub-Api-Version": "2022-11-28" },
  });
  const app: any = await res.json().catch(() => ({}));
  if (!res.ok || !app.id || !app.pem) throw new Error(app.message || `manifest conversion ${res.status}`);
  return { id: app.id, slug: app.slug, pem: pkcs1ToPkcs8Pem(app.pem), client_id: app.client_id, client_secret: app.client_secret, webhook_secret: app.webhook_secret ?? null, owner: { login: app.owner?.login ?? "", type: app.owner?.type ?? "" } };
}

/** HTML page with the manifest form. Submitting it on github.com creates the app and redirects back with a code. */
export function manifestFormPage(manifest: object, owner?: string): string {
  const action = owner ? `https://github.com/organizations/${owner}/settings/apps/new` : "https://github.com/settings/apps/new";
  const json = JSON.stringify(manifest);
  return page({
    title: "Register githug Gateway",
    noindex: true,
    css: UI_CSS + "pre{background:var(--raise);border:1px solid var(--faint);padding:1rem;border-radius:6px;overflow:auto;font-size:12px}",
    body: `<main class="wrap"><h1>Register the "githug Gateway" GitHub App</h1>
<p>This posts the manifest below to GitHub. GitHub creates the app under your account and redirects back here with a one-time code, which the callback prints for the conversion step.</p>
<pre>${json.replace(/</g, "&lt;")}</pre>
<form method="post" action="${action}"><input type="hidden" name="manifest" value='${json.replace(/'/g, "&#39;")}'/><button class="btn go" type="submit">Create GitHub App</button></form>
</main>`,
  });
}

// ---------------------------------------------------------------------------
// account keys + device login for the `hug` CLI (M1.5, migration 0012)
// ---------------------------------------------------------------------------

/** A new account key: lets `hug` create and list the account's agents. Never mints repo tokens itself. */
export async function createAccountKey(db: D1Database, accountId: string, name: string): Promise<string> {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  const key = "hug_" + b64url(b);
  await db
    .prepare("INSERT INTO account_keys (key_hash,account_id,name,created,disabled) VALUES (?,?,?,?,0)")
    .bind(await sha256Hex(key), accountId, name.slice(0, 80), new Date().toISOString())
    .run();
  return key;
}

export async function accountByKey(db: D1Database, key: string): Promise<Account | null> {
  if (!/^hug_[A-Za-z0-9_-]{40,50}$/.test(key)) return null;
  const hash = await sha256Hex(key);
  const r = await db
    .prepare("SELECT a.id, a.login, a.plan, a.github_id FROM account_keys k JOIN accounts a ON a.id = k.account_id WHERE k.key_hash = ? AND k.disabled = 0")
    .bind(hash)
    .first<any>();
  if (!r) return null;
  await db.prepare("UPDATE account_keys SET last_used = ? WHERE key_hash = ?").bind(new Date().toISOString(), hash).run();
  return { id: r.id, login: r.login, plan: r.plan, kind: "user", actor: r.login, actorId: r.github_id ?? null };
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/** Starts GitHub's device flow for the githug Gateway App (Device Flow enabled in the App settings). */
export async function startDeviceFlow(env: GatewayEnv): Promise<DeviceCode> {
  if (!env.GITHUB_OAUTH_CLIENT_ID) throw new Error("gateway not configured: GITHUB_OAUTH_CLIENT_ID");
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ client_id: env.GITHUB_OAUTH_CLIENT_ID }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error_description || data.error || `GitHub device code ${res.status}`);
  return data;
}

/**
 * One poll of GitHub's device flow. Returns the user-to-server grant once the human has
 * approved, or the pending state ('authorization_pending' | 'slow_down') to keep polling.
 */
export async function pollDeviceFlow(env: GatewayEnv, deviceCode: string): Promise<{ pending: string } | { grant: OAuthTokenResponse }> {
  if (!env.GITHUB_OAUTH_CLIENT_ID) throw new Error("gateway not configured: GITHUB_OAUTH_CLIENT_ID");
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ client_id: env.GITHUB_OAUTH_CLIENT_ID, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (data.error === "authorization_pending" || data.error === "slow_down") return { pending: data.error };
  if (!res.ok || data.error || !data.access_token) throw new Error(data.error_description || data.error || `GitHub device token ${res.status}`);
  return { grant: data };
}

// ---------------------------------------------------------------------------
// read access for githug itself (verify page, PR outcomes). A read-only installation
// token per installation, cached for most of its hour.
// ---------------------------------------------------------------------------
const READ_PERMISSIONS = { contents: "read", pull_requests: "read", metadata: "read" };

async function readToken(env: GatewayEnv, repo: string): Promise<string> {
  return withInstallation(env, repo, async (installationId) => {
    const key = `gw:rtok:${installationId}`;
    const hit = await env.CACHE.get(key);
    if (hit) return hit;
    const data = await gh(`/app/installations/${installationId}/access_tokens`, await appJwt(env), {
      method: "POST",
      body: JSON.stringify({ permissions: READ_PERMISSIONS }),
    });
    await env.CACHE.put(key, data.token, { expirationTtl: 50 * 60 });
    return data.token;
  });
}

/**
 * "Key: value" trailer lines anywhere in a commit message — squash merges concatenate the
 * branch's commit messages, so the agent's trailers often aren't in the last paragraph.
 */
export function parseTrailers(message: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of message.split("\n")) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.+)$/.exec(line.trim());
    if (m) (out[m[1].toLowerCase()] ??= []).push(m[2].trim());
  }
  return out;
}

const AGENT_ID_CHARS = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * verified   — every check passes, including a push attestation made with the agent's key
 * consistent — the commit's claims match githug's records, but nothing proves the agent made
 *              it (author, trailers and dates are free text anyone can write)
 * partial    — names a registered agent, but some claim contradicts the records
 * not_githug — no githug agent identity, or an unknown agent
 */
export type Verdict = "verified" | "consistent" | "partial" | "not_githug";

export interface VerifyCheck {
  ok: boolean;
  label: string;
}

export type VerifyResult =
  | { kind: "not_installed" | "private" | "not_found" }
  | {
      kind: "commit";
      verdict: Verdict;
      /** The agent's key attested this commit at push time. */
      attested: boolean;
      repo: string;
      sha: string;
      date: string;
      title: string;
      agent: string | null;
      accountable: string | null;
      run: string | null;
      checks: VerifyCheck[];
    };

/**
 * Checks a commit against githug's own records: who the commit says it is (author email,
 * Agent/Accountable/Run trailers) versus the agent registry and the token log. Public
 * repos only — a private repo's chain is for its owner, in /app.
 */
export async function verifyCommit(env: GatewayEnv, repo: string, sha: string): Promise<VerifyResult> {
  let token: string;
  try {
    token = await readToken(env, repo);
  } catch {
    return { kind: "not_installed" };
  }
  const meta = await gh(`/repos/${repo}`, token).catch(() => null);
  if (!meta) return { kind: "not_found" };
  if (meta.private) return { kind: "private" };
  const c = await gh(`/repos/${repo}/commits/${sha}`, token).catch(() => null);
  if (!c?.sha) return { kind: "not_found" };
  return verifyCommitData(env, meta.full_name, {
    sha: c.sha,
    message: c.commit?.message ?? "",
    date: c.commit?.author?.date ?? c.commit?.committer?.date ?? "",
    author_email: c.commit?.author?.email ?? "",
    author_name: c.commit?.author?.name ?? "",
  });
}

export interface CommitData {
  sha: string;
  message: string;
  date: string;
  author_email: string;
  author_name: string;
}

/**
 * The checks behind the verify page, on commit data from anywhere: githug's own read of
 * GitHub (verifyCommit) or the verify Action, which reads the PR with the workflow's token
 * so maintainers don't have to install githug.
 */
export async function verifyCommitData(env: GatewayEnv, repo: string, c: CommitData): Promise<VerifyResult & { kind: "commit" }> {
  const AGENT_EMAIL_RE = agentEmailRe();
  const message = c.message;
  const trailers = parseTrailers(message);
  const date = c.date;
  // Who the commit says the agent is, strongest first: author <id>@agents.githug.ai, the
  // githug App's bot as author under the agent's name, a co-author at agents.githug.ai,
  // then an Agent: trailer.
  const authorEmail: string = c.author_email;
  const authorName: string = c.author_name.toLowerCase();
  const slug = (env.GITHUB_APP_SLUG ?? "githug-gateway").toLowerCase();
  const namedBot = await agentForBotEmail(env.DB, authorEmail).catch(() => null);
  const byApp = authorEmail.toLowerCase().endsWith(`+${slug}[bot]@users.noreply.github.com`) || !!namedBot;
  const viaBot = namedBot ?? (byApp && AGENT_ID_CHARS.test(authorName) ? authorName : null);
  const coAuthor = (trailers["co-authored-by"] ?? []).map((v) => AGENT_EMAIL_RE.exec(/<([^>]+)>/.exec(v)?.[1] ?? "")?.[1]?.toLowerCase()).find(Boolean) ?? null;
  const emailAgent = AGENT_EMAIL_RE.exec(authorEmail)?.[1]?.toLowerCase() ?? viaBot;
  const agentId = emailAgent ?? coAuthor ?? trailers["agent"]?.[0]?.toLowerCase() ?? null;
  const accountableTrailer = trailers["accountable"]?.[0] ?? null;
  const run = trailers["run"]?.[0] ?? null;
  const base = { repo, sha: c.sha, date, title: message.split("\n")[0].slice(0, 200), run };
  if (!agentId) return { kind: "commit", verdict: "not_githug", attested: false, agent: null, accountable: accountableTrailer, checks: [{ ok: false, label: "No githug agent identity on this commit" }], ...base };

  const row = await env.DB.prepare("SELECT * FROM gateway_agents WHERE id = ?").bind(agentId).first<any>();
  const agent = row ? rowToAgent(row) : null;
  const checks: VerifyCheck[] = [];
  let att: { attested: string; run: string | null } | null = null;
  checks.push({
    ok: !!emailAgent || byApp,
    label: emailAgent
      ? namedBot ? `Authored by ${agentId}'s own GitHub identity (${authorEmail.split("@")[0].replace(/^\d+\+/, "")})` : viaBot && !AGENT_EMAIL_RE.test(authorEmail) ? `Authored by githug's App as ${agentId}` : `Authored as ${agentEmail(agentId)}`
      : byApp
        ? `Authored by githug's App (${slug}[bot]), agent ${agentId} named in ${coAuthor ? "a co-author" : "a trailer"}`
        : `Agent named in ${coAuthor ? "a co-author" : "a trailer"}; the author is ${authorEmail || "unknown"}`,
  });
  checks.push({ ok: !!agent, label: agent ? `Agent ${agentId} is registered with githug` : `No githug agent named ${agentId}` });
  if (agent) {
    checks.push({
      ok: !accountableTrailer || accountableTrailer.toLowerCase() === agent.accountable.toLowerCase(),
      label: accountableTrailer ? `Accountable: ${accountableTrailer} ${accountableTrailer.toLowerCase() === agent.accountable.toLowerCase() ? "matches" : `does not match githug's record (${agent.accountable})`}` : `Accountable human on record: ${agent.accountable}`,
    });
    checks.push({ ok: agent.repos.some((r) => r.toLowerCase() === base.repo.toLowerCase()), label: `${base.repo} is within the agent's scope` });
    if (agent.parent) checks.push({ ok: true, label: `Sub-agent: ${(await agentChain(env.DB, agent)).join(" › ")}, created with its parent's key` });
    // The proof: the agent's own key reported this commit when it pushed it.
    att = /^[0-9a-f]{40}$/.test(c.sha)
      ? await env.DB.prepare("SELECT attested, run FROM gateway_commits WHERE repo = ? AND sha = ? AND agent_id = ?").bind(base.repo.toLowerCase(), c.sha.toLowerCase(), agentId).first<any>()
      : null;
    checks.push({
      ok: !!att,
      label: att
        ? `${agentId}'s key attested this commit at push, ${String(att.attested).slice(0, 16).replace("T", " ")} UTC`
        : `Not attested by ${agentId}'s key at push (made with an older hug, or not pushed by the agent)`,
    });
    // A token for this agent on this repo, minted in the hour before the commit. With an
    // attestation, its server time; otherwise the author date (free text; allow 10 min drift).
    const t = att ? new Date(att.attested).getTime() : date ? new Date(date).getTime() : 0;
    const mint = t
      ? await env.DB.prepare("SELECT issued, run FROM gateway_tokens WHERE agent_id = ? AND lower(repo) = lower(?) AND issued BETWEEN ? AND ? ORDER BY issued DESC LIMIT 1")
          .bind(agentId, base.repo, new Date(t - 3600_000).toISOString(), new Date(t + 600_000).toISOString())
          .first<any>()
      : null;
    checks.push({ ok: !!mint, label: mint ? `githug minted a 1-hour key for ${agentId} on this repo at ${String(mint.issued).slice(0, 16).replace("T", " ")} UTC` : "No githug key minted for this agent within the hour before the commit" });
    if (run) checks.push({ ok: !!mint && (!mint.run || mint.run === run), label: `Run ${run}${mint?.run && mint.run !== run ? ` (key was minted for run ${mint.run})` : ""}` });
  }
  const verdict: Verdict = !agent ? "not_githug" : checks.every((x) => x.ok) ? "verified" : checks.every((x) => x.ok || x.label.startsWith("Not attested")) ? "consistent" : "partial";
  return { kind: "commit", verdict, attested: !!att, agent: agentId, accountable: agent?.accountable ?? accountableTrailer, checks, ...base };
}

/**
 * Cron: re-checks that each top-level agent's accountable human can still push to its repos
 * (scope is checked at creation; access changes after). Disables an agent (and its
 * sub-agents) only on a definitive answer: GitHub lists the repo for that human without push.
 * No grant, an API error, or a repo GitHub doesn't list leaves the agent alone and is logged.
 */
export async function recheckAgentScopes(env: GatewayEnv): Promise<{ checked: number; disabled: string[] }> {
  const rows = (await env.DB.prepare("SELECT * FROM gateway_agents WHERE disabled = 0 AND parent IS NULL AND account_id IS NOT NULL").all<any>()).results ?? [];
  const disabled: string[] = [];
  const seen = new Map<string, Map<string, boolean> | null>(); // actor → repo → canPush
  for (const agent of rows.map(rowToAgent)) {
    const actor: Actor = { login: agent.accountable, id: agent.accountable_id };
    const k = String(actor.id ?? actor.login);
    if (!seen.has(k)) {
      let access: Map<string, boolean> | null = null;
      try {
        const token = await getUserToken(env, actor);
        if (token) {
          access = new Map();
          const inst = await gh("/user/installations?per_page=100", token);
          for (const i of inst.installations ?? []) {
            const rs = await gh(`/user/installations/${i.id}/repositories?per_page=100`, token);
            for (const r of rs.repositories ?? []) access.set(String(r.full_name).toLowerCase(), canPush(r));
          }
        }
      } catch (e) {
        console.error(`recheckAgentScopes: ${actor.login}: ${(e as Error).message}`);
        access = null;
      }
      seen.set(k, access);
    }
    const access = seen.get(k);
    if (!access) continue;
    const lost = agent.repos.filter((r) => access.get(r.toLowerCase()) === false);
    const unseen = agent.repos.filter((r) => !access.has(r.toLowerCase()));
    if (unseen.length) console.log(`recheckAgentScopes: ${agent.id}: can't confirm ${unseen.join(", ")} for ${actor.login}`);
    if (lost.length) {
      await setAgentDisabled(env.DB, agent.id, true);
      disabled.push(agent.id);
      console.log(`recheckAgentScopes: disabled ${agent.id}: ${actor.login} can no longer push to ${lost.join(", ")}`);
    }
  }
  return { checked: rows.length, disabled };
}

/**
 * Strict verify (require: attested): GitHub's own view of a commit's author account and
 * signature, read with githug's installation token. Null when githug isn't installed on the
 * repo or GitHub can't be reached; callers then fall back to what the Action posted.
 */
export async function githubCommitIdentity(env: GatewayEnv, repo: string, sha: string): Promise<{ login: string | null; signed: boolean } | null> {
  try {
    const c = await gh(`/repos/${repo}/commits/${sha}`, await readToken(env, repo));
    return { login: c.author?.login ?? null, signed: !!c.commit?.verification?.verified };
  } catch {
    return null;
  }
}

/** Records commits an agent's key says it is pushing (hug's pre-push hook). Returns how many were new. */
export async function attestCommits(db: D1Database, agent: AgentRow, repo: string, shas: string[], run: string, ipHash: string): Promise<number> {
  const now = new Date().toISOString();
  const stmts = shas.map((sha) =>
    db.prepare("INSERT INTO gateway_commits (repo,sha,agent_id,run,attested,ip_hash) VALUES (?,?,?,?,?,?) ON CONFLICT(repo,sha,agent_id) DO NOTHING").bind(repo.toLowerCase(), sha, agent.id, run, now, ipHash),
  );
  if (!stmts.length) return 0;
  return (await db.batch(stmts)).reduce((n, r: any) => n + (r.meta?.changes ?? 0), 0);
}

// ---------------------------------------------------------------------------
// PR outcomes (M1.10), run from the cron. Per repo with an enabled agent: the 50 most
// recently updated PRs; new or still-open ones get their commits read to find the agent.
// ---------------------------------------------------------------------------
export async function syncPrOutcomes(env: GatewayEnv): Promise<number> {
  const AGENT_EMAIL_RE = agentEmailRe();
  const agents = await listAgents(env.DB);
  const byRepo = new Map<string, AgentRow[]>();
  for (const a of agents) if (!a.disabled) for (const r of a.repos) byRepo.set(r.toLowerCase(), [...(byRepo.get(r.toLowerCase()) ?? []), a]);
  let n = 0;
  for (const [repo, repoAgents] of byRepo) {
    try {
      const token = await readToken(env, repo);
      const known = new Map<number, string>();
      for (const r of (await env.DB.prepare("SELECT number, state FROM gateway_prs WHERE repo = ?").bind(repo).all<any>()).results ?? []) known.set(r.number, r.state);
      const prs = await gh(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=50`, token);
      const now = new Date().toISOString();
      const stmts: D1PreparedStatement[] = [];
      for (const pr of prs) {
        if (known.get(pr.number) === "closed") continue;
        let agentId: string | null = null;
        const commits = await gh(`/repos/${repo}/pulls/${pr.number}/commits?per_page=100`, token).catch(() => []);
        for (const cm of commits) {
          const attested = await env.DB.prepare("SELECT agent_id FROM gateway_commits WHERE repo = ? AND sha = ? LIMIT 1").bind(repo, String(cm.sha ?? "").toLowerCase()).first<any>();
          if (attested) {
            agentId = attested.agent_id;
            break;
          }
          const email = cm.commit?.author?.email ?? "";
          const name = (cm.commit?.author?.name ?? "").toLowerCase();
          const hit =
            AGENT_EMAIL_RE.exec(email)?.[1]?.toLowerCase() ??
            (await agentForBotEmail(env.DB, email)) ??
            (/\[bot\]@users\.noreply\.github\.com$/.test(email) ? repoAgents.find((a) => a.name.toLowerCase() === name)?.id : undefined);
          if (hit) {
            agentId = hit;
            break;
          }
        }
        if (!agentId) continue;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO gateway_prs (repo,number,agent_id,state,merged,opened,closed,synced) VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT(repo,number) DO UPDATE SET agent_id=excluded.agent_id, state=excluded.state, merged=excluded.merged, closed=excluded.closed, synced=excluded.synced`,
          ).bind(repo, pr.number, agentId, pr.state, pr.merged_at ? 1 : 0, pr.created_at, pr.merged_at ?? pr.closed_at ?? null, now),
        );
      }
      if (stmts.length) await env.DB.batch(stmts);
      n += stmts.length;
    } catch (e) {
      console.error(`syncPrOutcomes ${repo} failed:`, (e as Error).message);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// dashboard detail (M1.4): rotate keys, key log by run, CLI logins
// ---------------------------------------------------------------------------

/**
 * Replaces an account-owned agent's key; the old key stops working immediately. Sub-agents
 * have their own keys, and anyone holding the old key could have made some, so rotating
 * also disables every agent below this one (the owner re-enables the ones they trust).
 */
export async function rotateAgentKey(db: D1Database, id: string, accountId: string): Promise<{ key: string; disabledChildren: number } | null> {
  const key = newAgentKey();
  const r = await db.prepare("UPDATE gateway_agents SET key_hash = ? WHERE id = ? AND account_id = ?").bind(await sha256Hex(key), id, accountId).run();
  if ((r.meta?.changes ?? 0) === 0) return null;
  return { key, disabledChildren: await disableDescendants(db, id) };
}

export async function findAccountAgent(db: D1Database, id: string, accountId: string): Promise<AgentRow | null> {
  const r = await db.prepare("SELECT * FROM gateway_agents WHERE id = ? AND account_id = ?").bind(id, accountId).first<any>();
  return r ? rowToAgent(r) : null;
}

export interface RunLog {
  run: string;
  mints: number;
  repos: string;
  first: string;
  last: string;
}

/** The agent's key mints over the last 30 days, grouped by run (unlabelled mints group by day). */
export async function agentRuns(db: D1Database, id: string): Promise<RunLog[]> {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const rs = await db
    .prepare(
      `SELECT COALESCE(NULLIF(run,''), 'no run · ' || substr(issued,1,10)) run, COUNT(*) mints, group_concat(DISTINCT repo) repos, MIN(issued) first, MAX(issued) last
       FROM gateway_tokens WHERE agent_id = ? AND issued > ? GROUP BY 1 ORDER BY last DESC LIMIT 50`,
    )
    .bind(id, since)
    .all<any>();
  return (rs.results ?? []) as RunLog[];
}

export interface CliLogin {
  id: string; // first 12 hex of the key hash: enough to address it, useless as a credential
  name: string;
  created: string;
  last_used: string | null;
}

export async function listCliLogins(db: D1Database, accountId: string): Promise<CliLogin[]> {
  const rs = await db
    .prepare("SELECT substr(key_hash,1,12) id, name, created, last_used FROM account_keys WHERE account_id = ? AND disabled = 0 ORDER BY created DESC")
    .bind(accountId)
    .all<any>();
  return (rs.results ?? []) as CliLogin[];
}

export async function revokeCliLogin(db: D1Database, accountId: string, idPrefix: string): Promise<boolean> {
  if (!/^[0-9a-f]{12}$/.test(idPrefix)) return false;
  const r = await db.prepare("UPDATE account_keys SET disabled = 1 WHERE account_id = ? AND substr(key_hash,1,12) = ?").bind(accountId, idPrefix).run();
  return (r.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// PRs as the human (M2.5): the agent opens the PR, the accountable human is its author
// (contribution credit lands on their graph), and the footer names the agent and links the
// PR's verify page. Falls back to the App's installation token if the human hasn't a grant.
// ---------------------------------------------------------------------------
export function prFooter(repo: string, number: number | null, agent: AgentRow, run: string): string {
  const verify = number ? `[verify →](${SITE_ORIGIN}/v/${repo}/pull/${number})` : "";
  return `\n\n---\n<sub>🤝 Opened by agent **${agent.id}** for @${agent.accountable} via [${BRAND}](${SITE_ORIGIN})${run ? ` · run \`${run}\`` : ""}${verify ? ` · ${verify}` : ""}</sub>`;
}

export interface OpenedPr {
  number: number;
  url: string;
  opened_as: "human" | "agent";
  /** Set when the PR was opened with a token from the shared App because the agent's own App failed to mint. */
  fallback?: true;
  warning?: string;
}

export async function openPullRequest(
  env: GatewayEnv,
  agent: AgentRow,
  installationId: number,
  p: { repo: string; head: string; base: string; title: string; body: string; run: string; draft: boolean; as?: "human" | "agent"; labels?: string[] },
): Promise<OpenedPr> {
  // as=agent: the agent's bot is the author, so its human can still approve the PR when
  // branch protection requires a review (GitHub won't let authors approve their own).
  const userToken = p.as !== "agent" && agent.accountable ? await getUserToken(env, agent.accountable).catch(() => null) : null;
  const minted = userToken ? null : await mintForAgent(env, agent, p.repo, { pull_requests: "write", issues: "write", metadata: "read" });
  const token = userToken ?? minted!.token;
  const pr = await gh(`/repos/${p.repo}/pulls`, token, {
    method: "POST",
    body: JSON.stringify({ title: p.title, head: p.head, base: p.base, draft: p.draft, body: p.body + prFooter(p.repo, null, agent, p.run) }),
  });
  // Now that the number exists, point the footer at the PR's verify page.
  await gh(`/repos/${p.repo}/pulls/${pr.number}`, token, { method: "PATCH", body: JSON.stringify({ body: p.body + prFooter(p.repo, pr.number, agent, p.run) }) }).catch(() => null);
  if (p.labels?.length) await gh(`/repos/${p.repo}/issues/${pr.number}/labels`, token, { method: "POST", body: JSON.stringify({ labels: p.labels }) }).catch((e) => console.error("pr labels failed:", (e as Error).message));
  const openedAs = userToken ? "human" : "agent";
  await env.DB.prepare("INSERT INTO gateway_actions (repo,kind,ref,agent_id,chain,run,credential,created) VALUES (?,?,?,?,?,?,?,?)")
    .bind(p.repo, "pr_open", String(pr.number), agent.id, JSON.stringify([`user:${agent.accountable}`, `agent:${agent.id}`]), p.run, openedAs === "human" ? "user" : "installation", new Date().toISOString())
    .run();
  return {
    number: pr.number,
    url: pr.html_url,
    opened_as: openedAs,
    ...(minted?.fallback && { fallback: true as const, warning: `Minting through ${agent.id}'s own GitHub App failed; this PR was opened as the shared App.` }),
  };
}

export type VerifyPullResult =
  | { kind: "not_installed" | "private" | "not_found" }
  | {
      kind: "pull";
      repo: string;
      number: number;
      title: string;
      state: string;
      merged: boolean;
      verdict: Verdict;
      commits: { sha: string; title: string; agent: string | null; verdict: Verdict }[];
      agents: string[];
      accountable: string[];
    };

/** Verifies every commit on a public PR (first 20) with verifyCommit and sums it up. */
export async function verifyPull(env: GatewayEnv, repo: string, number: number): Promise<VerifyPullResult> {
  let token: string;
  try {
    token = await readToken(env, repo);
  } catch {
    return { kind: "not_installed" };
  }
  const pr = await gh(`/repos/${repo}/pulls/${number}`, token).catch(() => null);
  if (!pr?.number) return { kind: "not_found" };
  if (pr.base?.repo?.private) return { kind: "private" };
  const list = await gh(`/repos/${repo}/pulls/${number}/commits?per_page=20`, token);
  const commits = [];
  for (const cm of list) {
    const r = await verifyCommit(env, repo, cm.sha);
    if (r.kind === "commit") commits.push({ sha: r.sha, title: r.title, agent: r.agent, verdict: r.verdict, accountable: r.accountable });
  }
  const verdict: Verdict = commits.length && commits.every((x) => x.verdict === "verified")
    ? "verified"
    : commits.length && commits.every((x) => x.verdict === "verified" || x.verdict === "consistent")
      ? "consistent"
      : commits.some((x) => x.verdict !== "not_githug") ? "partial" : "not_githug";
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  return {
    kind: "pull",
    repo: pr.base.repo.full_name,
    number: pr.number,
    title: String(pr.title ?? "").slice(0, 200),
    state: pr.state,
    merged: !!pr.merged_at,
    verdict,
    commits: commits.map(({ accountable, ...c }) => c),
    agents: uniq(commits.map((c) => c.agent)),
    accountable: uniq(commits.map((c) => c.accountable)),
  };
}

// ---------------------------------------------------------------------------
// named identities (M2.1): one GitHub App per agent, from a githug-prefilled manifest
// ---------------------------------------------------------------------------
export interface AgentApp {
  agent_id: string;
  app_id: number;
  slug: string;
  owner_login: string;
  owner_type: string;
  pem: string; // decrypted PKCS#8
  bot_id: number | null;
  installation_id: number | null;
  /** The account the installation is on (null for rows from before migration 0016). */
  installation_login: string | null;
}

/** The manifest GitHub's "create App from manifest" page is POSTed (one click for the human). */
export function identityManifest(agent: AgentRow): object {
  return {
    // "<agent>-githug": rarely taken (App names can't match an existing account), and puts githug on every PR.
    name: `${agent.id.slice(0, 33 - brandSlug().length)}-${brandSlug()}`.slice(0, 34),
    url: SITE_ORIGIN,
    description: `Coding agent ${agent.id}. Accountable human: @${agent.accountable}. Identity and keys managed by ${BRAND} (${new URL(SITE_ORIGIN).host}).`,
    hook_attributes: { url: `${SITE_ORIGIN}/api/gateway/github/webhook`, active: false },
    redirect_url: `${SITE_ORIGIN}/app/identity/callback`,
    setup_url: `${SITE_ORIGIN}/app/identity/installed`,
    public: false,
    default_permissions: { contents: "write", pull_requests: "write", issues: "write", checks: "write", metadata: "read" },
    default_events: [],
  };
}

/** Exchanges the manifest code (valid 1h) for the new App's id, slug and private key, and stores it encrypted. */
export async function convertManifest(env: GatewayEnv, agentId: string, code: string): Promise<{ slug: string; owner_login: string; owner_type: string }> {
  const res = await fetch(`${GH}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", "User-Agent": UA, "X-GitHub-Api-Version": "2022-11-28" },
  });
  const app: any = await res.json().catch(() => ({}));
  if (!res.ok || !app.id || !app.pem) throw new Error(app.message || `manifest conversion ${res.status}`);
  const pem = pkcs1ToPkcs8Pem(app.pem);
  const bot = await fetch(`${GH}/users/${encodeURIComponent(app.slug)}%5Bbot%5D`, { headers: { Accept: "application/vnd.github+json", "User-Agent": UA } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  await env.DB.prepare(
    `INSERT INTO gateway_apps (agent_id,app_id,slug,owner_login,owner_type,private_key,bot_id,installation_id,created) VALUES (?,?,?,?,?,?,?,NULL,?)
     ON CONFLICT(agent_id) DO UPDATE SET app_id=excluded.app_id, slug=excluded.slug, owner_login=excluded.owner_login, owner_type=excluded.owner_type,
       private_key=excluded.private_key, bot_id=excluded.bot_id, installation_id=NULL, created=excluded.created`,
  )
    .bind(agentId, app.id, app.slug, app.owner?.login ?? null, app.owner?.type ?? null, await encryptSecret(env, pem), (bot as any)?.id ?? null, new Date().toISOString())
    .run();
  return { slug: app.slug, owner_login: app.owner?.login ?? "", owner_type: app.owner?.type ?? "" };
}

export async function getAgentApp(env: GatewayEnv, agentId: string): Promise<AgentApp | null> {
  const r = await env.DB.prepare("SELECT * FROM gateway_apps WHERE agent_id = ?").bind(agentId).first<any>();
  if (!r) return null;
  return { agent_id: r.agent_id, app_id: r.app_id, slug: r.slug, owner_login: r.owner_login ?? "", owner_type: r.owner_type ?? "", pem: await decryptSecret(env, r.private_key), bot_id: r.bot_id ?? null, installation_id: r.installation_id ?? null, installation_login: r.installation_login ?? null };
}

/** Records the install once GitHub confirms (with the agent App's own JWT) that this installation is its. */
export async function confirmAgentInstall(env: GatewayEnv, agentId: string, installationId: number): Promise<boolean> {
  const app = await getAgentApp(env, agentId);
  if (!app) return false;
  const inst = await gh(`/app/installations/${installationId}`, await appJwtFor(app.app_id, app.pem)).catch(() => null);
  if (!inst?.id) return false;
  await env.DB.prepare("UPDATE gateway_apps SET installation_id = ?, installation_login = ? WHERE agent_id = ?").bind(installationId, inst.account?.login ?? null, agentId).run();
  return true;
}

export interface AgentMint extends MintedToken {
  installation_id: number;
  /** The bot the token acts as: the agent's own <slug>[bot], or the shared App's. */
  bot: { login: string; email: string } | null;
  named: boolean;
  /** Set when the agent has its own App but the mint through it failed and the shared App minted instead. */
  fallback?: string;
}

/**
 * Mints for an agent: through its own App when it has one installed on the repo, else the
 * shared githug Gateway App (M2.1 fallback).
 */
export async function mintForAgent(env: GatewayEnv, agent: AgentRow, repo: string, permissions?: Record<string, string>): Promise<AgentMint> {
  const app = await getAgentApp(env, agent.id).catch(() => null);
  let fallback: string | undefined;
  if (app?.installation_id) {
    try {
      const jwt = await appJwtFor(app.app_id, app.pem);
      // A token names repos only by name, within the installation's account: refuse to mint
      // for owner/x through an installation on some other account that also has an x.
      let instLogin = app.installation_login;
      if (!instLogin) {
        instLogin = (await gh(`/app/installations/${app.installation_id}`, jwt).catch(() => null))?.account?.login ?? null;
        if (instLogin) await env.DB.prepare("UPDATE gateway_apps SET installation_login = ? WHERE agent_id = ?").bind(instLogin, agent.id).run();
      }
      if (instLogin && instLogin.toLowerCase() !== repo.split("/")[0].toLowerCase()) throw new Error(`installed on ${instLogin}, not ${repo.split("/")[0]}`);
      const [, name] = repo.split("/");
      const data = await gh(`/app/installations/${app.installation_id}/access_tokens`, jwt, {
        method: "POST",
        body: JSON.stringify({ repositories: [name], permissions: permissions ?? DEFAULT_TOKEN_PERMISSIONS }),
      });
      const bot = app.bot_id ? { login: `${app.slug}[bot]`, email: `${app.bot_id}+${app.slug}[bot]@users.noreply.github.com` } : null;
      return { token: data.token, expires_at: data.expires_at, permissions: data.permissions ?? {}, installation_id: app.installation_id, bot, named: true };
    } catch (e) {
      fallback = (e as Error)?.message || "mint failed"; // never empty, or the spread below would hide it
      console.error(`named mint for ${agent.id} failed, using shared App:`, fallback);
    }
  }
  const { minted, installationId } = await withInstallation(env, repo, async (installationId) => ({
    minted: await mintInstallationToken(env, installationId, repo, permissions ?? undefined),
    installationId,
  }));
  return { ...minted, installation_id: installationId, bot: await botIdentity(env, minted.token), named: false, ...(fallback && { fallback }) };
}

/** Agent id for a commit author email of a named agent App's bot (<id>+<slug>[bot]@…). */
export async function agentForBotEmail(db: D1Database, email: string): Promise<string | null> {
  const m = /^\d+\+([a-z0-9-]+)\[bot\]@users\.noreply\.github\.com$/i.exec(email);
  if (!m) return null;
  const r = await db.prepare("SELECT agent_id FROM gateway_apps WHERE lower(slug) = lower(?)").bind(m[1]).first<any>();
  return r?.agent_id ?? null;
}

// ---------------------------------------------------------------------------
// shadow billing (M3.1): what an account would pay on the planned pricing, computed from
// the key log. Nothing is charged during the beta.
//   Billable grant = a top-level agent × a PRIVATE repo it minted a key for this calendar
//   month (sub-agents bill under their root; public repos and idle agents are free).
//   Price = the cheaper of Solo ($5 incl. 5 grants) and Team ($25 incl. 25), then $1/grant.
// ---------------------------------------------------------------------------
export const PLANS = { solo: { floor: 5, included: 5 }, team: { floor: 25, included: 25 }, perGrant: 1 };

export interface UsageGrant {
  agent: string; // the top-level agent the grant bills to
  repo: string;
  private: boolean | null; // null: githug can't see the repo any more
  mints: number;
}

export interface MonthUsage {
  month: string; // YYYY-MM
  grants: UsageGrant[];
  billable: number;
  solo: number;
  team: number;
  /** Cheapest plan for this usage, or null when nothing is billable (public repos only). */
  plan: "solo" | "team" | null;
  cost: number;
}

export function priceFor(billable: number): { solo: number; team: number; plan: "solo" | "team" | null; cost: number } {
  const solo = PLANS.solo.floor + Math.max(0, billable - PLANS.solo.included) * PLANS.perGrant;
  const team = PLANS.team.floor + Math.max(0, billable - PLANS.team.included) * PLANS.perGrant;
  if (billable === 0) return { solo, team, plan: null, cost: 0 };
  return team < solo ? { solo, team, plan: "team", cost: team } : { solo, team, plan: "solo", cost: solo };
}

export async function monthUsage(env: GatewayEnv, account: Account, now = new Date()): Promise<MonthUsage> {
  const month = now.toISOString().slice(0, 7);
  const rs = await env.DB.prepare(
    `WITH RECURSIVE up(id, root) AS (
       SELECT id, id FROM gateway_agents WHERE account_id = ?1 AND parent IS NULL
       UNION SELECT a.id, up.root FROM gateway_agents a JOIN up ON a.parent = up.id)
     SELECT up.root agent, lower(t.repo) repo, COUNT(*) mints
     FROM gateway_tokens t JOIN up ON up.id = t.agent_id
     WHERE t.issued >= ?2 GROUP BY up.root, lower(t.repo) ORDER BY mints DESC`,
  )
    .bind(account.id, `${month}-01`)
    .all<any>();
  let visibility = new Map<string, boolean>();
  try {
    visibility = new Map((await accountRepos(env, account)).map((r) => [r.repo.toLowerCase(), r.private]));
  } catch (e) {
    console.error("monthUsage: repo visibility unavailable:", (e as Error).message);
  }
  const grants: UsageGrant[] = (rs.results ?? []).map((r: any) => ({ agent: r.agent, repo: r.repo, private: visibility.has(r.repo) ? visibility.get(r.repo)! : null, mints: r.mints }));
  const billable = grants.filter((g) => g.private === true).length;
  return { month, grants, billable, ...priceFor(billable) };
}

// ---------------------------------------------------------------------------
// org accounts (M3.7)
// ---------------------------------------------------------------------------
export interface OrgChoice {
  id: string; // 'gh:<org id>'
  login: string;
  github_id: number;
}

/**
 * Orgs this human may act for (cached 5 min): org installations of the App in which they can
 * push to at least one repo. Read access alone (outside collaborators, read-only members)
 * doesn't make someone the org's operator.
 */
export async function orgsFor(env: GatewayEnv, who: string | Actor): Promise<OrgChoice[]> {
  const human = typeof who === "string" ? { login: who } : who;
  const key = `gw:orgs2:${human.id ?? human.login.toLowerCase()}`;
  const hit = await env.CACHE.get(key);
  if (hit) return JSON.parse(hit);
  const token = await getUserToken(env, human);
  if (!token) return [];
  const inst = await gh("/user/installations?per_page=100", token);
  const orgs: OrgChoice[] = [];
  for (const i of inst.installations ?? []) {
    if (i.account?.type !== "Organization") continue;
    if (!(await pushableRepos(i.id, token)).length) continue;
    orgs.push({ id: `gh:${i.account.id}`, login: i.account.login, github_id: i.account.id });
  }
  await env.CACHE.put(key, JSON.stringify(orgs), { expirationTtl: 300 });
  return orgs;
}

/** Points a session at an org account (creating it on first use) or back at the human's own (null). */
export async function setActingAccount(env: GatewayEnv, human: Actor, rawSession: string, orgId: string | null): Promise<boolean> {
  if (orgId) {
    const org = (await orgsFor(env, human)).find((o) => o.id === orgId);
    if (!org) return false;
    await env.DB.prepare(
      `INSERT INTO accounts (id,login,github_id,plan,created_via,created,kind) VALUES (?,?,?,'free','human',?,'org')
       ON CONFLICT(id) DO UPDATE SET login=excluded.login, kind='org'`,
    )
      .bind(org.id, org.login, org.github_id, new Date().toISOString())
      .run();
  }
  await env.DB.prepare("UPDATE sessions SET acting_account_id = ? WHERE id_hash = ?").bind(orgId, await sha256Hex(rawSession)).run();
  return true;
}

/** The org account a session acts for, re-checked against the human's current GitHub access. */
export async function actingOrg(env: GatewayEnv, human: Actor, orgId: string): Promise<Account | null> {
  const org = (await orgsFor(env, human).catch(() => [])).find((o) => o.id === orgId);
  if (!org) return null;
  const r = await env.DB.prepare("SELECT id, login, plan FROM accounts WHERE id = ? AND kind = 'org'").bind(orgId).first<any>();
  return r ? { id: r.id, login: r.login, plan: r.plan, kind: "org", actor: human.login, actorId: human.id ?? null } : null;
}

/** Turns graph credit (Co-authored-by for the accountable human) on or off for an account's agent. */
export async function setAgentCredit(db: D1Database, id: string, on: boolean, accountId: string): Promise<boolean> {
  const r = await db.prepare("UPDATE gateway_agents SET credit_human = ? WHERE id = ? AND account_id = ?").bind(on ? 1 : 0, id, accountId).run();
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * Adds repos to an account's agent, keeping the ones it has (case-insensitive). The write is
 * conditional on the list it read, so two concurrent adds can't drop each other's repos.
 * Returns the new list, or null if the account has no such agent.
 */
export async function addAgentRepos(db: D1Database, id: string, repos: string[], accountId: string): Promise<string[] | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await db.prepare("SELECT repos FROM gateway_agents WHERE id = ? AND account_id = ?").bind(id, accountId).first<any>();
    if (!r) return null;
    const have: string[] = r.repos ? JSON.parse(r.repos) : [];
    const seen = new Set(have.map((x) => x.toLowerCase()));
    const next = [...have];
    for (const x of repos) if (!seen.has(x.toLowerCase())) (seen.add(x.toLowerCase()), next.push(x));
    if (next.length === have.length) return have;
    const u = await db.prepare("UPDATE gateway_agents SET repos = ? WHERE id = ? AND account_id = ? AND repos IS ?").bind(JSON.stringify(next), id, accountId, r.repos).run();
    if ((u.meta?.changes ?? 0) > 0) return next;
  }
  throw new Error("agent repos changed concurrently");
}

/**
 * Lets an account's agent change GitHub Actions workflows (or stops it). Turning it off also
 * removes it from every sub-agent below, so a child never keeps more than its parent has.
 */
export async function setAgentWorkflows(db: D1Database, id: string, on: boolean, accountId: string): Promise<boolean> {
  const r = await db.prepare("SELECT * FROM gateway_agents WHERE id = ? AND account_id = ?").bind(id, accountId).first<any>();
  if (!r) return false;
  const agent = rowToAgent(r);
  const base = { ...(agent.permissions ?? DEFAULT_TOKEN_PERMISSIONS) };
  if (on) base.workflows = "write";
  else delete base.workflows;
  const stmts: D1PreparedStatement[] = [db.prepare("UPDATE gateway_agents SET permissions = ? WHERE id = ?").bind(JSON.stringify(base), id)];
  if (!on) {
    const kids = await db
      .prepare(`WITH RECURSIVE tree(id) AS (SELECT id FROM gateway_agents WHERE parent = ?1 UNION SELECT a.id FROM gateway_agents a JOIN tree t ON a.parent = t.id) SELECT g.* FROM gateway_agents g JOIN tree USING (id)`)
      .bind(id)
      .all<any>();
    for (const k of kids.results ?? []) {
      const child = rowToAgent(k);
      if (!child.permissions?.workflows) continue;
      const p = { ...child.permissions };
      delete p.workflows;
      stmts.push(db.prepare("UPDATE gateway_agents SET permissions = ? WHERE id = ?").bind(JSON.stringify(p), child.id));
    }
  }
  await db.batch(stmts);
  return true;
}
