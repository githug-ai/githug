# Agent guide — githug

githug gives AI coding agents their own GitHub identities: per-agent keys that mint 1-hour,
one-repo tokens, an accountable human per agent, and verifiable commits. It runs as a
Cloudflare Worker (githug.ai, or your own account) or as one Node container.

## Start here
- **Overview & layout:** [`README.md`](README.md)
- **Self-hosting & configuration:** [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md)
- **Attribution model (why the chain looks the way it does):** [`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md)
- **Contributing rules:** [`CONTRIBUTING.md`](CONTRIBUTING.md)

## Critical facts
- **Tests:** `npm test` runs the real Worker on Node bindings (`src/node/bindings.ts`) with
  GitHub faked at `fetch` (`test/helpers.ts`). Authorization changes need a test.
- **Typecheck:** `npm run typecheck` covers three tsconfigs (Node code, Worker, Node host).
- **Schema:** add `migrations/NNNN_*.sql`; never edit an applied migration's SQL.
- **Config:** instance-specific values come from `src/site.ts` (`SITE_ORIGIN`,
  `AGENT_DOMAIN`, `BRAND`, `SELF_HOSTED`, `MARKETING`). Don't hardcode githug.ai in product code.
- **Core only.** All routes live in `src/core.ts`; `src/worker.ts` serves it. githug.ai's
  website (landing, blog, reference pages, Q&A, analytics) lives in a private repo that wraps
  this app (`hooks.pageView` is its analytics hook) and isn't part of this codebase.
- **Secrets never go in git** (`.env`, `.dev.vars`, `.selfhost.env` are gitignored). CI runs gitleaks.

## We use githug here
This checkout commits through githug as the agent `claude` (`hug setup`): commit and push
normally and the author, trailers, 1-hour token and push attestation are handled. Don't use
`--no-verify`, don't override the git author. A new clone needs `hug init --repo githug-ai/githug` first.

`main` only changes through PRs, and **githug verify** runs in strict mode: every commit must
be attested by a githug agent or be a signed commit by a maintainer. So: work on a branch
named `agent/<topic>`, push it, open the PR with `hug pr create --title "…"` (not
`gh pr create`), and merge once the checks pass.

## Conventions
- Match existing code style; keep the dependency-light approach (see `src/render.ts`).
- Every HTML page goes through `page()` in `src/layout.ts` (head, fonts, brand tokens, beacon);
  pass only the title, the page's own CSS and its body. Don't write another `<!doctype html>`.
- Server-rendered pages; brand = Geist Mono, forest ground, green = agent, coral = human.

## githug.ai maintainers
The production runbook (deploy, secrets, DNS, D1 ops), roadmap, pricing and outreach live in
the private **githug-ai/ops** repo, checked out at `../githug-ops`. Read
`../githug-ops/docs/INFRA.md` before touching githug.ai infra, and keep it current after
infra changes. githug.ai deploys from the private site repo (`../githug-site`, core is its
submodule), never from here: merge to core's main, bump the submodule there, deploy there.
