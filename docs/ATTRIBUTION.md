# Attribution is a chain

Design note for githug Gateway (Track B). Decided 2026-10-01: this is the core of the
product, not a feature of it. Status: design agreed, migration sketched (`0009`), not built.

## The problem

GitHub's identity model is flat: one actor slot per event. The truth of an agent-era
change is a chain:

```
accountable human ──▶ orchestrator agent ──▶ worker agent ──▶ run/session
   (ana)              (orbit)             (orbit-w3)       (transcript, budget)
```

B1.2 v0 stuffs that whole chain into one actor: every commit, PR and comment from every
agent shows up as `githug-gateway[bot]`. Two failures follow:

1. **The human loses credit.** Commits and PRs authored through the gateway never land on
   the accountable human's contribution graph, and PRs are "opened by a bot" — the exact
   complaint Copilot users file and GitHub won't fix (community discussion #179983).
2. **The agents lose identity.** A six-agent fleet is indistinguishable in the GitHub UI.
   Per-agent identity was the pitch; the app flattened it.

## The model

Stop cramming the chain into one slot. Decide **per surface** which link occupies
GitHub's native actor slot, and make the gateway the system of record for the full chain.

| Surface | GitHub's one slot goes to | The rest of the chain |
|---|---|---|
| PR open / comments / reviews | **The human** — user-to-server OAuth token. GitHub renders "ana opened this **via githug Gateway**" and the PR counts as ana's contribution | Agent + run in a PR-body footer and a per-agent check run |
| Commit author | **The agent** — git author is free-form: `orbit <orbit@agents.githug.ai>`. Fleet commits stop being a wall of one bot | `Co-authored-by: <human>` (lands on their graph), `Accountable:`, `Agent-Chain:`, session trailers |
| Checks / statuses | **The gateway app** — one check run *named per agent*: `orbit: policy ✓ · transcript` | Links to the chain page |
| Chain of custody | **The gateway DB** — a chain page per action: launcher → orchestrator → worker → run → budget | The thing no forge stores at all |

### Invariants (what makes the chain honest)

The chain is **derived from credential lineage, not self-reported**:

- Every agent is minted *by* someone: a human (root, via the dashboard) or another agent
  (via the API, authenticated with the parent's key). `gateway_agents.parent` records it.
- `accountable` is **inherited from the root at mint time**, never supplied by a child.
  A worker agent cannot claim a different human than the orchestrator that spawned it.
- A child's permission subset and repo allowlist must be **⊆ the parent's**. Depth-capped
  (default 3) so a chain stays legible.
- **Revocation cascades**: disabling an agent disables every descendant; tokens already
  minted expire within the hour (existing 1h TTL).
- Every token mint records `minted_by` — so "who did this, launched by whom, on whose
  authority" is a join on `gateway_tokens` + `gateway_actions`, not forensics on trailers.
- Later (B1.3): the gateway signs each commit it relays (keyless/sigstore, agent identity
  in the cert SAN), making the chain verifiable outside the gateway too.

### The rate-limit split is a feature

User-to-server actions bill against the human's GitHub rate limit; git/data traffic bills
against per-agent installation tokens. That maps **"who gets credit" to "whose quota"** —
the accountability story and the rate-limit story become the same story. It also means a
runaway fleet exhausts its own budget, not the human's PR surface.

## What changes in B1

- **B1.2 v1**: add `gateway_users` (GitHub OAuth, user-to-server grant) + chain columns
  (`parent`, `email`, `depth`, `minted_by`) — migration `0009`. PR-surface calls go
  through the user token; git pushes keep per-agent installation tokens. Commit author
  becomes the agent's own name/email instead of the bot.
- **B1.3** gains its join target: `gateway_actions`, one row per attributable action with
  the materialized chain. The provenance index parses trailers *into* it.
- **B1.7** (review page) becomes the **chain page**: `/gateway/c/<sha>` showing the full
  chain, policy result, session link, budget — the artifact a buyer can show an auditor.
