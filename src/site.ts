/**
 * Where this githug runs and what it is (docs/SELF_HOSTING.md). githug.ai is the default;
 * a self-hosted instance sets its own:
 *
 *   GITHUG_ORIGIN        https://githug.example.com  (unset on a self-host: the request's origin)
 *   GITHUG_AGENT_DOMAIN  agents.githug.example.com   the agent commit-email domain (<id>@<domain>)
 *   GITHUG_BRAND         githug                      App names (<agent>-<brand>), PR footers
 *   GITHUG_MODE          hosted | self-hosted        self-hosted: single-tenant (signup
 *                                                    allowlist + first-run admin), no billing
 *   GITHUG_ALLOW         ana,acme                    self-hosted: GitHub logins, or orgs whose
 *                                                    members with push may sign in
 *   GITHUG_ADMIN         ana                         self-hosted: the instance admin's login
 *
 * Exported as live bindings (`export let`): configureSite() runs on every request and cron
 * from the Worker's env, and every importer sees the current values.
 */

export let SITE_ORIGIN = "https://githug.ai";
export let AGENT_DOMAIN = "agents.githug.ai";
export let BRAND = "githug";
export let SELF_HOSTED = false;

/** Shadow billing (M3.1). githug.ai only. */
export let BILLING = true;

export interface SiteEnv {
  GITHUG_ORIGIN?: string;
  GITHUG_AGENT_DOMAIN?: string;
  GITHUG_BRAND?: string;
  GITHUG_MODE?: string;
}

/** Applies the env; `requestOrigin` is the fallback origin on a self-host without GITHUG_ORIGIN. */
export function configureSite(env: SiteEnv, requestOrigin?: string): void {
  SELF_HOSTED = env.GITHUG_MODE === "self-hosted";
  const origin = (env.GITHUG_ORIGIN || (SELF_HOSTED ? requestOrigin : "") || "https://githug.ai").replace(/\/+$/, "");
  SITE_ORIGIN = origin;
  AGENT_DOMAIN = (env.GITHUG_AGENT_DOMAIN || (SELF_HOSTED ? `agents.${new URL(origin).hostname}` : "agents.githug.ai")).toLowerCase();
  BRAND = env.GITHUG_BRAND || "githug";
  BILLING = !SELF_HOSTED;
}

/** The brand as a GitHub-name-safe slug: "<agent>-<slug>" App names. */
export function brandSlug(): string {
  return BRAND.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "githug";
}

/** `<id>@<agent domain>`, the commit email of an agent without its own GitHub App. */
export function agentEmail(id: string): string {
  return `${id}@${AGENT_DOMAIN}`;
}

/** Matches an agent commit email for this instance's domain; group 1 is the agent id. */
export function agentEmailRe(): RegExp {
  return new RegExp(`^([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)@${AGENT_DOMAIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
}
