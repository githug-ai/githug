/**
 * The githug service: every product route (sign-in, dashboard, agent API, token minting,
 * verify, docs, CLI distribution, self-host admin) as one Hono app, plus the cron work.
 * src/worker.ts serves it on its own (self-hosted, public repo); githug.ai wraps it with
 * its own pages, which reach in through `hooks` (page-view analytics) and fall through
 * to `app` for everything else.
 */
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { escapeHtml } from "./render.js";
import { page, UI_CSS } from "./layout.js";
import {
  appManifest,
  manifestFormPage,
  installationForRepo,
  mintInstallationToken,
  botIdentity,
  createAgent,
  findAgentByKey,
  listAgents,
  setAgentDisabled,
  logToken,
  tokenStats,
  validRepo,
  findGatewayUser,
  upsertGatewayUser,
  exchangeOAuthCode,
  fetchGithubUser,
  createOAuthState,
  consumeOAuthState,
  safeNextPath,
  upsertAccount,
  createSession,
  sessionAccount,
  deleteSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  accountRepos,
  installUrl,
  createAccountKey,
  accountByKey,
  startDeviceFlow,
  pollDeviceFlow,
  verifyCommit,
  syncPrOutcomes,
  rotateAgentKey,
  setAgentCredit,
  addAgentRepos,
  setAgentWorkflows,
  findAccountAgent,
  agentRuns,
  listCliLogins,
  revokeCliLogin,
  monthUsage,
  orgsFor,
  setActingAccount,
  actingOrg,
  mintForAgent,
  identityManifest,
  convertManifest,
  convertAppManifest,
  getAgentApp,
  confirmAgentInstall,
  openPullRequest,
  verifyPull,
  verifyCommitData,
  createChildAgent,
  agentChain,
  accountActor,
  attestCommits,
  recheckAgentScopes,
  githubCommitIdentity,
  hashIp,
  type Account,
  type AgentRow,
} from "./gateway-api.js";
import { appPage, agentPage } from "./app.js";
import { verifyIndexPage, verifyPage, verifyPullPage } from "./verify.js";
import { installScript } from "./install.js";
import { DOCS, docsPage, docSource } from "./docs.js";
import { configureSite, SITE_ORIGIN, BILLING, SELF_HOSTED, BRAND } from "./site.js";
import { withSettings, saveSettings, mayJoin, isInstanceAdmin, instanceUsers, addInstanceUser, removeInstanceUser } from "./instance.js";

interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ASSETS: Fetcher;
  CACHE: KVNamespace;
  RELEASES: R2Bucket;
  DB: D1Database;
  WRITE_LIMITER: RateLimit;
  VERIFY_LIMITER: RateLimit;
  STATS_USER?: string;
  STATS_PASSWORD?: string;
  ADMIN_TOKEN?: string; // Bearer token for the admin API (agent CRUD across accounts, sync)
  // The GitHub App the gateway mints tokens from (or saved by the setup page, src/instance.ts).
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string; // PKCS#8 PEM
  GITHUB_APP_SLUG?: string;
  // Humans as principals via the App's user-to-server OAuth; GATEWAY_ENC_KEY encrypts grants at rest.
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  GATEWAY_ENC_KEY?: string; // base64-encoded 32 bytes
  // Instance (src/site.ts, docs/SELF_HOSTING.md)
  GITHUG_ORIGIN?: string;
  GITHUG_AGENT_DOMAIN?: string;
  GITHUG_BRAND?: string;
  GITHUG_MODE?: string;
  GITHUG_ALLOW?: string;
  GITHUG_ADMIN?: string;
  GITHUG_DL_ORIGIN?: string; // where /install fetches hug binaries; default: this origin on githug.ai, else https://githug.ai
}

/**
 * Extension points for a deployment that wraps this app (githug.ai does). Core never needs
 * them: unset, they do nothing, and a self-hosted instance keeps no analytics.
 */
export const hooks: {
  /** Called (in waitUntil) on views of public pages: docs, verify pages, installer and downloads. */
  pageView?: (env: any, id: string, req: Request) => Promise<void>;
} = {};

function track(c: any, id: string): void {
  if (hooks.pageView) c.executionCtx.waitUntil(hooks.pageView(c.env, id, c.req.raw));
}

export const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  configureSite(c.env, new URL(c.req.url).origin);
  await next();
  if (SELF_HOSTED) c.header("X-Robots-Tag", "noindex");
});

// Wrong Basic passwords are rate-limited per IP: the setup password is the guessable credential.
app.use("/gateway/setup/github-app", async (c, next) => {
  if ((c.req.header("authorization") ?? "").startsWith("Basic ") && !statsAuthed(c)) {
    if (!(await c.env.WRITE_LIMITER.limit({ key: `statsfail:${c.req.header("cf-connecting-ip") ?? "unknown"}` })).success) return c.text("Too many attempts. Try again in a minute.", 429);
  }
  await next();
});

// The product is the dashboard; githug.ai puts its own landing page in front.
app.get("/", (c) => c.redirect("/app", 302));
app.get("/gateway", (c) => c.redirect("/", 301));

// --- githug Gateway v0: agents as principals (src/gateway-api.ts) ---
// One-time app registration (admin): renders the manifest form; GitHub redirects back
// to the callback with a one-time code, which we print for the conversion step.
app.get("/gateway/setup/github-app", (c) => {
  if (!statsAuthed(c)) {
    c.header("WWW-Authenticate", 'Basic realm="githug stats"');
    return c.text("Authentication required.", 401);
  }
  // App names are unique across GitHub: a self-host names its own (?name=, default "<brand> <host>").
  const name = c.req.query("name") || (SELF_HOSTED ? `${BRAND} ${new URL(SITE_ORIGIN).host}` : "githug Gateway");
  return c.html(manifestFormPage(appManifest(SITE_ORIGIN, name), c.req.query("org") || undefined));
});
app.get("/gateway/setup/github-app/callback", async (c) => {
  const code = c.req.query("code") ?? "";
  if (!/^[A-Za-z0-9_-]{6,120}$/.test(code)) return c.text("Missing code.", 400);
  // Not logged: the code can be redeemed for the new App's private key for about an hour.
  c.header("Cache-Control", "no-store");
  // A new instance (no App yet): convert the code and save the App here, so there's no
  // secret-copying step. Needs the setup login (the browser resends it) and GATEWAY_ENC_KEY.
  if (!c.env.GITHUB_APP_ID || SELF_HOSTED) {
    if (!statsAuthed(c)) {
      c.header("WWW-Authenticate", 'Basic realm="githug stats"');
      return c.text("Authentication required.", 401);
    }
    if (!c.env.GATEWAY_ENC_KEY) return c.text("Set GATEWAY_ENC_KEY first (openssl rand -base64 32), then create the App again.", 503);
    try {
      const a = await convertAppManifest(code);
      await saveSettings(c.env, {
        GITHUB_APP_ID: String(a.id),
        GITHUB_APP_SLUG: a.slug,
        GITHUB_APP_PRIVATE_KEY: a.pem,
        GITHUB_OAUTH_CLIENT_ID: a.client_id,
        GITHUB_OAUTH_CLIENT_SECRET: a.client_secret,
      });
      // First-run admin: GITHUG_ADMIN if set, else whoever created the App (a user, not an org).
      const admin = c.env.GITHUG_ADMIN || (a.owner.type === "User" ? a.owner.login : "");
      if (SELF_HOSTED && admin) await addInstanceUser(c.env, admin, "admin", "setup");
      const settings = a.owner.type === "Organization" ? `https://github.com/organizations/${a.owner.login}/settings/apps/${a.slug}` : `https://github.com/settings/apps/${a.slug}`;
      return c.html(
        page({
          title: `${BRAND} · App created`,
          noindex: true,
          css: UI_CSS,
          body: `<main class="wrap">
<h1>App created: ${escapeHtml(a.slug)}</h1>
<p>Saved to this instance (encrypted). Two more steps:</p>
<ol><li>In <a href="${escapeHtml(settings)}">the App's settings</a>, tick <b>Enable Device Flow</b> (for <code>hug login</code>) and save.</li>
<li><a href="/login?next=/app">Sign in</a>${admin ? ` as <b>${escapeHtml(admin)}</b> (the instance admin)` : ""}, then install the App on your repos from the dashboard.</li></ol>

</main>`,
        }),
      );
    } catch (e) {
      console.error("app manifest conversion failed:", (e as Error).message);
      return c.text("GitHub didn't hand over the new App (codes expire after an hour). Create it again.", 502);
    }
  }
  return c.text(`App created. One-time conversion code (valid ~1h):\n\n${code}\n\nRun: curl -sX POST https://api.github.com/app-manifests/${code}/conversions`);
});

// M1.1 login (ROADMAP Track B). A GitHub user-to-server OAuth dance — /login redirects to
// GitHub, /callback exchanges the code, stores the grant (encrypted) in gateway_users,
// upserts the account and starts a session. /gateway/connect is the B1.2 v1 name for it.
app.get("/gateway/connect", (c) => c.redirect("/login", 302));
app.get("/login", async (c) => {
  if (!(await c.env.WRITE_LIMITER.limit({ key: `login:${c.req.header("cf-connecting-ip") ?? "unknown"}` })).success)
    return c.text("Too many requests. Try again in a minute.", 429);
  if (!c.env.GITHUB_OAUTH_CLIENT_ID) return c.text("gateway not configured: GITHUB_OAUTH_CLIENT_ID", 503);
  const next = safeNextPath(c.req.query("next"));
  if (await sessionAccount(c.env.DB, getCookie(c, SESSION_COOKIE))) return c.redirect(next, 302);
  const state = await createOAuthState(c.env.CACHE, next);
  // Binds the GitHub round-trip to this browser (login CSRF): the callback needs this cookie.
  setCookie(c, OAUTH_STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: "Lax", path: "/gateway/oauth/callback", maxAge: 600 });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", c.env.GITHUB_OAUTH_CLIENT_ID);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", `${SITE_ORIGIN}/gateway/oauth/callback`);
  return c.redirect(url.toString(), 302);
});

app.get("/gateway/oauth/callback", async (c) => {
  if (!(await c.env.WRITE_LIMITER.limit({ key: `login:${c.req.header("cf-connecting-ip") ?? "unknown"}` })).success)
    return c.text("Too many requests. Try again in a minute.", 429);
  if (!c.env.GATEWAY_ENC_KEY) return c.text("gateway not configured: GATEWAY_ENC_KEY", 503);
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  // /login sets the state cookie; installs started at /app/install carry state in KV only
  // (GitHub's install page may send the human back in a fresh browser context), so those
  // states are marked install-only and can't sign anyone in to someone else's account.
  const bound = !!state && getCookie(c, OAUTH_STATE_COOKIE) === state;
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/gateway/oauth/callback", secure: true });
  const next = state ? await consumeOAuthState(c.env.CACHE, state) : null;
  // Installed straight from GitHub's App page (no state of ours): sign in, then land on /app.
  if (!next && c.req.query("installation_id")) return c.redirect("/login?next=/app?installed=1", 302);
  if (!next) return c.text("Invalid or expired state.", 400);
  if (!bound) return c.redirect(`/login?next=${encodeURIComponent(safeNextPath(next))}`, 302);
  if (!code) return c.text("Missing code.", 400);
  try {
    const tok = await exchangeOAuthCode(c.env, code, `${SITE_ORIGIN}/gateway/oauth/callback`);
    const user = await fetchGithubUser(tok.access_token);
    if (SELF_HOSTED && !(await c.env.DB.prepare("SELECT 1 FROM instance_users WHERE login = ?").bind(user.login.toLowerCase()).first()) && !(c.env.GITHUG_ADMIN ?? "").trim() && !(c.env.GITHUG_ALLOW ?? "").trim()) {
      return c.text("This githug instance has no admin yet: create its GitHub App at /gateway/setup/github-app first.", 403);
    }
    await upsertGatewayUser(c.env, {
      login: user.login,
      github_id: user.id,
      email: user.email,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? null,
      expires_in: tok.expires_in ?? null,
    });
    if (!(await mayJoin(c.env, user))) return c.text(`${user.login} isn't on this githug instance's list. Ask its admin to add you.`, 403);
    const accountId = await upsertAccount(c.env.DB, { login: user.login, github_id: user.id }, "human");
    const session = await createSession(c.env.DB, accountId, c.req.header("user-agent") ?? null);
    setCookie(c, SESSION_COOKIE, session, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL_SECONDS });
    return c.redirect(safeNextPath(next), 302);
  } catch (e) {
    console.error("oauth callback failed:", (e as Error).message);
    return c.text("Could not complete GitHub connection.", 502);
  }
});

const OAUTH_STATE_COOKIE = "githug_oauth_state";

app.get("/logout", async (c) => {
  await deleteSession(c.env.DB, getCookie(c, SESSION_COOKIE));
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.redirect("/", 302);
});

// Dashboard (M1.4). Agents are owned by the signed-in account (M1.2); the repos an agent
// may be put on come from the human's own view of the App's installations (M1.3).
// The account behind a request: a `hug` account key (Bearer hug_…) or the /app session
// cookie — which may be acting for a GitHub org (M3.7), re-checked against the human's
// current GitHub access on every request (cached 5 min). Lost access falls back to personal.
async function currentAccount(c: any): Promise<Account | null> {
  const auth = c.req.header("authorization") ?? "";
  if (auth.startsWith("Bearer hug_")) return accountByKey(c.env.DB, auth.slice(7).trim());
  const me = (await sessionAccount(c.env.DB, getCookie(c, SESSION_COOKIE))) as (Account & { acting?: string | null }) | null;
  if (!me?.acting || me.acting === me.id) return me;
  return (await actingOrg(c.env, accountActor(me), me.acting)) ?? me;
}

/**
 * Whether the account may manage this agent. Personal agents: their owner. Org agents: a
 * member acting for the org who can push to every repo the agent works on (orgsFor only
 * admits pushers; this also stops someone with push on one org repo managing agents on others).
 */
async function canManage(c: any, account: Account, agent: AgentRow): Promise<boolean> {
  if (agent.account_id !== account.id) return false;
  if (account.kind !== "org") return true;
  const mine = new Set((await accountRepos(c.env, account).catch(() => [])).map((r) => r.repo.toLowerCase()));
  return agent.repos.every((r) => mine.has(r.toLowerCase()));
}

/** The signed-in human behind the session, whatever account they're acting for. */
async function sessionHuman(c: any): Promise<Account | null> {
  return sessionAccount(c.env.DB, getCookie(c, SESSION_COOKIE));
}

/** Cookie-authenticated writes must come from our own pages (SameSite=Lax is the first line). */
function sameOrigin(c: any): boolean {
  const origin = c.req.header("origin");
  return !origin || origin === SITE_ORIGIN || origin === new URL(c.req.url).origin;
}

async function renderApp(c: any, account: Account, extra: { created?: { id: string; key: string }; error?: string; fresh?: boolean } = {}) {
  let repos: Awaited<ReturnType<typeof accountRepos>> = [];
  let error = extra.error;
  try {
    repos = await accountRepos(c.env, account, extra.fresh);
  } catch (e) {
    console.error("accountRepos failed:", (e as Error).message);
    error ??= "Could not load your repositories from GitHub. Log out and back in, then try again.";
  }
  c.header("Cache-Control", "private, no-store");
  const human = account.actor ?? account.login;
  const [agents, logins, usage, orgs, me] = await Promise.all([
    listAgents(c.env.DB, account.id),
    account.kind === "org" ? Promise.resolve([]) : listCliLogins(c.env.DB, account.id),
    BILLING ? monthUsage(c.env, account).catch((e) => (console.error("monthUsage failed:", (e as Error).message), null)) : Promise.resolve(null),
    orgsFor(c.env, accountActor(account)).catch(() => []),
    sessionHuman(c),
  ]);
  const accounts = [{ id: me?.id ?? account.id, login: human, kind: "user" as const }, ...orgs.map((o) => ({ id: o.id, login: o.login, kind: "org" as const }))];
  return c.html(appPage(account, agents, { repos, logins, usage, accounts, created: extra.created, error }));
}

app.get("/app", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/login?next=/app", 302);
  return renderApp(c, account, { fresh: c.req.query("installed") === "1" });
});

// Install (or add repos to) the App. OAuth-during-install brings the human back through
// /gateway/oauth/callback with this state, which lands them on /app?installed=1.
// Switch which account /app acts for: your own, or an org whose githug installation you can see.
app.post("/app/switch", async (c) => {
  const me = await sessionHuman(c);
  if (!me) return c.redirect("/login?next=/app", 302);
  if (!sameOrigin(c)) return c.text("Bad origin.", 403);
  const form = await c.req.parseBody();
  const target = String(form.account ?? "");
  const ok = await setActingAccount(c.env, accountActor(me), getCookie(c, SESSION_COOKIE)!, target && target !== me.id ? target : null);
  return c.redirect(ok ? "/app" : "/app?switch=denied", 303);
});

app.get("/app/install", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/login?next=/app/install", 302);
  return c.redirect(installUrl(c.env, await createOAuthState(c.env.CACHE, "/app?installed=1")), 302);
});

/** Why the account can't put an agent on these repos (not installed, or no push), or null if it can. */
async function reposNotAllowed(c: any, account: Account, repos: string[]): Promise<string | null> {
  const allowed = new Set((await accountRepos(c.env, account, true)).map((r) => r.repo.toLowerCase()));
  const missing = repos.filter((r) => !allowed.has(r.toLowerCase()));
  return missing.length ? `githug isn't installed on ${missing.join(", ")} for your account.` : null;
}

/** Creates an agent owned by the account, on repos the account's human can see in an installation. */
async function createAccountAgent(c: any, account: Account, id: string, repos: string[], creditHuman = false) {
  if (!AGENT_ID_RE.test(id)) return { error: "Agent names are lowercase letters, digits and dashes." };
  if (!repos.length || !repos.every(validRepo)) return { error: "Pick a repository." };
  const notAllowed = await reposNotAllowed(c, account, repos);
  if (notAllowed) return { error: notAllowed };
  try {
    // An org owns the agent; the human creating it is the one accountable for it.
    return await createAgent(c.env.DB, { id, name: id, repos, accountable: account.actor ?? account.login, accountable_id: account.actorId ?? null, account_id: account.id, credit_human: creditHuman });
  } catch (e) {
    const msg = (e as Error).message;
    return { error: /UNIQUE|constraint/i.test(msg) ? `The name '${id}' is taken. Try another.` : "Could not create the agent." };
  }
}

app.post("/app/agents", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/login?next=/app", 302);
  if (!sameOrigin(c)) return c.text("Bad origin.", 403);
  if (!(await c.env.WRITE_LIMITER.limit({ key: `app:${account.id}` })).success) return c.text("Too many requests. Try again in a minute.", 429);
  const form = await c.req.parseBody();
  const id = String(form.id ?? "").trim().toLowerCase();
  const res = await createAccountAgent(c, account, id, [String(form.repo ?? "")]);
  if ("error" in res) return renderApp(c, account, { error: res.error });
  return renderApp(c, account, { created: { id: res.agent.id, key: res.key } });
});

// Agent detail: key log by run, rotate, disable/enable.
app.get("/app/agents/:id", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect(`/login?next=/app/agents/${encodeURIComponent(c.req.param("id"))}`, 302);
  const agent = await findAccountAgent(c.env.DB, c.req.param("id").toLowerCase(), account.id);
  if (!agent || !(await canManage(c, account, agent))) return c.redirect("/app", 302);
  c.header("Cache-Control", "private, no-store");
  return c.html(agentPage(account, agent, { runs: await agentRuns(c.env.DB, agent.id), identity: await identityInfo(c, agent.id), identityFailed: c.req.query("identity") === "failed" }));
});

async function identityInfo(c: any, agentId: string) {
  const app = await getAgentApp(c.env, agentId).catch(() => null);
  if (!app) return null;
  const settings = app.owner_type === "Organization" ? `https://github.com/organizations/${app.owner_login}/settings/apps/${app.slug}` : `https://github.com/settings/apps/${app.slug}`;
  return { slug: app.slug, installed: !!app.installation_id, settingsUrl: settings, installUrl: `/app/agents/${encodeURIComponent(agentId)}/identity/install` };
}

// M2.1 named identity: click 1 creates the agent's own GitHub App from a githug manifest,
// click 2 installs it. State (KV, 1h) ties both GitHub round-trips to this agent + account.
async function identityState(c: any, v: { agent: string; account: string }): Promise<string> {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  const state = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  await c.env.CACHE.put(`gw:idstate:${state}`, JSON.stringify(v), { expirationTtl: 3600 });
  return state;
}
async function takeIdentityState(c: any, state: string | undefined): Promise<{ agent: string; account: string } | null> {
  if (!state || !/^[0-9a-f]{48}$/.test(state)) return null;
  const v = await c.env.CACHE.get(`gw:idstate:${state}`, "json");
  if (v) await c.env.CACHE.delete(`gw:idstate:${state}`);
  return v;
}

app.get("/app/agents/:id/identity", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect(`/login?next=/app/agents/${encodeURIComponent(c.req.param("id"))}`, 302);
  const agent = await findAccountAgent(c.env.DB, c.req.param("id").toLowerCase(), account.id);
  if (!agent || !(await canManage(c, account, agent))) return c.redirect("/app", 302);
  const owner = agent.repos[0]?.split("/")[0] ?? account.login;
  const state = await identityState(c, { agent: agent.id, account: account.id });
  const action = owner.toLowerCase() === (account.actor ?? account.login).toLowerCase()
    ? `https://github.com/settings/apps/new?state=${state}`
    : `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new?state=${state}`;
  const manifest = JSON.stringify(identityManifest(agent)).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  c.header("Cache-Control", "private, no-store");
  return c.html(
    page({
      title: `githug · creating ${agent.id}'s identity`,
      noindex: true,
      css: UI_CSS,
      body: `<main class="wrap">
<form id="m" method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${manifest}">
<p>Taking you to GitHub to create <b>${escapeHtml(agent.id)}</b>'s own identity. Keep the name (change it if GitHub says it's taken), then click <b>Create GitHub App</b>.</p>
<button class="btn go" type="submit">Continue to GitHub →</button></form>
<script>document.getElementById('m').submit()</script>
</main>`,
    }),
  );
});

// Resume an unfinished identity: install the agent's existing App (state round-trips to /installed).
app.get("/app/agents/:id/identity/install", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/login?next=/app", 302);
  const found = await findAccountAgent(c.env.DB, c.req.param("id").toLowerCase(), account.id);
  const agent = found && (await canManage(c, account, found)) ? found : null;
  const app = agent ? await getAgentApp(c.env, agent.id).catch(() => null) : null;
  if (!agent || !app) return c.redirect("/app", 302);
  return c.redirect(`https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new?state=${await identityState(c, { agent: agent.id, account: account.id })}`, 302);
});

app.get("/app/identity/callback", async (c) => {
  const account = await currentAccount(c);
  const st = await takeIdentityState(c, c.req.query("state"));
  const code = c.req.query("code") ?? "";
  if (!account || !st || st.account !== account.id || !/^[A-Za-z0-9_-]{6,120}$/.test(code)) return c.text("This link expired. Start again from your agent's page.", 400);
  try {
    const app = await convertManifest(c.env, st.agent, code);
    const next = await identityState(c, st);
    return c.redirect(`https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new?state=${next}`, 302);
  } catch (e) {
    console.error("manifest conversion failed:", (e as Error).message);
    return c.text("GitHub didn't hand over the new App. Start again from your agent's page.", 502);
  }
});

app.get("/app/identity/installed", async (c) => {
  const account = await currentAccount(c);
  const st = await takeIdentityState(c, c.req.query("state"));
  const installationId = Number(c.req.query("installation_id"));
  if (!account || !st || st.account !== account.id || !Number.isInteger(installationId)) return c.redirect("/app", 302);
  const ok = await confirmAgentInstall(c.env, st.agent, installationId).catch(() => false);
  return c.redirect(`/app/agents/${encodeURIComponent(st.agent)}${ok ? "" : "?identity=failed"}`, 302);
});

// Graph credit: whether this agent's commits add Co-authored-by for its accountable human.
app.post("/app/agents/:id/credit", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/login?next=/app", 302);
  if (!sameOrigin(c)) return c.text("Bad origin.", 403);
  const id = c.req.param("id").toLowerCase();
  const form = await c.req.parseBody();
  const owned = await findAccountAgent(c.env.DB, id, account.id);
  if (owned && (await canManage(c, account, owned))) await setAgentCredit(c.env.DB, id, form.on === "1", account.id);
  return c.redirect(`/app/agents/${encodeURIComponent(id)}`, 303);
});

// Workflows: let an agent change .github/workflows (needs the Workflows permission on its App).
// Workflow files run with the repo's secrets, so only a signed-in human in the dashboard can
// turn this on: a `hug` account key lives on the machine agents run on and isn't accepted.
app.post("/app/agents/:id/workflows", async (c) => {
  if ((c.req.header("authorization") ?? "").startsWith("Bearer hug_")) return c.text("Turn this on from the dashboard.", 403);
  const account = await currentAccount(c);
  if (!account) return c.redirect("/login?next=/app", 302);
  if (!sameOrigin(c)) return c.text("Bad origin.", 403);
  const id = c.req.param("id").toLowerCase();
  const form = await c.req.parseBody();
  const owned = await findAccountAgent(c.env.DB, id, account.id);
  if (owned && (await canManage(c, account, owned))) await setAgentWorkflows(c.env.DB, id, form.on === "1", account.id);
  return c.redirect(`/app/agents/${encodeURIComponent(id)}`, 303);
});

app.post("/v1/agents/:id/credit", async (c) => {
  const account = await currentAccount(c);
  if (!account || !sameOrigin(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}) as any);
  if (typeof body?.on !== "boolean") return c.json({ error: "on must be true or false" }, 400);
  const id = c.req.param("id").toLowerCase();
  const owned = await findAccountAgent(c.env.DB, id, account.id);
  const ok = owned && (await canManage(c, account, owned)) ? await setAgentCredit(c.env.DB, id, body.on, account.id) : false;
  if (!ok || !owned) return c.json({ error: "no such agent" }, 404);
  // The trailer needs the accountable human's email, which githug has once they've signed in.
  const human = body.on && owned.accountable ? await findGatewayUser(c.env.DB, { login: owned.accountable, id: owned.accountable_id }) : null;
  const trailer = !!human?.email;
  return c.json({ ok: true, credit_human: body.on, trailer, ...(body.on && !trailer ? { note: `${owned.accountable || "The accountable human"} hasn't signed in to githug, so commits can't carry Co-authored-by for them yet.` } : {}) });
});

// Puts an agent on more repos, on the same terms as creating one (the account's human can push
// to each, in an installation). Sub-agents keep the subset they were spawned with.
app.post("/v1/agents/:id/repos", async (c) => {
  const account = await currentAccount(c);
  if (!account || !sameOrigin(c)) return c.json({ error: "unauthorized" }, 401);
  if (!(await c.env.WRITE_LIMITER.limit({ key: `app:${account.id}` })).success) return c.json({ error: "rate limited" }, 429);
  const body = await c.req.json().catch(() => ({}) as any);
  const repos: unknown[] = Array.isArray(body?.repos) ? body.repos : [];
  if (!repos.length || !repos.every(validRepo)) return c.json({ error: "repos must be a non-empty list of owner/repo" }, 400);
  const id = c.req.param("id").toLowerCase();
  const owned = await findAccountAgent(c.env.DB, id, account.id);
  if (!owned || !(await canManage(c, account, owned))) return c.json({ error: "no such agent" }, 404);
  if (owned.parent) return c.json({ error: `'${id}' is a sub-agent; it works on a subset of its parent's repos. Add the repo to the top-level agent and spawn a new sub-agent.` }, 400);
  const notAllowed = await reposNotAllowed(c, account, repos as string[]);
  if (notAllowed) return c.json({ error: notAllowed }, 400);
  const had = new Set(owned.repos.map((r) => r.toLowerCase()));
  const updated = await addAgentRepos(c.env.DB, id, repos as string[], account.id);
  if (!updated) return c.json({ error: "no such agent" }, 404);
  return c.json({ ok: true, agent: id, repos: updated, added: updated.filter((r) => !had.has(r.toLowerCase())) });
});

app.post("/app/agents/:id/rotate", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/login?next=/app", 302);
  if (!sameOrigin(c)) return c.text("Bad origin.", 403);
  const id = c.req.param("id").toLowerCase();
  const owned = await findAccountAgent(c.env.DB, id, account.id);
  if (!owned || !(await canManage(c, account, owned))) return c.redirect("/app", 303);
  const rotated = await rotateAgentKey(c.env.DB, id, account.id);
  const agent = rotated ? await findAccountAgent(c.env.DB, id, account.id) : null;
  if (!rotated || !agent) return c.redirect("/app", 303);
  c.header("Cache-Control", "private, no-store");
  return c.html(agentPage(account, agent, { runs: await agentRuns(c.env.DB, id), rotatedKey: rotated.key, disabledChildren: rotated.disabledChildren, identity: await identityInfo(c, id) }));
});

// The CLI's twin of the rotate button (`hug agent rotate`): the new key comes back once, for
// hug to store; the old key stops working at once and its sub-agents are disabled.
app.post("/v1/agents/:id/rotate", async (c) => {
  const account = await currentAccount(c);
  if (!account || !sameOrigin(c)) return c.json({ error: "unauthorized" }, 401);
  if (!(await c.env.WRITE_LIMITER.limit({ key: `app:${account.id}` })).success) return c.json({ error: "rate limited" }, 429);
  const id = c.req.param("id").toLowerCase();
  const owned = await findAccountAgent(c.env.DB, id, account.id);
  if (!owned || !(await canManage(c, account, owned))) return c.json({ error: "no such agent" }, 404);
  const rotated = await rotateAgentKey(c.env.DB, id, account.id);
  if (!rotated) return c.json({ error: "no such agent" }, 404);
  c.header("Cache-Control", "private, no-store");
  return c.json({ ok: true, agent: id, key: rotated.key, disabled_children: rotated.disabledChildren, note: "Store this key now; it is not shown again." });
});

app.post("/app/logins/:id/revoke", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/login?next=/app", 302);
  if (!sameOrigin(c)) return c.text("Bad origin.", 403);
  await revokeCliLogin(c.env.DB, account.id, c.req.param("id"));
  return c.redirect("/app", 303);
});

app.post("/app/agents/:id/:action{disable|enable}", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.redirect("/login?next=/app", 302);
  if (!sameOrigin(c)) return c.text("Bad origin.", 403);
  const id = c.req.param("id").toLowerCase();
  const owned = await findAccountAgent(c.env.DB, id, account.id);
  if (owned && (await canManage(c, account, owned))) await setAgentDisabled(c.env.DB, id, c.req.param("action") === "disable", account.id);
  const fromDetail = (c.req.header("referer") ?? "").includes(`/app/agents/${id}`);
  return c.redirect(fromDetail ? `/app/agents/${encodeURIComponent(id)}` : "/app", 303);
});

const AGENT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// Create an agent; returns the bearer key exactly once. A signed-in account creates agents
// it owns, on repos it can see (same rules as /app); admin keeps the free-form path.
app.post("/v1/agents", async (c) => {
  if (!(await adminAuthed(c))) {
    const account = await currentAccount(c);
    if (!account || !sameOrigin(c)) return c.json({ error: "unauthorized" }, 401);
    if (!(await c.env.WRITE_LIMITER.limit({ key: `app:${account.id}` })).success) return c.json({ error: "rate limited" }, 429);
    const body = await c.req.json().catch(() => ({}) as any);
    const repos: unknown[] = Array.isArray(body?.repos) ? body.repos : [];
    const res = await createAccountAgent(c, account, String(body?.id ?? "").toLowerCase(), repos.map(String), body?.credit_human === true);
    if ("error" in res) return c.json({ error: res.error }, 400);
    return c.json({ agent: res.agent, key: res.key, note: "Store this key now; it is not shown again." });
  }
  const body = await c.req.json().catch(() => ({}) as any);
  const id = String(body?.id ?? "").toLowerCase();
  const name = String(body?.name ?? "").trim().slice(0, 80);
  const accountable = String(body?.accountable ?? "").trim().slice(0, 120);
  const repos: unknown[] = Array.isArray(body?.repos) ? body.repos : [];
  const permissions = body?.permissions && typeof body.permissions === "object" ? (body.permissions as Record<string, string>) : null;
  const email = body?.email ? String(body.email).trim().slice(0, 320) : undefined;
  if (!AGENT_ID_RE.test(id)) return c.json({ error: "id must be lowercase letters, digits, dashes" }, 400);
  if (!name) return c.json({ error: "name required" }, 400);
  if (!repos.length || !repos.every(validRepo)) return c.json({ error: "repos must be a non-empty list of owner/repo" }, 400);
  if (permissions && !Object.entries(permissions).every(([k, v]) => /^[a-z_]{1,40}$/.test(k) && (v === "read" || v === "write"))) return c.json({ error: "permissions must map name → read|write" }, 400);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: "email must be a valid address" }, 400);
  // The accountable human must be someone who signed in: their grant opens PRs as them.
  const human = accountable ? await c.env.DB.prepare("SELECT github_id FROM gateway_users WHERE login = ?").bind(accountable).first<any>() : null;
  if (!human) return c.json({ error: "accountable must be a GitHub login that has signed in to githug" }, 400);
  try {
    // email defaults to <id>@<agent domain> inside createAgent when omitted.
    const { agent, key } = await createAgent(c.env.DB, { id, name, repos: repos as string[], accountable, accountable_id: human.github_id ?? null, permissions, email });
    return c.json({ agent, key, note: "Store this key now; it is not shown again." });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("admin agent create failed:", msg);
    return c.json({ error: /UNIQUE|constraint/i.test(msg) ? `agent '${id}' already exists` : "could not create the agent" }, 400);
  }
});

app.get("/v1/agents", async (c) => {
  if (await adminAuthed(c)) return c.json({ agents: await listAgents(c.env.DB), tokens: await tokenStats(c.env.DB) });
  const account = await currentAccount(c);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  return c.json({ agents: await listAgents(c.env.DB, account.id) });
});

// Shadow billing (M3.1): this month's grants and what they'd cost on the planned pricing.
app.get("/v1/usage", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  if (!BILLING) return c.json({ error: "usage isn't tracked on a self-hosted instance" }, 404);
  return c.json({ ...(await monthUsage(c.env, account)), charged: 0, note: "Free during the beta; this is what the planned pricing would charge." });
});

// Repos the account can put agents on (installations of the App its human can see).
app.get("/v1/repos", async (c) => {
  const account = await currentAccount(c);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  try {
    return c.json({ login: account.login, repos: await accountRepos(c.env, account, c.req.query("fresh") === "1"), install_url: `${SITE_ORIGIN}/app/install` });
  } catch (e) {
    console.error("v1 repos failed:", (e as Error).message);
    return c.json({ error: "Could not load repositories from GitHub." }, 502);
  }
});

app.post("/v1/agents/:id/:action{disable|enable}", async (c) => {
  const disable = c.req.param("action") === "disable";
  const id = c.req.param("id").toLowerCase();
  let ok: boolean | "parent_disabled";
  if (await adminAuthed(c)) ok = await setAgentDisabled(c.env.DB, id, disable);
  else {
    const account = await currentAccount(c);
    if (!account || !sameOrigin(c)) return c.json({ error: "unauthorized" }, 401);
    const owned = await findAccountAgent(c.env.DB, id, account.id);
    ok = owned && (await canManage(c, account, owned)) ? await setAgentDisabled(c.env.DB, id, disable, account.id) : false;
  }
  if (ok === "parent_disabled") return c.json({ error: "an agent above this one is disabled; enable it first" }, 409);
  return ok ? c.json({ ok: true }) : c.json({ error: "no such agent" }, 404);
});

// Self-hosted instance admin: who may sign in, and setup status.
const ADMIN_CSS = `table{border-collapse:collapse;width:100%}td{padding:6px 8px;border-bottom:1px solid var(--faint);vertical-align:top}input,button{font:inherit;padding:6px 10px;border-radius:6px;border:1px solid var(--faint);background:var(--raise);color:inherit}button{cursor:pointer}`;
async function instanceAdmin(c: any): Promise<Account | null> {
  const me = await sessionHuman(c);
  return me && (await isInstanceAdmin(c.env, me.login, me.actorId)) ? me : null;
}
app.get("/admin", async (c) => {
  if (!SELF_HOSTED) return c.text("Not found.", 404);
  const me = await instanceAdmin(c);
  if (!me) return c.redirect("/login?next=/admin", 302);
  const users = await instanceUsers(c.env);
  const allow = (c.env.GITHUG_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const status = [
    ["GitHub App", c.env.GITHUB_APP_ID ? `${c.env.GITHUB_APP_SLUG ?? ""} (id ${c.env.GITHUB_APP_ID})` : "not set up: /gateway/setup/github-app"],
    ["Sign-in (OAuth)", c.env.GITHUB_OAUTH_CLIENT_ID && c.env.GITHUB_OAUTH_CLIENT_SECRET ? "ready" : "missing client id/secret"],
    ["Encryption key", c.env.GATEWAY_ENC_KEY ? "set" : "missing GATEWAY_ENC_KEY"],
    ["Origin", SITE_ORIGIN],
    ["GITHUG_ALLOW", allow.join(", ") || "(empty)"],
  ];
  c.header("Cache-Control", "private, no-store");
  return c.html(
    page({
      title: `${BRAND} · admin`,
      noindex: true,
      css: UI_CSS + ADMIN_CSS,
      body: `<main class="wrap">
<p><a href="/app">← dashboard</a></p><h1>Instance</h1>
<table>${status.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join("")}</table>
<h2>Who may sign in</h2>
<table>${users.map((u) => `<tr><td>${escapeHtml(u.login)}</td><td>${u.role}</td><td>${u.role === "admin" ? "" : `<form method="post" action="/admin/users/${encodeURIComponent(u.login)}/remove" style="margin:0"><button>remove</button></form>`}</td></tr>`).join("")}</table>
<form method="post" action="/admin/users" style="margin-top:12px"><input name="login" placeholder="github-login" required pattern="[A-Za-z0-9-]{1,39}"/> <button>add</button></form>
<p>People in an org listed in <code>GITHUG_ALLOW</code> who can push to one of its repos join on first sign-in.</p>
</main>`,
    }),
  );
});
app.post("/admin/users", async (c) => {
  if (!SELF_HOSTED) return c.text("Not found.", 404);
  const me = await instanceAdmin(c);
  if (!me || !sameOrigin(c)) return c.text("Forbidden.", 403);
  const login = String((await c.req.parseBody()).login ?? "").trim();
  if (/^[A-Za-z0-9-]{1,39}$/.test(login)) await addInstanceUser(c.env, login, "member", me.login);
  return c.redirect("/admin", 303);
});
app.post("/admin/users/:login/remove", async (c) => {
  if (!SELF_HOSTED) return c.text("Not found.", 404);
  const me = await instanceAdmin(c);
  if (!me || !sameOrigin(c)) return c.text("Forbidden.", 403);
  await removeInstanceUser(c.env, c.req.param("login"));
  return c.redirect("/admin", 303);
});

// Quickstart (M1.7): HTML for people, /docs/<slug>.md for agents.
// Trust pages (M3.4): same renderer as the docs; raw markdown at /docs/<slug>.md too.
app.get("/docs/", (c) => c.redirect("/docs", 301));
app.get("/docs", (c) => {
  track(c, "/docs");
  return c.html(docsPage("index")!);
});
app.get("/docs/:slug", (c) => {
  const raw = c.req.param("slug");
  const md = raw.endsWith(".md");
  const slug = md ? raw.slice(0, -3) : raw;
  if (!DOCS[slug]) return c.text("Not found.", 404);
  track(c, `/docs/${raw}`);
  if (md) return c.body(docSource(slug)!, 200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" });
  return c.html(docsPage(slug)!);
});

// `hug` distribution (M1.6): the shell installer and the binaries it fetches from R2.
// Installer runs and binary downloads are logged first-party (page_views ids /install, /dl/hug/<file>).
app.get("/install", (c) => {
  track(c, "/install");
  // A self-host serves the installer but fetches the official hug binaries (unless it hosts its own).
  return c.body(installScript(c.env.GITHUG_DL_ORIGIN || (SELF_HOSTED ? "https://githug.ai" : SITE_ORIGIN), SELF_HOSTED ? SITE_ORIGIN : undefined), 200, { "Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": "public, max-age=300" });
});
app.get("/dl/hug/latest", async (c) => {
  const obj = await c.env.RELEASES.get("hug/latest");
  if (!obj) return c.text("no release yet", 404);
  return c.body(await obj.text(), 200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=60" });
});
app.get("/dl/hug/:version/:file", async (c) => {
  const version = c.req.param("version");
  const file = c.req.param("file");
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(version) || !/^(?:hug-(?:darwin|linux)-(?:amd64|arm64)|SHA256SUMS)$/.test(file)) return c.text("Not found.", 404);
  const obj = await c.env.RELEASES.get(`hug/${version}/${file}`);
  if (!obj) return c.text("Not found.", 404);
  if (file !== "SHA256SUMS") track(c, `/dl/hug/${file}`);
  return c.body(obj.body, 200, {
    "Content-Type": file === "SHA256SUMS" ? "text/plain; charset=utf-8" : "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
    ...(file === "SHA256SUMS" ? {} : { "Content-Disposition": `attachment; filename="hug"` }),
  });
});

// Verify page (M1.9): public, free for maintainers. /v takes a pasted commit URL;
// /v/<owner>/<repo>/<sha> checks the commit against the agent registry and token log.
// Results are cached 10 minutes; every view is logged (the acquisition signal).
app.get("/v", (c) => {
  const url = c.req.query("url");
  if (url === undefined) {
    track(c, "/v");
    return c.html(verifyIndexPage());
  }
  const pull = /github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)/i.exec(url);
  if (pull) return c.redirect(`/v/${pull[1]}/pull/${pull[2]}`, 302);
  const m = /github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/(?:commit|commits)\/([0-9a-f]{7,40})/i.exec(url) ?? /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)@([0-9a-f]{7,40})$/i.exec(url.trim());
  if (!m) return c.html(verifyIndexPage("That doesn't look like a GitHub commit link."), 400);
  return c.redirect(`/v/${m[1]}/${m[2].toLowerCase()}`, 302);
});

// Admin: run the PR-outcome sync now instead of waiting for the cron.
app.post("/api/admin/sync-prs", async (c) => {
  if (!(await adminAuthed(c))) return c.json({ error: "unauthorized" }, 401);
  return c.json({ synced: await syncPrOutcomes(c.env) });
});

app.get("/v/:owner/:repo/pull/:n", async (c) => {
  const repo = `${c.req.param("owner")}/${c.req.param("repo")}`;
  const n = Number(c.req.param("n"));
  if (!validRepo(repo) || !Number.isInteger(n) || n < 1) return c.html(verifyIndexPage("That doesn't look like a pull request."), 400);
  track(c, `/v/${repo}`);
  const cacheKey = `gw:verifypr2:${repo.toLowerCase()}:${n}`;
  let result = await c.env.CACHE.get(cacheKey, "json");
  if (!result) {
    if (!(await c.env.WRITE_LIMITER.limit({ key: `v:${c.req.header("cf-connecting-ip") ?? "unknown"}` })).success) return c.text("Too many requests. Try again in a minute.", 429);
    try {
      result = await verifyPull(c.env, repo, n);
    } catch (e) {
      console.error("verify pull failed:", (e as Error).message);
      return c.text("Could not reach GitHub. Try again in a minute.", 502);
    }
    c.executionCtx.waitUntil(c.env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 600 }));
  }
  c.header("Cache-Control", "public, max-age=300");
  return c.html(verifyPullPage(repo, n, result as any));
});

app.get("/v/:owner/:repo/:sha", async (c) => {
  const repo = `${c.req.param("owner")}/${c.req.param("repo")}`;
  const sha = c.req.param("sha").toLowerCase();
  if (!validRepo(repo) || !/^[0-9a-f]{7,40}$/.test(sha)) return c.html(verifyIndexPage("That doesn't look like a commit."), 400);
  track(c, `/v/${repo}`);
  const cacheKey = `gw:verify3:${repo.toLowerCase()}:${sha}`; // bump the prefix when verify logic changes
  let result = await c.env.CACHE.get(cacheKey, "json");
  if (!result) {
    if (!(await c.env.WRITE_LIMITER.limit({ key: `v:${c.req.header("cf-connecting-ip") ?? "unknown"}` })).success) return c.text("Too many requests. Try again in a minute.", 429);
    try {
      result = await verifyCommit(c.env, repo, sha);
    } catch (e) {
      console.error("verify failed:", (e as Error).message);
      return c.text("Could not reach GitHub. Try again in a minute.", 502);
    }
    c.executionCtx.waitUntil(c.env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 600 }));
  }
  c.header("Cache-Control", "public, max-age=300");
  return c.html(verifyPage(repo, sha, result as any));
});

// Each outcome is logged as a /evt/device/* page view (start, approved, denied, expired, error,
// not-allowed) so the signup funnel shows people who reached GitHub and stopped; pending polls aren't.
// `hug init` / `hug login` (M1.5): GitHub's device flow, proxied so the human's GitHub
// token stays server-side. The CLI shows the user code; the human approves on github.com;
// the CLI polls /v1/device/token and gets back an account key (hug_…), never the GitHub token.
app.post("/v1/device/code", async (c) => {
  if (!(await c.env.WRITE_LIMITER.limit({ key: `dev:${c.req.header("cf-connecting-ip") ?? "unknown"}` })).success) return c.json({ error: "rate limited" }, 429);
  try {
    const d = await startDeviceFlow(c.env);
    track(c, "/evt/device/start");
    return c.json({ ...d, install_url: `${SITE_ORIGIN}/app/install` });
  } catch (e) {
    console.error("device code failed:", (e as Error).message);
    return c.json({ error: "Could not start GitHub device login." }, 502);
  }
});

app.post("/v1/device/token", async (c) => {
  if (!(await c.env.WRITE_LIMITER.limit({ key: `dev:${c.req.header("cf-connecting-ip") ?? "unknown"}` })).success) return c.json({ error: "rate limited" }, 429);
  if (!c.env.GATEWAY_ENC_KEY) return c.json({ error: "gateway not configured" }, 503);
  const body = await c.req.json().catch(() => ({}) as any);
  const deviceCode = String(body?.device_code ?? "");
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(deviceCode)) return c.json({ error: "device_code required" }, 400);
  try {
    const r = await pollDeviceFlow(c.env, deviceCode);
    if ("pending" in r) return c.json({ status: r.pending }, 202);
    const user = await fetchGithubUser(r.grant.access_token);
    await upsertGatewayUser(c.env, { login: user.login, github_id: user.id, email: user.email, access_token: r.grant.access_token, refresh_token: r.grant.refresh_token ?? null, expires_in: r.grant.expires_in ?? null });
    if (!(await mayJoin(c.env, user))) {
      track(c, "/evt/device/not-allowed");
      return c.json({ error: `${user.login} isn't on this githug instance's list; ask its admin to add you` }, 403);
    }
    const accountId = await upsertAccount(c.env.DB, { login: user.login, github_id: user.id }, "agent");
    const key = await createAccountKey(c.env.DB, accountId, String(body?.name ?? "hug").slice(0, 80));
    track(c, "/evt/device/approved");
    return c.json({ status: "ok", account_key: key, login: user.login, account_id: accountId, install_url: `${SITE_ORIGIN}/app/install` });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("device token failed:", msg);
    track(c, `/evt/device/${/denied/i.test(msg) ? "denied" : /expired/i.test(msg) ? "expired" : "error"}`);
    return c.json({ error: /expired|denied/i.test(msg) ? msg : "Could not complete GitHub device login." }, 400);
  }
});

// M2.6: an agent creates a sub-agent with its own key (for the workers it runs). Same
// accountable human and account; repos/permissions a subset; prefixed id; depth ≤ 3.
app.post("/v1/agents/children", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await c.env.WRITE_LIMITER.limit({ key: `child:${ip}` })).success) return c.json({ error: "rate limited" }, 429);
  const auth = c.req.header("authorization") ?? "";
  const parent = auth.startsWith("Bearer ") ? await findAgentByKey(c.env.DB, auth.slice(7).trim()) : null;
  if (!parent) return c.json({ error: "invalid agent key" }, 401);
  if (parent.disabled) return c.json({ error: "agent disabled" }, 403);
  const root = (await agentChain(c.env.DB, parent))[0];
  if (!(await c.env.WRITE_LIMITER.limit({ key: `childroot:${root}` })).success) return c.json({ error: "rate limited" }, 429);
  const body = await c.req.json().catch(() => ({}) as any);
  const repos: unknown[] = Array.isArray(body?.repos) ? body.repos : [];
  if (!repos.every(validRepo)) return c.json({ error: "repos must be owner/repo" }, 400);
  const permissions = body?.permissions && typeof body.permissions === "object" ? (body.permissions as Record<string, string>) : null;
  const res = await createChildAgent(c.env.DB, parent, { name: String(body?.name ?? ""), repos: repos as string[], permissions });
  if ("error" in res) return c.json({ error: res.error }, 400);
  return c.json({ agent: res.agent, key: res.key, note: "Store this key now; it is not shown again." });
});

// M2.7: the githug verify Action. It reads a PR's commits with the workflow's own token and
// posts them here, so maintainers get the check without installing githug. A commit that
// claims an agent (agents.githug.ai author/co-author, githug bot, Agent: trailer) must check
// out against the registry and key log; plain human commits pass.
app.post("/v1/verify", async (c) => {
  // Limited per repo, not per IP: GitHub's hosted runners share IPs across unrelated repos.
  // A per-IP cap too, high enough for a shared runner: rotating repo names mustn't be free.
  if (!(await c.env.VERIFY_LIMITER.limit({ key: `vfyip:${c.req.header("cf-connecting-ip") ?? "unknown"}` })).success) return c.json({ error: "rate limited" }, 429);
  const body = await c.req.json().catch(() => ({}) as any);
  const repo = String(body?.repo ?? "");
  if (validRepo(repo) && !(await c.env.WRITE_LIMITER.limit({ key: `vfy:${repo.toLowerCase()}` })).success) return c.json({ error: "rate limited" }, 429);
  const commits: any[] = Array.isArray(body?.commits) ? body.commits.slice(0, 100) : [];
  if (!validRepo(repo)) return c.json({ error: "repo required (owner/repo)" }, 400);
  const str = (v: unknown, n: number) => String(v ?? "").slice(0, n);
  // require: "claims" (default) fails only commits whose agent claims contradict githug's
  // records; "attested" fails every commit that isn't an attested githug agent commit,
  // except signed commits by the GitHub logins in `allow` (the repo's humans).
  const strict = body?.require === "attested";
  const allow = new Set((Array.isArray(body?.allow) ? body.allow : []).slice(0, 50).map((l: unknown) => String(l).trim().toLowerCase()).filter(Boolean));
  const results = [];
  for (const cm of commits) {
    const sha = str(cm?.sha, 40).toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) continue;
    const r = await verifyCommitData(c.env, repo, { sha, message: str(cm?.message, 20_000), date: str(cm?.date, 40), author_email: str(cm?.author_email, 320), author_name: str(cm?.author_name, 200) });
    let human: { login: string | null; signed: boolean; source: "github" | "action" } | null = null;
    if (strict && r.verdict !== "verified" && allow.size) {
      // GitHub's view when githug is installed; else what the Action read (weaker).
      const g = /^[0-9a-f]{40}$/.test(sha) ? await githubCommitIdentity(c.env, repo, sha) : null;
      human = g ? { ...g, source: "github" } : { login: cm?.author_login ? str(cm.author_login, 39) : null, signed: cm?.signed === true, source: "action" };
    }
    const allowedHuman = !!human?.login && allow.has(human.login.toLowerCase()) && human.signed;
    const checks = [...r.checks];
    if (strict && r.verdict !== "verified") {
      checks.push({
        ok: allowedHuman,
        label: allowedHuman
          ? `Signed commit by ${human!.login}, who may commit directly`
          : human?.login && allow.has(human.login.toLowerCase())
            ? `${human.login} may commit directly, but this commit isn't signed (GitHub-verified)`
            : "Not an attested githug agent commit (this repo requires one)",
      });
    }
    results.push({ sha, verdict: r.verdict, attested: r.attested, agent: r.agent, accountable: r.accountable, run: r.run, claims_agent: !!r.agent, allowed_human: allowedHuman, checks });
  }
  // Default: a commit fails when its claims contradict githug's records. "consistent" (claims
  // match, no push attestation) passes. Strict: only attested agent commits and allowed humans pass.
  const failing = strict
    ? results.filter((r) => r.verdict !== "verified" && !r.allowed_human)
    : results.filter((r) => r.claims_agent && r.verdict !== "verified" && r.verdict !== "consistent");
  track(c, `/action/${repo.toLowerCase()}`);
  return c.json({
    repo,
    require: strict ? "attested" : "claims",
    pass: failing.length === 0,
    agent_commits: results.filter((r) => r.claims_agent).length,
    attested: results.filter((r) => r.attested).length,
    failing: failing.length,
    commits: results,
    details_url: `${SITE_ORIGIN}/v`,
  });
});

// M2.5: the agent opens a PR; the accountable human is its author (falls back to the App
// bot), and the footer names the agent and links /v/<repo>/pull/<n>.
app.post("/v1/pr", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await c.env.WRITE_LIMITER.limit({ key: `pr:${ip}` })).success) return c.json({ error: "rate limited" }, 429);
  const auth = c.req.header("authorization") ?? "";
  const agent = auth.startsWith("Bearer ") ? await findAgentByKey(c.env.DB, auth.slice(7).trim()) : null;
  if (!agent) return c.json({ error: "invalid agent key" }, 401);
  if (agent.disabled) return c.json({ error: "agent disabled" }, 403);
  const body = await c.req.json().catch(() => ({}) as any);
  const repo = typeof body?.repo === "string" ? body.repo : agent.repos.length === 1 ? agent.repos[0] : "";
  if (!validRepo(repo)) return c.json({ error: "repo required (owner/repo)" }, 400);
  if (!agent.repos.some((r) => r.toLowerCase() === repo.toLowerCase())) return c.json({ error: `agent '${agent.id}' is not allowed on ${repo}` }, 403);
  const head = String(body?.head ?? "").trim();
  const base = String(body?.base ?? "").trim();
  const title = String(body?.title ?? "").trim().slice(0, 250);
  const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,200}$/;
  if (!BRANCH_RE.test(head) || !BRANCH_RE.test(base)) return c.json({ error: "head and base must be branch names" }, 400);
  if (!title) return c.json({ error: "title required" }, 400);
  try {
    const installationId = await installationForRepo(c.env, repo);
    const pr = await openPullRequest(c.env, agent, installationId, {
      repo, head, base, title,
      body: String(body?.body ?? "").slice(0, 60_000),
      run: String(body?.run ?? "").slice(0, 120),
      draft: !!body?.draft,
      as: body?.as === "agent" ? "agent" : "human",
      labels: Array.isArray(body?.labels) ? body.labels.map((l: unknown) => String(l).slice(0, 50)).slice(0, 10) : [],
    });
    return c.json({ ...pr, verify_url: `${SITE_ORIGIN}/v/${repo}/pull/${pr.number}` });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("pr open failed:", msg);
    return c.json({ error: /GitHub 422/.test(msg) ? msg.replace(/^GitHub 422 on [^:]+: /, "").slice(0, 300) : "Could not open the pull request." }, /422/.test(msg) ? 422 : 502);
  }
});

// Push attestation: hug's pre-push hook reports the commits it's about to push, with the
// agent's key. This is what makes a commit "verified" rather than merely "consistent".
app.post("/v1/commits", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await c.env.WRITE_LIMITER.limit({ key: `att:${ip}` })).success) return c.json({ error: "rate limited" }, 429);
  const auth = c.req.header("authorization") ?? "";
  const agent = auth.startsWith("Bearer ") ? await findAgentByKey(c.env.DB, auth.slice(7).trim()) : null;
  if (!agent) return c.json({ error: "invalid agent key" }, 401);
  if (agent.disabled) return c.json({ error: "agent disabled" }, 403);
  const body = await c.req.json().catch(() => ({}) as any);
  const repo = typeof body?.repo === "string" ? body.repo : "";
  if (!validRepo(repo)) return c.json({ error: "repo required (owner/repo)" }, 400);
  if (!agent.repos.some((r) => r.toLowerCase() === repo.toLowerCase())) return c.json({ error: `agent '${agent.id}' is not allowed on ${repo}` }, 403);
  const shas: unknown[] = Array.isArray(body?.shas) ? body.shas : [];
  if (!shas.length || shas.length > 500 || !shas.every((s) => typeof s === "string" && /^[0-9a-f]{40}$/i.test(s))) return c.json({ error: "shas must be 1–500 full commit SHAs" }, 400);
  const run = String(body?.run ?? "").slice(0, 120);
  const ipHash = await hashIp(c.env, ip);
  const added = await attestCommits(c.env.DB, agent, repo, (shas as string[]).map((s) => s.toLowerCase()), run, ipHash);
  return c.json({ ok: true, attested: added });
});

/** The commit trailers for an agent's commits, from its settings as they are now. */
async function agentTrailers(c: any, agent: AgentRow, run: string): Promise<string[]> {
  // Co-authored-by (which GitHub counts on the human's contribution graph) only when the
  // agent has graph credit on and the accountable human has signed in to githug.
  // Accountable: is always there and doesn't touch the graph.
  const human = agent.credit_human && agent.accountable ? await findGatewayUser(c.env.DB, { login: agent.accountable, id: agent.accountable_id }) : null;
  return [
    ...(human?.email ? [`Co-authored-by: ${human.login} <${human.email}>`] : []),
    `Accountable: ${agent.accountable}`,
    `Agent: ${agent.id}`,
    // Sub-agents (M2.6) carry the whole lineage: human › root agent › … › this one.
    ...(agent.parent ? [`Agent-Chain: ${[agent.accountable, ...(await agentChain(c.env.DB, agent))].join(" › ")}`] : []),
    ...(run ? [`Run: ${run}`] : []),
  ];
}

// Trailers without a mint, for the commit hook: a cached token outlives settings changes
// (graph credit), and trailers carry no secret, so hug asks for them fresh on every commit.
app.post("/v1/trailers", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const agent = auth.startsWith("Bearer ") ? await findAgentByKey(c.env.DB, auth.slice(7).trim()) : null;
  if (!agent) return c.json({ error: "invalid agent key" }, 401);
  if (agent.disabled) return c.json({ error: "agent disabled" }, 403);
  if (!(await c.env.VERIFY_LIMITER.limit({ key: `trailers:${agent.id}` })).success) return c.json({ error: "rate limited" }, 429);
  const body = await c.req.json().catch(() => ({}) as any);
  const repo = typeof body?.repo === "string" ? body.repo : "";
  if (!validRepo(repo)) return c.json({ error: "repo required (owner/repo)" }, 400);
  if (!agent.repos.some((r) => r.toLowerCase() === repo.toLowerCase())) return c.json({ error: `agent '${agent.id}' is not allowed on ${repo}` }, 403);
  return c.json({ trailers: await agentTrailers(c, agent, String(body?.run ?? "").slice(0, 120)) });
});

// The one endpoint agents call: bearer agent key → 1h installation token for one repo.
app.post("/v1/token", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await c.env.WRITE_LIMITER.limit({ key: `tok:${ip}` })).success) return c.json({ error: "rate limited" }, 429);
  const auth = c.req.header("authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const agent = key ? await findAgentByKey(c.env.DB, key) : null;
  if (!agent) return c.json({ error: "invalid agent key" }, 401);
  if (agent.disabled) return c.json({ error: "agent disabled" }, 403);
  if (!(await c.env.WRITE_LIMITER.limit({ key: `tokagent:${agent.id}` })).success) return c.json({ error: "rate limited" }, 429);
  const body = await c.req.json().catch(() => ({}) as any);
  const repo = typeof body?.repo === "string" ? body.repo : agent.repos.length === 1 ? agent.repos[0] : "";
  if (!validRepo(repo)) return c.json({ error: `repo required (owner/repo): '${agent.id}' works on ${agent.repos.join(", ")}` }, 400);
  if (!agent.repos.some((r) => r.toLowerCase() === repo.toLowerCase())) return c.json({ error: `agent '${agent.id}' is not allowed on ${repo}` }, 403);
  // Optional loop/run id: ties every action taken with this token back to the run.
  const run = String(body?.run ?? "").slice(0, 120);
  // Which surface this token is for (docs/ATTRIBUTION.md: git pushes vs PR-surface calls
  // vs MCP); defaults to 'git' since that's the only surface this slice mints for.
  const surfaceIn = body?.surface;
  const surface = surfaceIn === "pr" || surfaceIn === "mcp" || surfaceIn === "git" ? surfaceIn : "git";
  try {
    // M2.1: through the agent's own App when it has one, else the shared githug Gateway App.
    const minted = await mintForAgent(c.env, agent, repo, agent.permissions ?? undefined);
    const installationId = minted.installation_id;
    const bot = minted.bot;
    const ipHash = await hashIp(c.env, ip);
    // All mints today are authenticated by the agent's own bearer key.
    const mintedBy = `agent:${agent.id}`;
    c.executionCtx.waitUntil(logToken(c.env.DB, { agent_id: agent.id, repo, installation_id: installationId, expires: minted.expires_at, ip_hash: ipHash, run, minted_by: mintedBy, surface }));
    const trailers = await agentTrailers(c, agent, run);
    return c.json({
      token: minted.token,
      expires_at: minted.expires_at,
      repo,
      run,
      surface,
      agent: { id: agent.id, name: agent.name },
      accountable: agent.accountable,
      // The commit author. A named agent (its own App, M2.1) commits as its bot's noreply
      // address, so GitHub shows its avatar and links its bot account; otherwise the
      // free-form <id>@agents.githug.ai identity (docs/ATTRIBUTION.md).
      author: minted.named && bot ? { name: agent.name, email: bot.email } : { name: agent.name, email: agent.email },
      identity: bot?.login ?? null,
      named: minted.named,
      // The agent has its own App but minting through it failed, so this token acts as the shared
      // bot: GitHub can't tell this agent apart for this run. Surfaced instead of hidden.
      ...(minted.fallback && { fallback: true, warning: `Minting through ${agent.id}'s own GitHub App failed; this token acts as the shared App.` }),
      // Commit as the app's bot user but with the agent's name, so the log reads
      // "orbit" with the app avatar; the human stays on the Accountable: trailer.
      git_author: bot ? { name: agent.name, email: bot.email } : null,
      trailers,
      permissions: minted.permissions,
    });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("token mint failed:", msg);
    const notInstalled = /404/.test(msg);
    // GitHub 422s a mint asking for a permission the App doesn't hold (e.g. workflows).
    const missingPermission = /GitHub 422/.test(msg) && /permission/i.test(msg);
    if (missingPermission)
      return c.json({ error: `This agent's GitHub App doesn't hold every permission the agent asks for${agent.permissions?.workflows ? " (workflows: write)" : ""}. Add it in the App's settings on GitHub and approve the change on the installation, or turn it off for the agent in githug.` }, 422);
    return c.json({ error: notInstalled ? `githug Gateway is not installed on ${repo}` : "Could not mint a token from GitHub. Try again in a minute." }, notInstalled ? 404 : 502);
  }
});


// --- admin auth ---
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** The one-time App setup page (and a wrapping site's admin pages): HTTP Basic, deny-by-default. */
export function statsAuthed(c: any): boolean {
  const user = c.env.STATS_USER;
  const pass = c.env.STATS_PASSWORD;
  if (!user || !pass) return false; // deny-by-default
  const [scheme, encoded] = (c.req.header("authorization") ?? "").split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return false;
  }
  const i = decoded.indexOf(":"); // the password may contain ':'
  return i > 0 && safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), pass);
}

/**
 * The admin API (agents across accounts, sync): `Authorization: Bearer <ADMIN_TOKEN>`,
 * deny-by-default, separate from the stats password. 32+ random chars, so not guessable.
 */
export async function adminAuthed(c: any): Promise<boolean> {
  const want = c.env.ADMIN_TOKEN;
  const auth = c.req.header("authorization") ?? "";
  if (!want || want.length < 32 || !auth.startsWith("Bearer ") || auth.startsWith("Bearer hug_") || auth.startsWith("Bearer ghg_")) return false;
  return safeEqual(auth.slice(7).trim(), want);
}


/** The service's own cron work: agent scope re-checks and PR outcomes. */
export async function scheduled(rawEnv: Env): Promise<void> {
  const env = await withSettings(rawEnv);
  configureSite(env);
  try {
    const r = await recheckAgentScopes(env);
    console.log(`recheckAgentScopes: ${r.checked} agents, disabled ${r.disabled.join(", ") || "none"}`);
  } catch (e) {
    console.error("recheckAgentScopes failed:", (e as Error).message);
  }
  // M1.10: PR outcomes per agent (Agent Merge Index raw data).
  try {
    console.log(`syncPrOutcomes: ${await syncPrOutcomes(env)} PRs`);
  } catch (e) {
    console.error("syncPrOutcomes failed:", (e as Error).message);
  }
}

/** Serves a request: saved settings (self-host setup page) fill in what the env lacks. */
export async function fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return app.fetch(req, await withSettings(env), ctx);
}
