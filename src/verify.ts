/**
 * /v/<owner>/<repo>/<sha> — the public verify page (ROADMAP Track B, M1.9). Free for
 * maintainers: shows whether a commit was made by a githug agent, who is accountable,
 * and what githug's own records (agent registry, token log) say about it.
 */
import { escapeHtml } from "./render.js";
import { page, UI_CSS } from "./layout.js";
import type { VerifyResult, VerifyPullResult } from "./gateway-api.js";

const VERIFY_CSS = `
.verdict{font-size:22px;font-weight:600;margin:0 0 6px}
.verdict.ok{color:var(--green)}.verdict.partial{color:var(--coral-text)}.verdict.no{color:var(--mute)}
.commit{color:var(--mute);margin:0 0 28px;overflow-wrap:anywhere}
.commit a{color:var(--mute)}
.chain{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0 0 28px}
.chain dt{color:var(--mute)}.chain dd{margin:0}
.h{color:var(--coral-text)}.a{color:var(--green)}
.checks{list-style:none;padding:0;margin:0;border-top:1px solid var(--faint)}
.checks li{padding:10px 0;border-bottom:1px solid var(--faint);overflow-wrap:anywhere}
.checks .y{color:var(--green)}.checks .n{color:var(--coral-text)}
form.look{display:flex;gap:8px;flex-wrap:wrap}
form.look input{flex:1;min-width:0;font:inherit;font-size:13px;padding:6px 10px;border-radius:6px;border:1px solid var(--faint);background:var(--raise);color:var(--fg)}
.foot{color:var(--mute);font-size:12px;margin-top:40px}
.foot a{color:var(--mute)}
`;

function shell(title: string, body: string, noindex = false): string {
  return page({
    title,
    noindex,
    css: UI_CSS + VERIFY_CSS,
    beaconPath: "/v",
    body: `<main class="wrap">
  <div class="nav"><a class="wm" href="/">githug</a><span class="who">verify</span></div>
  ${body}
  <p class="foot">githug checks a commit against its own records: the agent registry and the log of every key it minted. <a href="/">What is githug?</a></p>
</main>`,
  });
}

const LOOKUP = `<form class="look" method="get" action="/v"><label class="sr" for="v-url">Commit URL</label><input id="v-url" name="url" placeholder="https://github.com/owner/repo/commit/sha" required><button class="btn go" type="submit">Verify</button></form>`;

export function verifyIndexPage(error?: string): string {
  return shell(
    "Verify an agent commit · githug",
    `<h1>Who is accountable for this commit?</h1>
  <p class="lede">Paste a GitHub commit link. githug shows which agent made it, the human accountable for it, and whether its key came from githug.</p>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
  ${LOOKUP}`,
  );
}

export function verifyPage(repo: string, sha: string, r: VerifyResult): string {
  const short = sha.slice(0, 7);
  if (r.kind !== "commit") {
    const msg = {
      not_installed: `githug isn't installed on ${repo}, so there is nothing to check.`,
      private: `${repo} is private. Its owner can see the chain for this commit in their githug dashboard.`,
      not_found: `No commit ${short} in ${repo}.`,
    }[r.kind];
    return shell(`${repo}@${short} · githug verify`, `<h1>Nothing to verify</h1><p class="lede">${escapeHtml(msg)}</p>${LOOKUP}`, true);
  }
  const head = {
    verified: `<p class="verdict ok">✓ Verified agent commit</p>`,
    consistent: `<p class="verdict partial">◐ Consistent with githug's records</p><p class="lede">The agent, scope and key log match, but the agent's key didn't attest this commit at push, so the claim isn't proven.</p>`,
    partial: `<p class="verdict partial">◑ Partly verified</p>`,
    not_githug: `<p class="verdict no">Not made through githug</p>`,
  }[r.verdict];
  const chain = r.agent
    ? `<dl class="chain"><dt>accountable</dt><dd class="h">${escapeHtml(r.accountable ?? "unknown")}</dd><dt>agent</dt><dd class="a">${escapeHtml(r.agent)}</dd>${r.run ? `<dt>run</dt><dd>${escapeHtml(r.run)}</dd>` : ""}<dt>commit</dt><dd>${escapeHtml(r.sha.slice(0, 12))} · ${escapeHtml(r.date.slice(0, 16).replace("T", " "))} UTC</dd></dl>`
    : "";
  const checks = `<ul class="checks">${r.checks.map((c) => `<li><span class="${c.ok ? "y" : "n"}">${c.ok ? "✓" : "✗"}</span> ${escapeHtml(c.label)}</li>`).join("")}</ul>`;
  return shell(
    `${r.verdict === "verified" ? "✓ " : ""}${r.repo}@${short} · githug verify`,
    `${head}<p class="commit"><a href="https://github.com/${escapeHtml(r.repo)}/commit/${escapeHtml(r.sha)}">${escapeHtml(r.repo)}@${escapeHtml(short)}</a> · ${escapeHtml(r.title)}</p>${chain}${checks}`,
    r.verdict !== "verified",
  );
}

export function verifyPullPage(repo: string, number: number, r: VerifyPullResult): string {
  if (r.kind !== "pull") {
    const msg = {
      not_installed: `githug isn't installed on ${repo}, so there is nothing to check.`,
      private: `${repo} is private. Its owner can see the chain for this pull request in their githug dashboard.`,
      not_found: `No pull request #${number} in ${repo}.`,
    }[r.kind];
    return shell(`${repo}#${number} · githug verify`, `<h1>Nothing to verify</h1><p class="lede">${escapeHtml(msg)}</p>${LOOKUP}`, true);
  }
  const head = {
    verified: `<p class="verdict ok">✓ Every commit verified</p>`,
    consistent: `<p class="verdict partial">◐ Consistent with githug's records</p><p class="lede">Every agent commit matches githug's records; not all were attested by the agent's key at push.</p>`,
    partial: `<p class="verdict partial">◑ Partly verified</p>`,
    not_githug: `<p class="verdict no">Not made through githug</p>`,
  }[r.verdict];
  const state = r.merged ? "merged" : r.state;
  const chain = r.agents.length
    ? `<dl class="chain"><dt>accountable</dt><dd class="h">${escapeHtml(r.accountable.join(", ") || "unknown")}</dd><dt>agent</dt><dd class="a">${escapeHtml(r.agents.join(", "))}</dd><dt>pull request</dt><dd>#${r.number} · ${escapeHtml(state)} · ${r.commits.length} commit${r.commits.length === 1 ? "" : "s"}</dd></dl>`
    : "";
  const mark = { verified: `<span class="y">✓</span>`, consistent: `<span class="n">◐</span>`, partial: `<span class="n">◑</span>`, not_githug: `<span class="n">·</span>` };
  const rows = r.commits
    .map((c) => `<li>${mark[c.verdict]} <a href="/v/${escapeHtml(r.repo)}/${escapeHtml(c.sha)}">${escapeHtml(c.sha.slice(0, 7))}</a> ${escapeHtml(c.title)}${c.agent ? ` <span class="a">· ${escapeHtml(c.agent)}</span>` : ""}</li>`)
    .join("");
  return shell(
    `${r.verdict === "verified" ? "✓ " : ""}${r.repo}#${r.number} · githug verify`,
    `${head}<p class="commit"><a href="https://github.com/${escapeHtml(r.repo)}/pull/${r.number}">${escapeHtml(r.repo)}#${r.number}</a> · ${escapeHtml(r.title)}</p>${chain}<ul class="checks">${rows}</ul>`,
    r.verdict !== "verified",
  );
}
