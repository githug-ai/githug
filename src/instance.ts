/**
 * Self-hosting (docs/SELF_HOSTING.md): settings saved in-app by the setup page, and the
 * single-tenant signup list (allowlist + first-run admin). On githug.ai (hosted mode) none of
 * this applies and none of it is queried: all GitHub App values come from secrets.
 */
import { encryptSecret, decryptSecret, getUserToken, type GatewayEnv } from "./gateway-api.js";
import { SELF_HOSTED } from "./site.js";

/** Env keys the setup page can save to D1 (secret ones encrypted). */
const SETTING_KEYS: Record<string, boolean> = {
  GITHUB_APP_ID: false,
  GITHUB_APP_SLUG: false,
  GITHUB_OAUTH_CLIENT_ID: false,
  GITHUB_APP_PRIVATE_KEY: true,
  GITHUB_OAUTH_CLIENT_SECRET: true,
};

let cache: { at: number; values: Record<string, string> } | null = null;

/**
 * The env with saved settings filled in where the env has none (env wins). Only reads D1
 * when an App value is missing, so a fully configured deployment pays nothing.
 */
export async function withSettings<E extends GatewayEnv>(env: E): Promise<E> {
  const e = env as any;
  if (!e.DB || Object.keys(SETTING_KEYS).every((k) => e[k])) return env;
  if (!cache || Date.now() - cache.at > 60_000) {
    const values: Record<string, string> = {};
    try {
      const rows = (await e.DB.prepare("SELECT key, value, secret FROM instance_settings").all()).results ?? [];
      for (const r of rows as any[]) {
        try {
          values[r.key] = r.secret ? await decryptSecret(env, r.value) : r.value;
        } catch (err) {
          console.error(`instance setting ${r.key} unreadable (GATEWAY_ENC_KEY changed?):`, (err as Error).message);
        }
      }
    } catch {
      // table missing (migrations not applied yet): run on env alone
    }
    cache = { at: Date.now(), values };
  }
  const merged: any = Object.create(Object.getPrototypeOf(env));
  for (const k of Object.keys(env)) merged[k] = e[k];
  for (const [k, v] of Object.entries(cache.values)) if (!merged[k]) merged[k] = v;
  return merged;
}

export async function saveSettings(env: GatewayEnv, values: Record<string, string>): Promise<void> {
  const now = new Date().toISOString();
  for (const [k, v] of Object.entries(values)) {
    if (!(k in SETTING_KEYS) || !v) continue;
    const secret = SETTING_KEYS[k];
    await env.DB.prepare("INSERT INTO instance_settings (key,value,secret,updated) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, secret=excluded.secret, updated=excluded.updated")
      .bind(k, secret ? await encryptSecret(env, v) : String(v), secret ? 1 : 0, now)
      .run();
  }
  cache = null;
}

export interface InstanceUser {
  login: string;
  github_id: number | null;
  role: "admin" | "member";
  added_by: string | null;
  created: string;
}

export async function instanceUsers(env: GatewayEnv): Promise<InstanceUser[]> {
  return ((await env.DB.prepare("SELECT login, github_id, role, added_by, created FROM instance_users ORDER BY role, login").all<any>()).results ?? []) as InstanceUser[];
}

export async function addInstanceUser(env: GatewayEnv, login: string, role: "admin" | "member", addedBy: string, githubId: number | null = null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO instance_users (login,github_id,role,added_by,created) VALUES (?,?,?,?,?)
     ON CONFLICT(login) DO UPDATE SET github_id=COALESCE(excluded.github_id, instance_users.github_id), role=CASE WHEN instance_users.role='admin' THEN 'admin' ELSE excluded.role END`,
  )
    .bind(login.toLowerCase(), githubId, role, addedBy, new Date().toISOString())
    .run();
}

export async function removeInstanceUser(env: GatewayEnv, login: string): Promise<void> {
  await env.DB.prepare("DELETE FROM instance_users WHERE login = ? AND role <> 'admin'").bind(login.toLowerCase()).run();
}

export async function isInstanceAdmin(env: GatewayEnv, login: string, githubId?: number | null): Promise<boolean> {
  if (!SELF_HOSTED) return false;
  const r = await env.DB.prepare("SELECT github_id FROM instance_users WHERE login = ? AND role = 'admin'").bind(login.toLowerCase()).first<any>();
  return !!r && (!r.github_id || !githubId || r.github_id === githubId);
}

/**
 * Who may sign in to a self-hosted instance (githug.ai: anyone). In order:
 *  1. on the instance's list (and, when it was recorded, the same GitHub id: a login
 *     re-claimed after a rename doesn't inherit someone's place);
 *  2. the first-run admin: GITHUG_ADMIN, or else whoever created the instance's App
 *     (recorded by the setup page); joins as admin on first sign-in;
 *  3. GITHUG_ALLOW: a listed login, or push access to a repo in one of this App's
 *     installations on a listed account (an org) — joins as member.
 */
export async function mayJoin(env: GatewayEnv & { GITHUG_ALLOW?: string; GITHUG_ADMIN?: string }, user: { login: string; id: number }): Promise<boolean> {
  if (!SELF_HOSTED) return true;
  const login = user.login.toLowerCase();
  const listed = await env.DB.prepare("SELECT github_id, role FROM instance_users WHERE login = ?").bind(login).first<any>();
  if (listed) {
    if (listed.github_id && listed.github_id !== user.id) return false;
    if (!listed.github_id) await env.DB.prepare("UPDATE instance_users SET github_id = ? WHERE login = ?").bind(user.id, login).run();
    return true;
  }
  const admin = (env.GITHUG_ADMIN ?? "").trim().toLowerCase();
  if (admin && admin === login) {
    await addInstanceUser(env, login, "admin", "GITHUG_ADMIN", user.id);
    return true;
  }
  const allow = (env.GITHUG_ALLOW ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.includes(login)) {
    await addInstanceUser(env, login, "member", "GITHUG_ALLOW", user.id);
    return true;
  }
  if (allow.length) {
    const token = await getUserToken(env, { login: user.login, id: user.id });
    if (token && (await pushesInAllowedAccount(token, allow))) {
      await addInstanceUser(env, login, "member", "GITHUG_ALLOW", user.id);
      return true;
    }
  }
  return false;
}

async function pushesInAllowedAccount(token: string, allow: string[]): Promise<boolean> {
  const h = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "githug-selfhost" };
  const inst: any = await fetch("https://api.github.com/user/installations?per_page=100", { headers: h }).then((r) => (r.ok ? r.json() : {}));
  for (const i of inst.installations ?? []) {
    if (!allow.includes(String(i.account?.login ?? "").toLowerCase())) continue;
    const rs: any = await fetch(`https://api.github.com/user/installations/${i.id}/repositories?per_page=100`, { headers: h }).then((r) => (r.ok ? r.json() : {}));
    if ((rs.repositories ?? []).some((r: any) => r.permissions?.push || r.permissions?.maintain || r.permissions?.admin)) return true;
  }
  return false;
}
