# githug verify

A GitHub Action for maintainers: fail a pull request when a commit **claims an AI agent but nobody can vouch for it**.

Anyone can type `Agent: my-bot` or `Assisted-by:` into a commit. githug verify checks each commit that claims an agent against githug's records: the agent is registered, a named human is accountable for it, the repo is in its scope, githug minted it a key in the hour before the commit, and the agent's own key attested the commit when it was pushed. Commits by people pass untouched.

| mark | meaning | check |
|---|---|---|
| ✅ verified | every check passes, including the push attestation (only the agent's key can produce it) | passes |
| ◐ consistent | the claims match githug's records, but the commit wasn't attested at push | passes |
| ❌ | a claim contradicts the records | fails |

Free, no githug install or account needed on your repo.

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

Make **githug verify** a required status check in your branch protection to enforce it.

Each run writes a table to the job summary, with links to the full chain for every agent commit on [githug.ai/v](https://githug.ai/v).

## Inputs

| input | default | |
|---|---|---|
| `github-token` | `github.token` | reads the PR's commits |
| `pull-request` | the triggering PR | PR number |
| `githug-url` | `https://githug.ai` | API base; point it at a [self-hosted githug](https://github.com/githug-ai/githug/blob/main/docs/SELF_HOSTING.md) if you run one |
| `require` | `claims` | `claims`: only commits that claim an agent are checked. `attested`: **every** commit must be an attested githug agent commit, or a signed commit by someone in `allow-humans` (see below) |
| `allow-humans` | | with `require: attested`: GitHub logins whose signed (GitHub-verified) commits pass |
| `fail-on-error` | `false` | fail when githug is unreachable (by default it passes with a warning, so an outage never blocks your PRs) |

Outputs: `agent-commits`, `failing`.

## Strict mode: every commit through githug

```yaml
      - uses: githug-ai/verify@v1
        with:
          require: attested
          allow-humans: your-login
```

Every commit in the PR must then be pushed by a githug agent (attested with its key), or be a
signed commit by an allowed human. When githug is installed on the repo, it reads authors and
signatures from GitHub itself, so a spoofed author email doesn't pass. Make the check required
and only allow changes to your default branch through PRs.

## What gets sent

For each commit in the PR: its sha, message, author name and email, and author date. Nothing else; no code.

Apache-2.0.

Runs on its own PRs via .github/workflows/self-test.yml.
