-- M1.2/M1.3 (ROADMAP Track B): accounts own agents; installations are recorded per account.
-- Apply with: wrangler d1 migrations apply githug --local / --remote

-- Agents belong to an account. Backfill: the account whose login is the agent's
-- accountable human (agents created before accounts existed).
ALTER TABLE gateway_agents ADD COLUMN account_id TEXT;
UPDATE gateway_agents SET account_id = (SELECT id FROM accounts WHERE accounts.login = gateway_agents.accountable) WHERE account_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_gateway_agents_account ON gateway_agents (account_id);

-- Installations of the githug Gateway App that an account's human can see, synced from
-- GET /user/installations with their user-to-server token (never trusted from a query
-- param). An agent may only be created on repos inside one of these.
CREATE TABLE IF NOT EXISTS gateway_installations (
  installation_id INTEGER NOT NULL,
  account_id      TEXT NOT NULL,
  target_login    TEXT,  -- the user or org the App is installed on
  target_type     TEXT,  -- 'User' | 'Organization'
  synced          TEXT,
  PRIMARY KEY (installation_id, account_id)
);
