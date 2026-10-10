-- Per-agent permission subset and run linkage.
--   permissions: JSON object of GitHub App permission → level, used to DOWNGRADE the
--                installation token below the app's own grant (e.g. orbit never gets
--                administration or workflows). NULL = the gateway default subset.
--   run:         caller-supplied loop/run id on each token request, so every action taken
--                with that token can be traced back to the run that did it.
ALTER TABLE gateway_agents ADD COLUMN permissions TEXT;
ALTER TABLE gateway_tokens ADD COLUMN run TEXT;
