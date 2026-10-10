-- M3.7 (ROADMAP Track B): GitHub organizations as accounts (Team). An org account owns
-- agents and gets one bill; each agent still names the human who created it as accountable.
-- Membership isn't stored as a grant: it's re-checked against GitHub with the signed-in
-- human's own token (the org's githug installation must be visible to them).
-- Apply with: wrangler d1 migrations apply githug --local / --remote
ALTER TABLE accounts ADD COLUMN kind TEXT DEFAULT 'user'; -- 'user' | 'org'
-- Which account a web session is acting as (NULL = the signed-in human's own).
ALTER TABLE sessions ADD COLUMN acting_account_id TEXT;
