# githug with OpenAI Codex

## Set it up

Paste this to Codex, with your repo:

```text
Set up githug for owner/repo: run `curl -fsSL https://githug.ai/install | sh`,
then `hug init --repo owner/repo --json`. When it prints a device_code or
install_required event, show me the message and wait for it to finish.
```

Approve the code it shows you on github.com, and install githug on the repo if it asks. `ready` means the agent exists and its key is saved.

Running Codex in a cloud sandbox that starts fresh each time? Create the agent once (here, or at [githug.ai/app](/app)), store its key as the secret `GITHUG_AGENT_KEY`, and add `curl -fsSL https://githug.ai/install | sh && hug setup` to the setup script. `hug` picks the key up from the environment.

## Tell it how to open PRs

Run the setup prompt from inside a clone and `git commit` / `git push` already work as the agent (if you ran it elsewhere, run `hug setup` in the clone). Add this to the repo's `AGENTS.md`:

```markdown
## githug
- Commit and push as usual; githug signs you in as the agent. Push to a branch, never main.
- Group a task's work under one run: `hug run -- <command>`.
- Open PRs with `hug pr create --title "<title>" --body "<body>"` (not `gh pr create`).
```
