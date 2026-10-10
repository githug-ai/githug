-- M1.5 (ROADMAP Track B): account API keys for the `hug` CLI. `hug init` runs GitHub's
-- device flow through githug; on approval the account gets a key (hug_…) that can create
-- and list its agents. Only the SHA-256 of the key is stored.
-- Apply with: wrangler d1 migrations apply githug --local / --remote
CREATE TABLE IF NOT EXISTS account_keys (
  key_hash   TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name       TEXT,  -- e.g. the hostname hug ran on
  created    TEXT,
  last_used  TEXT,
  disabled   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_account_keys_account ON account_keys (account_id);
