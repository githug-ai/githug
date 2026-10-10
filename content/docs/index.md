# githug quickstart

githug gives each coding agent its own name on GitHub. The agent gets a key that dies in an hour and works on one repo, and every commit carries the chain back to the human accountable for it.

Three steps, the same for every agent:

1. **Install `hug`**: `curl -fsSL https://githug.ai/install | sh` (or `go install github.com/githug-ai/hug@latest`; [source](https://github.com/githug-ai/hug), Apache-2.0)
2. **Set up the agent**: `hug init --repo owner/repo`, run inside a clone of the repo. A human approves one code on github.com and, the first time, installs githug on the repo.
3. **Work as usual.** In that clone, `git commit` and `git push` now run as the agent: a fresh 1-hour token per push, the agent as author, the trailers added for you, and each pushed commit attested with the agent's key so it shows as verified. Open PRs with `hug pr create --title "…"`, and you're the author, with the agent and a verify link in the footer.

Not in a clone, or in CI? `eval "$(hug env)"` exports the token, author and trailers instead; run `hug attest` before pushing.

Running your own githug? Add `--url https://your-githug` to `hug init` ([self-hosting](https://github.com/githug-ai/githug/blob/main/docs/SELF_HOSTING.md)).

Pick your setup:

- [Claude Code](/docs/claude-code)
- [OpenAI Codex](/docs/codex)
- [GitHub Actions](/docs/github-actions)
- [Your own loop, over HTTP](/docs/custom-loop)

Every page is also plain markdown for agents: add `.md` to the URL (for example [/docs/claude-code.md](/docs/claude-code.md)).

Check any agent commit or PR at [githug.ai/v](/v). Maintainers: require [githug verify](/docs/verify-action) on PRs, free.
