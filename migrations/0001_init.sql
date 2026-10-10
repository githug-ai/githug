-- githug D1 schema. Apply with:
--   wrangler d1 migrations apply githug --local     (local dev)
--   wrangler d1 migrations apply githug --remote     (production)

CREATE TABLE IF NOT EXISTS questions (
  id          TEXT,
  question    TEXT,
  follow_up   INTEGER,
  turns       REAL,
  model       TEXT,
  tool_calls  INTEGER,
  answer_len  INTEGER,
  cached      INTEGER,
  created     TEXT
);
CREATE INDEX IF NOT EXISTS idx_questions_created ON questions (created);

CREATE TABLE IF NOT EXISTS feedback (
  rating   TEXT,
  id       TEXT,
  question TEXT,
  created  TEXT
);

CREATE TABLE IF NOT EXISTS subscribers (
  email   TEXT,
  source  TEXT,
  created  TEXT
);
