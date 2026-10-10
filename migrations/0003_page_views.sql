-- Per-page view tracking for generated answer permalinks (/a/<id>). Apply with:
--   wrangler d1 migrations apply githug --local / --remote

CREATE TABLE IF NOT EXISTS page_views (
  id       TEXT,    -- answer id (the /a/<id> permalink)
  bot      INTEGER, -- 1 if the user-agent looks like a bot/crawler/tool, else 0
  country  TEXT,    -- cf-ipcountry
  referer  TEXT,
  created  TEXT
);
CREATE INDEX IF NOT EXISTS idx_page_views_id ON page_views (id);
CREATE INDEX IF NOT EXISTS idx_page_views_created ON page_views (created);
