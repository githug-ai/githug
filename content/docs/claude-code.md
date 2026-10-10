# githug with Claude Code

## Set it up

Paste this to Claude Code, with your repo:

```text
Set up githug for owner/repo: run `curl -fsSL https://githug.ai/install | sh`,
then `hug init --repo owner/repo --json`. When it prints a device_code or
install_required event, show me the message and wait for it to finish.
```

Claude Code shows you a code. Open the link, enter the code, and approve. If githug isn't installed on the repo yet, it shows you the install link too. When `hug init` prints `ready`, the agent exists, its key is saved on this machine, and (in a clone of the repo) git is set up to push as it.

## Tell it how to open PRs

Run the setup prompt from inside a clone and `git commit` / `git push` already work as the agent (if you ran it elsewhere, run `hug setup` in the clone). Add this to the repo's `CLAUDE.md`:

```markdown
## githug
- Commit and push as usual; githug signs you in as the agent. Push to a branch, never main.
- Group a task's work under one run: `hug run -- <command>`.
- Open PRs with `hug pr create --title "<title>" --body "<body>"` (not `gh pr create`).
```

## Check it

Every PR opened with `hug pr create` ends with a verify link. Or paste any commit or PR link at [githug.ai/v](/v): a commit pushed this way shows **Verified agent commit** (hug attests it with the agent's key as it pushes), with you as the accountable human.
