-- githug Gateway beta waitlist (Track B). Separate from `subscribers`
-- so the signal for the agent-gateway product line is not mixed into the Q&A list, and
-- so we can capture the qualifying fields the hero form asks for.
CREATE TABLE IF NOT EXISTS gateway_waitlist (
  email     TEXT,
  host      TEXT,   -- github | gitlab | gitea | other
  agents    TEXT,   -- 1 | 2-5 | 6+
  self_host INTEGER, -- 1 = wants the self-hosted container
  note      TEXT,
  ref       TEXT,   -- referring page path (which content converted)
  created   TEXT
);
