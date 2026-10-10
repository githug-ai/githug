-- M1.1/M1.2 (ROADMAP Track B): accounts own agents; sessions log humans into /app.
-- Apply with: wrangler d1 migrations apply githug --local / --remote

-- One account per GitHub user in M1 (orgs arrive with Team in M3). The id is keyed on the
-- numeric GitHub id so it survives a login rename; login is refreshed on every sign-in.
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY, -- 'gh:<github_id>'
  login       TEXT NOT NULL,    -- current GitHub login (= gateway_users.login)
  github_id   INTEGER UNIQUE,
  plan        TEXT DEFAULT 'free',
  created_via TEXT,             -- 'human' (web login) | 'agent' (hug init device flow) — M1.10 instrument
  created     TEXT
);

-- Web sessions. The cookie holds a random 32-byte id; only its SHA-256 is stored, so a
-- leaked table can't be replayed as cookies.
CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  user_agent TEXT,
  created    TEXT,
  expires    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id);
