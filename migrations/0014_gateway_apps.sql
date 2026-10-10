-- M2.1 (ROADMAP Track B): named identities. Each agent may get its own GitHub App
-- (created from a githug-prefilled manifest, installed by its human), so its commits and
-- PRs show as <slug>[bot] with its own avatar and rate limits. The shared githug Gateway
-- App stays the fallback for agents without one.
-- Apply with: wrangler d1 migrations apply githug --local / --remote
CREATE TABLE IF NOT EXISTS gateway_apps (
  agent_id        TEXT PRIMARY KEY,
  app_id          INTEGER NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  owner_login     TEXT,     -- user or org that owns the App
  owner_type      TEXT,     -- 'User' | 'Organization'
  private_key     TEXT NOT NULL, -- PKCS#8 PEM, encrypted with GATEWAY_ENC_KEY
  bot_id          INTEGER,  -- the <slug>[bot] user id (commit email <bot_id>+<slug>[bot]@users.noreply.github.com)
  installation_id INTEGER,  -- set once the human installs it
  created         TEXT
);
