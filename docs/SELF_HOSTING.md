# Self-hosting githug

Run your own githug: same code as githug.ai, every feature, no billing, single-tenant. Two
ways:

| | One container | Your Cloudflare account |
|---|---|---|
| Runs on | any Docker host (Node 24 inside) | Workers + D1 + KV + R2 |
| Data | one SQLite file in a volume | D1 |
| Start | `docker run` | `scripts/self-host.sh` |
| Cost | your server | the Workers free plan covers small teams |

Either way you finish in the browser: one click creates your instance's GitHub App.

## What you need

- A public HTTPS URL for the instance (GitHub redirects people to it during sign-in).
- A GitHub account or org to own the instance's GitHub App.

## Option 1: one container

```sh
docker run -d --name githug -p 8080:8080 -v githug:/data \
  -e GITHUG_ORIGIN=https://githug.example.com \
  -e GITHUG_TRUST_PROXY=1 \
  ghcr.io/githug-ai/githug:0.1.0
```

Pin a version (tags match [releases](https://github.com/githug-ai/githug/releases)) and upgrade
when you choose; `:latest` follows main.

Or `docker compose up -d` with [`docker-compose.yml`](../docker-compose.yml). Build it
yourself with `docker build -t githug .`.

Put it behind your TLS proxy (Caddy, Traefik, nginx) and set `GITHUG_TRUST_PROXY=1` so rate
limits see real client IPs (from `X-Forwarded-For`). Without a proxy, leave it unset.

On first start the container creates its schema and two secrets in `/data`:

| File | What it is |
|---|---|
| `githug.db` | everything githug stores (SQLite, WAL) |
| `enc.key` | `GATEWAY_ENC_KEY`: encrypts GitHub grants and the App's private key at rest |
| `setup.pass` | the password for the setup page (user `admin`) |

Back up the whole volume; **`githug.db` is useless without `enc.key`**. To manage secrets
yourself, pass `GATEWAY_ENC_KEY` / `STATS_PASSWORD` as env vars and the files aren't created.

## Option 2: your Cloudflare account

```sh
git clone https://github.com/githug-ai/githug && cd githug
npx wrangler login
scripts/self-host.sh --domain githug.example.com   # or omit --domain for *.workers.dev
```

The script creates (or reuses) a D1 database, two KV namespaces and an R2 bucket, writes
`wrangler.self.jsonc`, applies migrations, sets generated secrets (also saved to
`.selfhost.env`, mode 0600), deploys, and prints the setup URL. Re-running it is safe;
`--dry-run` checks the config and bundle without touching your account.

Cron note: the Workers free plan allows 5 cron triggers per account. If they're used up,
githug still works; only the scheduled scope re-check and PR-outcome sync don't run.

## Finish setup in the browser

1. Open `https://<your-instance>/gateway/setup/github-app` and log in as `admin` with the
   setup password. Add `?org=<your-org>` to create the App under an organization.
2. Click **Create GitHub App** on GitHub. You land back on your instance; the App's ID,
   private key and OAuth credentials are saved, encrypted, in your database.
3. In the App's settings on GitHub, tick **Enable Device Flow** (the `hug login` CLI flow
   needs it; GitHub doesn't let manifests set it).
4. Sign in at `/login`. The first admin is `GITHUG_ADMIN` if set, otherwise whoever created
   the App (when it's owned by a user, not an org).
5. From the dashboard, install the App on your repos and create an agent.

Settings saved this way can take up to a minute to reach every Worker isolate. Env vars or
secrets with the same names always win.

## Who can sign in

A self-hosted instance is single-tenant. People get in by:

- **the admin's list:** `/admin` → add a GitHub login;
- **`GITHUG_ALLOW`:** comma-separated GitHub logins, or orgs; anyone who can push to a repo
  in one of your App's installations on a listed org joins on first sign-in;
- **`GITHUG_ADMIN`:** the instance admin's login.

Everyone else is refused at sign-in, including the CLI's device login.

## Connect agents

```sh
curl -fsSL https://<your-instance>/install | sh       # installs the official hug binary
hug init --repo owner/repo --url https://<your-instance>
```

`--url` is saved in hug's config; `GITHUG_URL` overrides it per process. Agent commits use
`<agent>@agents.<your-host>` unless you set `GITHUG_AGENT_DOMAIN`.

The verify Action takes `githug-url: https://<your-instance>`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GITHUG_ORIGIN` | the request's origin | Public URL, used in GitHub redirects, docs and PR footers. Set it. |
| `GITHUG_MODE` | `self-hosted` in the container | `hosted` is githug.ai's mode (marketing pages, billing) |
| `GITHUG_ADMIN` | the App's creator | Instance admin's GitHub login |
| `GITHUG_ALLOW` | empty | Logins/orgs that may sign in (see above) |
| `GITHUG_AGENT_DOMAIN` | `agents.<host>` | Domain of agent commit emails |
| `GITHUG_BRAND` | `githug` | Suffix of agent App names (`<agent>-<brand>`) and PR footers |
| `GITHUG_DL_ORIGIN` | `https://githug.ai` | Where `/install` downloads hug binaries |
| `GATEWAY_ENC_KEY` | generated (container) | 32 bytes, base64 |
| `IP_HASH_SALT` | `GATEWAY_ENC_KEY` | Keys the hash of requester IPs in the audit log |
| `STATS_USER` / `STATS_PASSWORD` | `admin` / generated | The App setup page |
| `ADMIN_TOKEN` | unset (admin API off) | Bearer token for the admin API. It is the operator's root key: `POST /v1/agents` with it takes any permission map and skips the check that the human can push to the repos. GitHub still limits what the App can mint |
| `PORT` · `GITHUG_DATA` · `GITHUG_TRUST_PROXY` · `GITHUG_CRON_MINUTES` | `8080` · `/data` · off · `240` | Container only |

The GitHub App can also be given entirely by env (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`
as PKCS#8 PEM, `GITHUB_APP_SLUG`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`).

## Upgrading

- Container: change the tag to the new version, pull and restart; migrations apply on start.
  Read the release notes first.
- Cloudflare: `git pull && scripts/self-host.sh` (applies migrations, redeploys).

## Not included

Shadow billing (what an account would pay on githug.ai's plans) is off in self-hosted mode.
githug.ai's own website (landing, blog, reference pages) isn't part of this repository.
