-- githug Gateway v0: agents as principals. An agent holds a key (stored hashed) that
-- the gateway exchanges for a short-lived GitHub App installation token scoped to the
-- agent's repo allowlist. Every issuance is logged — this is the audit trail the remote
-- itself never had.
CREATE TABLE IF NOT EXISTS gateway_agents (
  id          TEXT PRIMARY KEY,   -- short public id, e.g. "orbit-a1"
  name        TEXT,               -- display name used as the commit author name
  key_hash    TEXT UNIQUE,        -- sha256 of the bearer key; the key itself is shown once
  repos       TEXT,               -- JSON array of "owner/repo" the agent may mint tokens for
  accountable TEXT,               -- the human on the hook (goes into the Accountable: trailer)
  created     TEXT,
  disabled    INTEGER DEFAULT 0,
  last_used   TEXT
);

CREATE TABLE IF NOT EXISTS gateway_tokens (
  agent_id        TEXT,
  repo            TEXT,
  installation_id INTEGER,
  issued          TEXT,
  expires         TEXT,
  ip_hash         TEXT
);
CREATE INDEX IF NOT EXISTS gateway_tokens_agent ON gateway_tokens (agent_id, issued);
