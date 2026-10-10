-- Per-agent "graph credit": whether an agent's commits carry Co-authored-by for its
-- accountable human. GitHub counts co-authored commits on that person's contribution graph,
-- which people running persistent agents often don't want. The Accountable: trailer (which
-- GitHub doesn't count) is always added either way.
-- Off for new agents; agents that existed before this keep their behaviour (on).
-- Apply with: wrangler d1 migrations apply githug --local / --remote
ALTER TABLE gateway_agents ADD COLUMN credit_human INTEGER DEFAULT 0;
UPDATE gateway_agents SET credit_human = 1;
