-- Attribution chain (docs/ATTRIBUTION.md). Three moves:
--   1. humans become principals (gateway_users) so PR-surface actions can run as the
--      human via a user-to-server OAuth token ("ana opened this via githug Gateway"),
--   2. agents form a lineage (parent/depth/minted_by) so the chain is derived from
--      credentials, not self-reported trailers,
--   3. every attributable action lands in gateway_actions with the chain materialized,
--      which is what the chain page (/gateway/c/<sha>) and the provenance index join on.
-- Apply with: wrangler d1 migrations apply githug --local / --remote

-- 1. Humans. oauth_* hold the GitHub user-to-server grant, encrypted at the app layer
--    with a key from Workers secrets (never stored plaintext in D1).
CREATE TABLE IF NOT EXISTS gateway_users (
  login         TEXT PRIMARY KEY, -- GitHub login; gateway_agents.accountable references this
  github_id     INTEGER,          -- stable even if the login changes
  email         TEXT,             -- the email GitHub credits contributions to (Co-authored-by)
  oauth_token   TEXT,             -- encrypted user-to-server access token
  oauth_refresh TEXT,             -- encrypted refresh token
  oauth_expires TEXT,
  created       TEXT
);

-- 2. Lineage. parent = gateway_agents.id of the minting agent (NULL = registered by the
--    accountable human, depth 0). Children inherit accountable from the root at mint
--    time and may only hold a permission/repo subset of the parent; disabling an agent
--    cascades to descendants (enforced in the app, walked via parent).
ALTER TABLE gateway_agents ADD COLUMN parent TEXT;
ALTER TABLE gateway_agents ADD COLUMN depth INTEGER DEFAULT 0; -- cap enforced in app (default max 3)
ALTER TABLE gateway_agents ADD COLUMN email TEXT;              -- git author email, e.g. orbit@agents.githug.ai

-- Who authenticated each token mint: 'user:<login>' or 'agent:<id>'. With parent above,
-- the full chain for any action is recoverable from credentials alone.
ALTER TABLE gateway_tokens ADD COLUMN minted_by TEXT;
ALTER TABLE gateway_tokens ADD COLUMN surface TEXT; -- 'git' | 'pr' | 'mcp'

-- 3. One row per attributable action; the join target for "who did this, launched by
--    whom, on whose authority".
CREATE TABLE IF NOT EXISTS gateway_actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo       TEXT,    -- "owner/repo"
  kind       TEXT,    -- push | pr_open | pr_comment | review | check | merge
  ref        TEXT,    -- commit sha, or PR number as text
  agent_id   TEXT,    -- acting agent (leaf of the chain); NULL for pure-human actions
  chain      TEXT,    -- materialized at action time: ["user:ana","agent:orbit","agent:orbit-w3"]
  run        TEXT,    -- caller-supplied loop/run id (matches gateway_tokens.run)
  session    TEXT,    -- transcript URL or hash, when provided
  trailers   TEXT,    -- parsed trailer JSON (Assisted-by, Co-authored-by, ... — B1.3)
  credential TEXT,    -- which slot occupied GitHub's actor: 'user' | 'installation'
  created    TEXT
);
CREATE INDEX IF NOT EXISTS idx_gateway_actions_ref ON gateway_actions (repo, ref);
CREATE INDEX IF NOT EXISTS idx_gateway_actions_agent ON gateway_actions (agent_id, created);
CREATE INDEX IF NOT EXISTS idx_gateway_actions_run ON gateway_actions (run);
