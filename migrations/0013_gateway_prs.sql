-- M1.10 (ROADMAP Track B): PR outcomes per agent, the raw material for the Agent Merge
-- Index and the "do agent PRs get merged" signal. Filled by the cron (syncPrOutcomes),
-- which asks GitHub with the App's own installation tokens — no webhook needed.
-- Apply with: wrangler d1 migrations apply githug --local / --remote
CREATE TABLE IF NOT EXISTS gateway_prs (
  repo      TEXT NOT NULL,
  number    INTEGER NOT NULL,
  agent_id  TEXT,     -- matched from the PR's commit authors (<id>@agents.githug.ai or agent name on the App bot)
  state     TEXT,     -- open | closed
  merged    INTEGER DEFAULT 0,
  opened    TEXT,
  closed    TEXT,     -- closed_at (merge time when merged)
  synced    TEXT,
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS idx_gateway_prs_agent ON gateway_prs (agent_id, opened);
