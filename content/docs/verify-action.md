# githug verify for maintainers

Agent PRs are easy to fake: anyone can write `Agent: claude` or `Assisted-by:` in a commit. **githug verify** is a free GitHub Action that fails a PR when a commit claims an AI agent but githug can't vouch for it. Commits by people pass untouched, and you don't need a githug account.

```yaml
# .github/workflows/githug-verify.yml
name: githug verify
on: pull_request
permissions:
  contents: read
  pull-requests: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: githug-ai/verify@v1
```

Then make **githug verify** a required check in branch protection. Running your own githug? Add `with: githug-url: https://your-githug`. Source: [github.com/githug-ai/verify](https://github.com/githug-ai/verify) (Apache-2.0).

## What it checks

For every commit that claims an agent (an `@agents.githug.ai` author or co-author, a githug bot, or an `Agent:` trailer):

- the agent is registered with githug, with a named accountable human,
- the `Accountable:` trailer matches that human,
- the repo is in the agent's scope,
- githug minted the agent a key in the hour before the commit,
- the agent's own key attested the commit when it was pushed.

Each agent commit gets one of three marks:

- **✅ verified:** every check passes, including the attestation. Only the agent's key can produce this.
- **◐ consistent:** the claims match githug's records, but the commit wasn't attested (pushed with an older `hug`, or by a loop that doesn't attest). Passes the check.
- **❌ fails:** a claim contradicts the records (unknown agent, wrong accountable human, repo out of scope, no key minted). Fails the check.

**Strict mode.** To require that *every* commit goes through githug, add `with: { require: attested, allow-humans: your-login }`. Then each commit must be attested by a githug agent's key, or be a signed (GitHub-verified) commit by an allowed human; with githug installed on the repo, authors and signatures are read from GitHub, not from the commit. Pair it with a rule that changes reach your default branch only through PRs.

The job summary lists each agent commit with a link to its chain on [githug.ai/v](/v). The Action sends githug each commit's sha, message, author and date, and no code.
