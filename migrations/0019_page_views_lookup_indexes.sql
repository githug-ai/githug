-- Indexes for the per-view bot checks: the sweep check looks views up by user_agent and the
-- fan-out check by page id, each within a recent window. Without these every check scanned
-- the whole table; on 2026-10-18 a ~500-view crawl read ~16M rows and hit D1's daily limit.
-- Apply with: wrangler d1 migrations apply githug --local / --remote
CREATE INDEX IF NOT EXISTS idx_page_views_ua_created ON page_views (user_agent, created);
CREATE INDEX IF NOT EXISTS idx_page_views_id_created ON page_views (id, created);
