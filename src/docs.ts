/**
 * /docs — quickstart (ROADMAP Track B, M1.7). One markdown source per page in content/docs,
 * served as HTML for people and as raw markdown at /docs/<slug>.md for agents.
 * To add a page: drop content/docs/<slug>.md, import it here, add it to DOCS.
 */
import { markdownToSafeHtml, escapeHtml } from "./render.js";
import { SITE_ORIGIN, AGENT_DOMAIN } from "./site.js";
import { page, UI_CSS } from "./layout.js";
import index from "../content/docs/index.md";
import claudeCode from "../content/docs/claude-code.md";
import codex from "../content/docs/codex.md";
import githubActions from "../content/docs/github-actions.md";
import customLoop from "../content/docs/custom-loop.md";
import verifyAction from "../content/docs/verify-action.md";

export const DOCS: Record<string, string> = {
  index,
  "claude-code": claudeCode,
  codex,
  "github-actions": githubActions,
  "custom-loop": customLoop,
  "verify-action": verifyAction,
};

const DOCS_CSS = `
.doc h1{font-size:22px}.doc h2{font-size:15px;margin:32px 0 10px}
.doc p,.doc li{line-height:1.7}.doc a{color:var(--green)}
.doc code{background:var(--raise);padding:1px 5px;border-radius:4px;font-size:13px}
.doc pre{background:var(--raise);border:1px solid var(--faint);border-radius:6px;padding:12px;overflow-x:auto}
.doc pre code{background:none;padding:0}
.raw{color:var(--mute);font-size:12px;margin-top:40px}.raw a{color:var(--mute)}
`;

/** A doc with this instance's origin and agent domain in place of githug.ai's. */
export function docSource(slug: string): string | null {
  const src = DOCS[slug];
  if (!src || SITE_ORIGIN === "https://githug.ai") return src ?? null;
  return src.replaceAll("agents.githug.ai", AGENT_DOMAIN).replaceAll("https://githug.ai", SITE_ORIGIN);
}

export function docsPage(slug: string): string | null {
  const src = docSource(slug);
  if (!src) return null;
  return markdownPage(src, slug === "index" ? "/docs/index.md" : `/docs/${slug}.md`);
}

/** Renders a markdown page in the docs layout; mdPath is where the raw markdown is served. */
export function markdownPage(src: string, mdPath: string): string {
  const title = /^#\s+(.+)$/m.exec(src)?.[1] ?? "githug docs";
  return page({
    title: `${title} · githug`,
    head: `<link rel="alternate" type="text/markdown" href="${mdPath}"/>\n`,
    css: UI_CSS + DOCS_CSS,
    beaconPath: mdPath.replace(/(\/index)?\.md$/, "") || "/docs",
    body: `<main class="wrap">
  <div class="nav"><a class="wm" href="/">githug</a><span class="who"><a href="/docs">docs</a><a href="/app">your agents</a></span></div>
  <article class="doc">${markdownToSafeHtml(src)}</article>
  <p class="raw">For agents: <a href="${mdPath}">${mdPath}</a></p>
</main>`,
  });
}
