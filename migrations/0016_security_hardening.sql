-- Security hardening before open-sourcing (2026-10). See the Phase 1 security review.
-- Apply with: wrangler d1 migrations apply githug --local / --remote

-- The accountable human by GitHub id, not just login: logins can be renamed and re-claimed.
ALTER TABLE gateway_agents ADD COLUMN accountable_id INTEGER;
UPDATE gateway_agents SET accountable_id = (SELECT github_id FROM gateway_users u WHERE u.login = gateway_agents.accountable)
  WHERE accountable_id IS NULL;

-- Push attestations: `hug`'s pre-push hook reports each commit it pushes, authenticated by the
-- agent's own key. A commit is "verified" only with one; commit metadata alone can be forged.
CREATE TABLE IF NOT EXISTS gateway_commits (
  repo      TEXT NOT NULL, -- owner/repo, lowercased
  sha       TEXT NOT NULL, -- full 40-hex
  agent_id  TEXT NOT NULL,
  run       TEXT,
  attested  TEXT NOT NULL, -- server time
  ip_hash   TEXT,
  PRIMARY KEY (repo, sha, agent_id)
);

-- The account a named agent App (M2.1) is installed on; mints only go to that owner's repos.
ALTER TABLE gateway_apps ADD COLUMN installation_login TEXT;
