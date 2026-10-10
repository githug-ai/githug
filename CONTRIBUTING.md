# Contributing to githug

Thanks for helping. Bug reports, docs fixes and PRs are all welcome.

## Before you start

- **Bugs:** open an issue with steps to reproduce (the template asks for what we need).
- **Features:** open an issue first for anything bigger than a small fix, so we can agree on
  the shape before you spend time on it.
- **Security issues:** don't open an issue. See [SECURITY.md](SECURITY.md).

## Develop

```sh
npm ci
npm test            # node:test: the real Worker on Node bindings, GitHub faked at fetch
npm run typecheck
```

Run it: `npm run cf:migrate:local && npm run cf:dev` (Workers runtime), or
`npm run build:node && GITHUG_DATA=./data npm run start:node` (the container's entry). See
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) to wire up a GitHub App for local testing.

## Style

- Match the code around you. TypeScript, dependency-light (`src/render.ts` is the model);
  server-rendered pages, no frontend framework. A new dependency needs a good reason.
- Anything that touches authorization (who may mint, create, see or manage what) comes with
  a test in `test/`. Schema changes are a new file in `migrations/`, never an edit.
- Comments say *why*, not what. Keep them short.
- User-facing text: plain, short sentences.

## Pull requests

- One change per PR, with a description of what and why.
- `npm test` and `npm run typecheck` pass (CI runs both).
- **CLA:** on your first PR a bot asks you to sign the [Contributor License Agreement](CLA.md)
  by leaving a comment. It's short: you keep your copyright and grant the project a license
  to use your contribution, including under other licenses later. That keeps the option of a
  commercial license (which funds the hosted service and this work) open without asking
  every contributor again.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
