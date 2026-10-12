/**
 * /app — the signed-in dashboard (ROADMAP Track B, M1.4). Server-rendered like every other
 * page, in the landing's brand: one mono family, forest ground, green = agent, coral = human.
 * v0 (M1.1) shows who is signed in and the agents they are accountable for.
 */
import { escapeHtml } from "./render.js";
import { page, UI_CSS } from "./layout.js";
import type { Account, AgentRow, AccountRepo, RunLog, CliLogin, MonthUsage } from "./gateway-api.js";

export interface AppPageOpts {
  repos: AccountRepo[];
  logins: CliLogin[];
  usage?: MonthUsage | null;
  /** Accounts the signed-in human can act for: their own first, then orgs (M3.7). */
  accounts?: { id: string; login: string; kind: "user" | "org" }[];
  /** Set right after creating an agent: its bearer key, shown exactly once. */
  created?: { id: string; key: string };
  error?: string;
}


/** Parents first, each followed by its sub-agents (depth-first), newest roots first. */
function treeOrder(agents: AgentRow[]): AgentRow[] {
  const kids = new Map<string, AgentRow[]>();
  for (const a of agents) if (a.parent) kids.set(a.parent, [...(kids.get(a.parent) ?? []), a]);
  const ids = new Set(agents.map((a) => a.id));
  const out: AgentRow[] = [];
  const walk = (a: AgentRow) => {
    out.push(a);
    for (const k of kids.get(a.id) ?? []) walk(k);
  };
  for (const a of agents) if (!a.parent || !ids.has(a.parent)) walk(a);
  return out;
}

export function appPage(account: Account, agents: AgentRow[], opts: AppPageOpts): string {
  const rows = treeOrder(agents)
    .map((a) => {
      const last = a.last_used ? `last used ${a.last_used.slice(0, 16).replace("T", " ")} UTC` : "never used";
      const status = a.disabled ? ` · <span class="off">disabled</span>` : "";
      const action = a.disabled ? "enable" : "disable";
      const toggle = `<form class="inline" method="post" action="/app/agents/${encodeURIComponent(a.id)}/${action}"><button class="btn" type="submit">${action}</button></form>`;
      return `<li><span>${a.parent ? `<span class="meta">${"  ".repeat(a.depth)}↳ </span>` : ""}<a class="id" href="/app/agents/${encodeURIComponent(a.id)}">${escapeHtml(a.id)}</a> <span class="meta">${escapeHtml(a.repos.join(", "))} · ${last}${status}</span></span>${toggle}</li>`;
    })
    .join("");
  const list = agents.length ? `<ul class="agents">${rows}</ul>` : `<p class="empty">No agents yet. Name one below.</p>`;
  const created = opts.created
    ? `<div class="key"><b>Key for ${escapeHtml(opts.created.id)}.</b> Shown once. Store it where your agent runs:
${keyBox(opts.created.key)}</div>`
    : "";
  const options = opts.repos.map((r) => `<option value="${escapeHtml(r.repo)}">${escapeHtml(r.repo)}${r.private ? " (private)" : ""}</option>`).join("");
  const newAgent = opts.repos.length
    ? `<form class="new" method="post" action="/app/agents">
    <label class="sr" for="na-id">Agent name</label><input id="na-id" name="id" placeholder="agent-name" pattern="[a-z0-9][a-z0-9-]{0,38}[a-z0-9]?" required autocomplete="off">
    <label class="sr" for="na-repo">Repository</label><select id="na-repo" name="repo" required>${options}</select>
    <button class="btn go" type="submit">Create agent</button></form>
  <p class="hint">Lowercase letters, digits, dashes. Names are unique across githug. <a href="/app/install">Add repositories</a></p>`
    : `<p class="empty">Install githug on the repositories your agents work on, then name an agent.<br><br><a class="btn go" href="/app/install">Install on GitHub</a></p>`;
  const isOrg = account.kind === "org";
  const switcher = (opts.accounts?.length ?? 0) > 1
    ? `<form class="new" method="post" action="/app/switch" style="margin:0 0 20px"><label class="sr" for="acct">Account</label><select id="acct" name="account" onchange="this.form.submit()">${opts.accounts!
        .map((a) => `<option value="${escapeHtml(a.id)}"${a.id === account.id ? " selected" : ""}>${escapeHtml(a.login)}${a.kind === "org" ? " (org)" : " (you)"}</option>`)
        .join("")}</select><noscript><button class="btn" type="submit">Switch</button></noscript><span class="hint" style="margin:0">Orgs appear when githug is installed on them.</span></form>`
    : "";
  return shell(
    isOrg ? `githug · ${account.login}` : "githug · your agents",
    account,
    `${switcher}<h1>${isOrg ? `${escapeHtml(account.login)}'s agents` : "Your agents"}</h1>
  <p class="lede">${isOrg ? `Owned by the ${escapeHtml(account.login)} org and billed to it. Each agent names the member who created it as accountable.` : "Agents you're accountable for."} Each one mints its own hour-long, one-repo keys.</p>
  ${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ""}
  ${created}
  ${list}
  <h2>New agent</h2>
  ${newAgent}
  ${usageSection(opts.usage ?? null)}
  ${loginsSection(opts.logins)}`,
  );
}

function shell(title: string, account: Account, body: string): string {
  return page({
    title,
    noindex: true,
    css: UI_CSS,
    body: `<main class="wrap">
  <div class="nav"><a class="wm" href="/">githug</a><span class="who">signed in as <b>${escapeHtml(account.actor ?? account.login)}</b><a href="/docs">docs</a><a href="/logout">log out</a></span></div>
  ${body}
</main>`,
  });
}

/** A bearer key, shown once, with a copy button. */
function keyBox(key: string): string {
  return `<pre id="newkey">export GITHUG_AGENT_KEY=${escapeHtml(key)}</pre>
<button class="btn" type="button" onclick="navigator.clipboard.writeText(document.getElementById('newkey').textContent).then(()=>{this.textContent='copied'})">copy</button>
<p class="hint">Then <code>eval "$(hug env)"</code> before each push. <a href="/docs">Quickstart</a></p>`;
}

function utc(iso: string | null): string {
  return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "never";
}

function loginsSection(logins: CliLogin[]): string {
  if (!logins.length) return "";
  const rows = logins
    .map(
      (l) => `<li><span>${escapeHtml(l.name || "hug")} <span class="meta">logged in ${utc(l.created)} · last used ${utc(l.last_used)}</span></span>
<form class="inline" method="post" action="/app/logins/${escapeHtml(l.id)}/revoke"><button class="btn" type="submit">revoke</button></form></li>`,
    )
    .join("");
  return `<h2>CLI logins</h2><p class="hint" style="margin:0 0 12px">Machines where <code>hug</code> is logged in to your account.</p><ul class="agents">${rows}</ul>`;
}

export interface AgentPageOpts {
  runs: RunLog[];
  identity?: { slug: string; installed: boolean; settingsUrl: string; installUrl: string } | null;
  identityFailed?: boolean;
  /** Set right after a rotation: the new key, shown exactly once. */
  rotatedKey?: string;
  /** Sub-agents the rotation disabled (they may have been made with the old key). */
  disabledChildren?: number;
}

export function agentPage(account: Account, agent: AgentRow, opts: AgentPageOpts): string {
  const rotated = opts.rotatedKey
    ? `<div class="key"><b>New key for ${escapeHtml(agent.id)}.</b> The old key stopped working. Shown once:
${keyBox(opts.rotatedKey)}${opts.disabledChildren ? `<p class="hint">Also disabled its ${opts.disabledChildren} sub-agent${opts.disabledChildren === 1 ? "" : "s"}: anyone with the old key could have made them. Re-enable the ones you trust.</p>` : ""}</div>`
    : "";
  const runs = opts.runs.length
    ? `<ul class="agents">${opts.runs
        .map(
          (r) => `<li><span class="id">${escapeHtml(r.run)}</span><span class="meta">${r.mints} key${r.mints === 1 ? "" : "s"} · ${escapeHtml(r.repos)} · ${utc(r.first)} → ${utc(r.last).slice(11)}</span></li>`,
        )
        .join("")}</ul>`
    : `<p class="empty">No keys minted in the last 30 days.</p>`;
  const action = agent.disabled ? "enable" : "disable";
  return shell(
    `githug · ${agent.id}`,
    account,
    `<p class="hint" style="margin:0 0 16px"><a href="/app">← your agents</a></p>
  <h1>${escapeHtml(agent.id)}${agent.disabled ? ` <span class="off">disabled</span>` : ""}</h1>
  <p class="lede">${agent.parent ? `sub-agent of <a href="/app/agents/${encodeURIComponent(agent.parent)}">${escapeHtml(agent.parent)}</a> · ` : ""}${escapeHtml(agent.repos.join(", "))} · author ${escapeHtml(agent.email)} · last used ${utc(agent.last_used)}</p>
  ${rotated}
  <form class="inline" method="post" action="/app/agents/${encodeURIComponent(agent.id)}/rotate"><button class="btn" type="submit">Rotate key</button></form>
  <form class="inline" method="post" action="/app/agents/${encodeURIComponent(agent.id)}/${action}"><button class="btn" type="submit">${action}</button></form>
  <h2>Your contribution graph</h2>
  <p class="lede" style="margin:0 0 12px">${agent.credit_human
    ? `On: ${escapeHtml(agent.id)}'s commits add <code>Co-authored-by</code> for you, so GitHub counts them on your graph.`
    : `Off: ${escapeHtml(agent.id)}'s commits stay off your graph. The <code>Accountable:</code> trailer still names you.`}</p>
  <form class="inline" method="post" action="/app/agents/${encodeURIComponent(agent.id)}/credit"><input type="hidden" name="on" value="${agent.credit_human ? "0" : "1"}"><button class="btn" type="submit">${agent.credit_human ? "Keep them off my graph" : "Count them on my graph"}</button></form>
  <h2>GitHub Actions workflows</h2>
  ${agent.permissions?.workflows === "write"
    ? `<p class="lede" style="margin:0 0 12px">On: ${escapeHtml(agent.id)} can change files in <code>.github/workflows</code>.</p>
  <form class="inline" method="post" action="/app/agents/${encodeURIComponent(agent.id)}/workflows"><input type="hidden" name="on" value="0"><button class="btn" type="submit">Stop allowing workflow changes</button></form>`
    : `<p class="lede" style="margin:0 0 12px">Off: GitHub refuses any push from ${escapeHtml(agent.id)} that changes <code>.github/workflows</code>. Workflows run with your repo's secrets, so allow this only for agents you trust. The agent's GitHub App also needs the <b>Workflows: Read and write</b> permission.</p>
  <form class="inline" method="post" action="/app/agents/${encodeURIComponent(agent.id)}/workflows"><input type="hidden" name="on" value="1"><button class="btn" type="submit">Allow workflow changes</button></form>`}
  <h2>GitHub identity</h2>
  ${identitySection(agent, opts)}
  <h2>Key log by run · last 30 days</h2>
  ${runs}`,
  );
}

function identitySection(agent: AgentRow, opts: AgentPageOpts): string {
  const id = opts.identity;
  const failed = opts.identityFailed ? `<p class="err">GitHub didn't confirm the install. Try installing again.</p>` : "";
  if (!id)
    return `${failed}<p class="lede" style="margin:0 0 12px">Commits and PRs show as the shared App&#39;s bot today. Give ${escapeHtml(agent.id)} its own name, avatar and rate limits on GitHub: two clicks.</p>
  <a class="btn go" href="/app/agents/${encodeURIComponent(agent.id)}/identity">Create ${escapeHtml(agent.id)}'s identity</a>`;
  if (!id.installed)
    return `${failed}<p class="lede" style="margin:0 0 12px"><code>${escapeHtml(id.slug)}[bot]</code> exists but isn't installed yet.</p>
  <a class="btn go" href="${escapeHtml(id.installUrl)}">Install it on GitHub</a>`;
  return `<p class="lede" style="margin:0 0 12px">Acts as <span class="id">${escapeHtml(id.slug)}[bot]</span> on GitHub. <a href="${escapeHtml(id.settingsUrl)}">Upload an avatar</a> on its GitHub settings page.</p>`;
}

/** Shadow billing (M3.1): what this month would cost on the planned pricing. Nothing is charged. */
function usageSection(u: MonthUsage | null): string {
  if (!u) return "";
  const monthName = new Date(`${u.month}-01T00:00:00Z`).toLocaleString("en", { month: "long", timeZone: "UTC" });
  const head = u.plan
    ? `On the planned pricing, ${monthName} would cost <b>$${u.cost}</b> (${u.plan === "solo" ? "Solo" : "Team"}): ${u.billable} private agent-repo grant${u.billable === 1 ? "" : "s"} in use. You pay nothing during the beta, and keep this price after.`
    : `Nothing billable in ${monthName}: no private repos in use. Public repos stay free.`;
  const rows = u.grants
    .map((g) => `<li><span><span class="id">${escapeHtml(g.agent)}</span> <span class="meta">× ${escapeHtml(g.repo)}</span></span><span class="meta">${g.private === true ? "private · billable" : g.private === false ? "public · free" : "no access · not counted"} · ${g.mints} key${g.mints === 1 ? "" : "s"}</span></li>`)
    .join("");
  return `<h2>Plan · free during the beta</h2>
  <p class="lede" style="margin:0 0 12px">${head}</p>
  ${rows ? `<ul class="agents">${rows}</ul>` : ""}
  <p class="hint">A grant is an agent and a private repo it used this month; sub-agents count under their parent. Solo $5 includes 5, Team $25 includes 25, then $1 each. <a href="/pricing.md">Pricing</a></p>`;
}
