-- Intent CTA clicks (what users want to DO with an answer). Apply with:
--   wrangler d1 migrations apply githug --local / --remote

CREATE TABLE IF NOT EXISTS intents (
  intent   TEXT,
  note     TEXT,
  question TEXT,
  created  TEXT
);
CREATE INDEX IF NOT EXISTS idx_intents_created ON intents (created);
