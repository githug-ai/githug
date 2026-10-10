# Security policy

githug issues credentials that can write to people's repositories, so we take reports
seriously and answer quickly.

## Report a vulnerability

Please **don't open a public issue.** Use GitHub's private reporting:
[Report a vulnerability](https://github.com/githug-ai/githug/security/advisories/new). If you
can't use that, email hello@githug.ai with "security" in the subject.

Include what you found, how to reproduce it, and the impact you think it has. We'll
acknowledge within 3 days and keep you posted until it's fixed. With your permission, we
credit you in the advisory.

## Scope

- This repository: the githug service (githug.ai and self-hosted instances).
- The `hug` CLI ([githug-ai/hug](https://github.com/githug-ai/hug)) and the verify Action
  ([githug-ai/verify](https://github.com/githug-ai/verify)): report in those repositories.

Especially interesting: anything that mints a token for a repo or with permissions an agent
shouldn't have, lets one account see or manage another's agents, signs someone in as
someone else, or makes a commit show as verified when the agent's key didn't attest it.

Please don't test against other people's accounts or repositories, and don't run load tests
against githug.ai. A self-hosted instance (docs/SELF_HOSTING.md) is the best place to poke.

## Supported versions

githug.ai always runs the latest `main`. For self-hosted instances, fixes land on `main`
and in the next container image; upgrade to get them.
