# githug from your own agent loop

No CLI needed: one HTTP call trades the agent's key for a 1-hour GitHub token on one repo.

## Get a key

Create the agent at [githug.ai/app](/app), or with `hug agent create my-agent --repo owner/repo`. The key starts with `ghg_` and is shown once.

## Mint a token

```sh
curl -s https://githug.ai/v1/token \
  -H "Authorization: Bearer $GITHUG_AGENT_KEY" \
  -d '{"repo":"owner/repo","run":"loop-0412"}'
```

```json
{
  "token": "ghs_…",
  "expires_at": "2026-10-09T21:12:09Z",
  "repo": "owner/repo",
  "run": "loop-0412",
  "agent": { "id": "my-agent", "name": "my-agent" },
  "accountable": "your-login",
  "author": { "name": "my-agent", "email": "my-agent@agents.githug.ai" },
  "trailers": ["Co-authored-by: …", "Accountable: your-login", "Agent: my-agent"]
}
```

- Use `token` for git over HTTPS (`x-access-token:<token>`) and the GitHub API. It can push branches and work issues and PRs; it can't change settings, and your branch protection still guards main.
- Commit as `author`, and end the message with `trailers`. `Co-authored-by` for you is only included if the agent has graph credit on (off by default), since GitHub counts co-authored commits on your contribution graph. `Accountable:` is always there.
- `run` is optional: any id for the loop iteration. Every key and commit with the same `run` is one run in the chain.
- Mint again when `expires_at` passes. Mints are free and logged.

Errors come back as `{"error": "…"}`: 401 bad key, 403 agent disabled or repo out of scope, 404 githug not installed on the repo.

## Attest what you push

Commit metadata is free text anyone can write, so githug only calls a commit **verified** when the agent's own key reported it. Before (or right after) each push, send the full SHAs of the commits you're pushing:

```sh
curl -s https://githug.ai/v1/commits \
  -H "Authorization: Bearer $GITHUG_AGENT_KEY" \
  -d '{"repo":"owner/repo","shas":["<40-char sha>","…"],"run":"loop-0412"}'
```

Up to 500 per call; repeats are ignored. Without it, the agent's commits show as *consistent* (their claims match githug's records) instead of *verified*, and they still pass the verify Action. `hug setup` does this for you with a pre-push hook; `hug attest` does it by hand.

## Open a PR

```sh
curl -s https://githug.ai/v1/pr \
  -H "Authorization: Bearer $GITHUG_AGENT_KEY" \
  -d '{"repo":"owner/repo","head":"agent/fix-123","base":"main","title":"Fix the thing","body":"…","run":"loop-0412"}'
```

githug opens it with the accountable human as author (falling back to the githug App if they haven't signed in to githug), adds a footer naming the agent and run, and returns `number`, `url`, `opened_as` and `verify_url`. Pass `"as": "agent"` to make the agent's bot the author instead, so the human can still approve it when branch protection requires a review, and `"labels": ["…"]` to label it.

## Sub-agents for your workers

An agent can create sub-agents with their own keys, for the workers it runs:

```sh
curl -s https://githug.ai/v1/agents/children \
  -H "Authorization: Bearer $GITHUG_AGENT_KEY" \
  -d '{"name":"w1"}'
```

The sub-agent is named `<agent>-w1` and has the same accountable human. Its repos and permissions are a subset of its parent's, and agents nest at most 3 deep. Its commits carry `Agent-Chain: <human> › <agent> › <agent>-w1`. Disabling an agent disables everything under it. With the CLI: `hug agent spawn w1 --env` prints the worker's `GITHUG_AGENT_KEY` export.
