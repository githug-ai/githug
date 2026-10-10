-- Self-hosting (docs/SELF_HOSTING.md): settings saved in-app and the single-tenant signup list.
-- Apply with: wrangler d1 migrations apply githug --local / --remote

-- The instance's GitHub App, saved by /gateway/setup/github-app so a self-host needs no
-- secret-setting step. Env vars (wrangler secrets) win when both exist. Secret values are
-- AES-GCM encrypted with GATEWAY_ENC_KEY.
CREATE TABLE IF NOT EXISTS instance_settings (
  key     TEXT PRIMARY KEY,
  value   TEXT NOT NULL,
  secret  INTEGER DEFAULT 0,
  updated TEXT
);

-- Self-hosted single-tenant mode: who may sign in. role 'admin' (first-run: GITHUG_ADMIN, or
-- whoever created the App) or 'member'. GITHUG_ALLOW (env) adds people on sign-in.
CREATE TABLE IF NOT EXISTS instance_users (
  login     TEXT PRIMARY KEY, -- lowercase
  github_id INTEGER,
  role      TEXT NOT NULL DEFAULT 'member',
  added_by  TEXT,
  created   TEXT
);
