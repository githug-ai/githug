-- Capture the raw user-agent on each answer-page view so bot vs human can be
-- re-classified later. The boolean `bot` flag alone is lossy: a scraper sweep
-- with an unrecognized UA was logged as human and there was no way to audit it.
-- Apply with:
--   wrangler d1 migrations apply githug --local / --remote

ALTER TABLE page_views ADD COLUMN user_agent TEXT;
