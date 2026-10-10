-- Adds a per-view hashed client IP so bursts (one visitor hitting many distinct
-- /a/<id> pages within seconds) can be detected server-side and flagged as bot
-- traffic even when the UA string looks like a real browser. See looksLikeBot()
-- in src/worker.ts for the UA-only heuristic this complements; the burst check
-- lives in logPageView(). Apply with:
--   wrangler d1 migrations apply githug --local / --remote

ALTER TABLE page_views ADD COLUMN ip_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_page_views_ip_hash_created ON page_views (ip_hash, created);
