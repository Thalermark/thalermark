# DEPLOYMENT.md — self-hosting Thalermark

How to run the community edition on your own infrastructure. The whole stack
comes up from a single Docker Compose file; this guide covers configuration,
the deployment options (storage, database, TLS), and day-2 operations.

The 5-line "just try it on localhost" version lives in the
[README](./README.md#self-host); start here when you're deploying for real.

---

## What you get

`docker/docker-compose.yml` brings up four services on one Docker network:

| Service | Image | Role |
|---|---|---|
| `postgres` | `pgvector/pgvector:pg17` | Database (Postgres 17 + pgvector), `postgres_data` volume |
| `api` | `ghcr.io/thalermark/thalermark-api` | Hono backend on `:3000`; runs migrations on boot; owns receipt storage (`storage_data` volume) |
| `web` | `ghcr.io/thalermark/thalermark-web` | SvelteKit (adapter-node) on `:3000` |
| `caddy` | `caddy:2` | TLS termination + same-origin routing; exposes `:80` / `:443` |

The `api` and `web` images are **prebuilt and published to GHCR** by CI; the prod
compose **pulls** them, so the deploy host never compiles anything. Pin
`THALERMARK_VERSION` in `.env` to a release tag (or commit SHA) for reproducible
deploys; left unset it tracks `latest`. To build from source instead (forking /
customizing), use `docker/docker-compose.dev.yml` — the only compose that builds.

Caddy is the only service with published ports. It routes `/api/*` → `api` and
everything else → `web`, so the browser only ever talks to your origin (no CORS
round-trip). The runtime is deliberately lean — **no headless browser / Chromium**
(invoices are a hosted web page + email + pay link, not a generated PDF), so the
api container is light.

---

## Prerequisites

- **Docker** with the Compose plugin (Docker Engine 24+ / Docker Desktop).
- A host with **ports 80 and 443** reachable from the public internet (for a
  real domain + automatic TLS). Localhost works with no public ports.
- A **domain name** pointed at the host (for production TLS).
- Optional, depending on which integrations you enable: an Anthropic/OpenAI key
  (AI), a Resend key or SMTP server (email), Stripe keys (card payments).

Everything else (Postgres, object storage, TLS) is provided by the compose
bundle out of the box.

---

## Quick start (localhost)

```bash
cp .env.example .env
# fill in the secrets — see "Production checklist" below
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

`up -d` pulls the published GHCR images on first run. Open <https://localhost>. On the default `localhost` host Caddy serves with its
internal CA, so the browser warns once — accept and proceed. Sign up to create
the first account (signup seeds an account + a default company + chart of
accounts).

> **Run Compose from the repo root and pass `--env-file .env`.** The build
> context and the api's `env_file` are relative to the compose file, but
> Compose's `${VAR}` interpolation (your domain, passwords) reads the env file
> from where you invoke it. `--env-file .env` makes that unambiguous — without
> it, interpolated values silently fall back to their insecure `thalermark`
> defaults once you customize them.

---

## Production checklist

For any internet-facing deploy, set these in `.env` before bringing the stack
up. They are the secrets and the hostname — nothing else is mandatory.

| Variable | What | How to generate |
|---|---|---|
| `THALERMARK_DOMAIN` | Your public hostname (drives TLS + cookie/redirect URLs) | e.g. `app.yourbiz.com` |
| `BETTER_AUTH_SECRET` | Signs sessions | `openssl rand -base64 32` |
| `POSTGRES_PASSWORD` | Bundled-Postgres superuser password | `openssl rand -hex 32` |
| `THALERMARK_APP_PASSWORD` | Password for the non-superuser `thalermark_app` DB role the api runs as | `openssl rand -hex 32` |
| `THALERMARK_PGBOSS_PASSWORD` | Password for the least-privilege `thalermark_pgboss` DB role the job runner uses | `openssl rand -hex 32` |
| `STORAGE_URL_SECRET` | HMAC that signs receipt download links | `openssl rand -hex 32` |

The compose file overrides the dev-oriented values for you (`NODE_ENV=production`,
`BETTER_AUTH_URL`/`PUBLIC_APP_URL` → `https://${THALERMARK_DOMAIN}`, the internal
service URLs, the storage driver), so you don't touch those in `.env`.

Bring it up with a real domain (ports 80/443 must be publicly reachable so
Caddy can complete the ACME challenge):

```bash
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

Caddy auto-issues and renews a Let's Encrypt certificate. To get renewal-failure
emails, add a global block to the top of `docker/Caddyfile`:

```
{
    email you@example.com
}
```

---

## Configuration reference

`.env.example` is the annotated source of truth for every variable. The api
**refuses to start** if a required value is missing (`DATABASE_URL`,
`APP_DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` — all derived from
the checklist above inside the compose). Everything else is optional and
degrades gracefully when unset. The boot log prints which integrations came up:

```
docker compose -f docker/docker-compose.yml logs api | grep -E "transport|storage|Stripe|enabled|disabled"
```

Optional integrations, each disabled-but-safe when blank:

- **Email** — `RESEND_API_KEY` (Resend) **or** `SMTP_*`. With neither, the
  console driver logs outgoing mail to stdout (fine for testing; customers won't
  receive invoices).
- **AI** (receipt auto-fill, expense categorization, cash-flow nudges) —
  configured in-app under **Settings → AI**, not by env. Until a connection is
  saved and verified, the AI endpoints return 503 and the rest of the app runs.
  See [AI options](#ai-options).
- **Payments** — all three `STRIPE_*` keys. Blank ⇒ the Pay button hides and the
  webhook 503s.
- **Address autocomplete** — `MAPBOX_ACCESS_TOKEN` upgrades the customer-form
  type-ahead; blank uses the free, keyless US Census geocoder.
- **Error tracking** — `ERROR_TRACKING_DSN` (Sentry or self-hosted GlitchTip).
- **Telemetry** — off by default (`TELEMETRY_TRANSPORT_ENABLED=false`); opt-in,
  see [TELEMETRY.md](./TELEMETRY.md).

---

## Storage options

Receipt images (and the PDFs users upload as receipts) need somewhere to live.

### Local filesystem (default)

The self-host compose forces the **local-FS driver** — receipts are written to
the `storage_data` named volume and served back through the signed
`/api/files/<token>` route. No external service required. You only need to set
`STORAGE_URL_SECRET` (it signs those tokens; without it the stack still boots and
receipt *upload* returns 503).

This is the right choice for a **single box**. Caveats: the volume lives on that
host (so it's part of your backup story, below), and it does not work across
multiple `api` replicas — for that, use object storage.

### S3-compatible object storage (R2, MinIO, AWS S3)

The better fit for **multiple nodes, managed durability, or if you already run
object storage**. Cloudflare R2 is a good default (no egress fees).

Because the compose pins `STORAGE_DRIVER=local` inline (which takes precedence
over `.env`), switching to object storage means a small compose edit. In the
`api` service of `docker/docker-compose.yml`:

1. Remove the `STORAGE_DRIVER` and `STORAGE_LOCAL_PATH` lines.
2. Remove the `volumes:` block (`- storage_data:/app/data/storage`) — and the
   `storage_data:` entry from the top-level `volumes:` if nothing else uses it.

Then set in `.env`:

```bash
STORAGE_DRIVER=s3
S3_BUCKET=thalermark
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # R2 / MinIO; omit for AWS
S3_REGION=auto
S3_FORCE_PATH_STYLE=true                                  # MinIO; false/omit for R2/AWS
```

The api reaches these via `env_file`, so no further compose changes are needed.
`STORAGE_URL_SECRET` is not used by the S3 driver (object stores presign their
own URLs).

---

## Database options

### Bundled Postgres (default)

The `postgres` service + `postgres_data` volume. The api uses **two roles**: the
superuser (`DATABASE_URL`) for DDL only — migrations and the boot-time
`ALTER ROLE` that gives the app role its password — and the non-superuser
`thalermark_app` role (`APP_DATABASE_URL`) for all runtime traffic, so Postgres
row-level security is the primary tenant fence. The compose builds both URLs
from `POSTGRES_*` + `THALERMARK_APP_PASSWORD`.

### Managed Postgres (Neon, RDS, Cloud SQL, …)

Point the api at a managed instance instead of the bundled one:

1. Add `POSTGRES_*` only if you keep the bundled service; otherwise you can
   remove the `postgres` service + the `depends_on` from `api`.
2. Override `DATABASE_URL` and `APP_DATABASE_URL` to your managed instance (the
   compose sets them inline — edit those two lines, or move them to `.env` and
   drop the inline overrides).
3. Ensure the **pgvector** extension is available (Neon supports it).
4. **The app role:** if your provider won't let the boot `ALTER ROLE` run (no
   superuser), provision the `thalermark_app` role out-of-band, leave
   `THALERMARK_APP_PASSWORD` blank, and make sure `APP_DATABASE_URL` already
   carries the right credentials.

### Migrations

`MIGRATE_ON_BOOT=true` (the compose default for `api`) runs migrations on
startup — simplest for a single instance. For zero-downtime or multi-replica
rollouts, set it to `false` and run a dedicated migrate step ahead of the
deploy instead.

---

## TLS, domains, and reverse proxies

**Default (Caddy bundled).** Set `THALERMARK_DOMAIN` and expose ports 80/443;
Caddy obtains and renews certificates automatically and does the same-origin
routing. This is the recommended setup.

**LAN / IP access (no public domain).** For a VM or box you reach by a bare IP
(e.g. `THALERMARK_DOMAIN=192.168.1.50`) or by `localhost`, Caddy serves TLS with
its internal CA — the browser warns once, accept and proceed. The bundled
Caddyfile sets `default_sni` so IP access works at all: TLS clients send no SNI
for a raw IP, and without a default SNI Caddy can't pick a certificate for the
handshake (it fails with a TLS "internal error"). Note the **mobile app** needs
a publicly-trusted certificate, so it won't connect to an IP / internal-CA host
— that path requires a real domain.

**Behind an existing proxy / load balancer / PaaS.** If something else already
terminates TLS (a platform router, an upstream nginx/Traefik), you can drop the
`caddy` service and route to the apps yourself: `/api/*` → `api:3000`,
everything else → `web:3000`. Two things to keep right:

- `BETTER_AUTH_URL` and `PUBLIC_APP_URL` must be your external **https** URL.
  Better Auth infers the cookie `Secure` flag from `BETTER_AUTH_URL`, not from
  the request protocol — so even though your proxy reaches the api over plain
  HTTP, this value must say `https://…`.
- Keep `INTERNAL_API_URL=http://api:3000` (web SSR reaches the api over the
  internal network) and `PUBLIC_API_URL=""` (browser uses same-origin `/api/*`).

---

## AI options

AI is configured **in the app**, not by environment variables. Sign in as an
owner or admin and open **Settings → AI**: pick a provider, paste a key, and
click **Verify**. The connection is stored per workspace, encrypted at rest
(under a key derived from `BETTER_AUTH_SECRET`), and takes effect on the next AI
call with no restart. Until a connection is saved and verified, the AI endpoints
return 503 and every non-AI flow works normally.

Providers:

- **Anthropic** (default) or **OpenAI** — paste an API key. One multimodal model
  serves every task role, so the per-role model overrides (under *Advanced*) stay
  blank.
- **Ollama** — no key, fully local/self-contained (the AGPL-pure path). Point the
  endpoint at your Ollama server and set the per-role models — vision and text are
  separate models in Ollama. Small local models are weak at expense
  categorization; a capable model (e.g. `qwen2.5:14b`) is worth it.
- **Custom endpoint** — any OpenAI-compatible API (xAI, DeepSeek, a proxy): supply
  the base URL and model ids.

Reaching a private/LAN AI endpoint (a local Ollama, a model box) is the one
AI-related *server* setting — a host-level security control, not per-account AI
config, so it lives in env. Two forms, both relaxing the endpoint-safety (SSRF)
guard for **private ranges only** (link-local and cloud-metadata stay blocked
regardless):

- **`AI_ALLOWED_ENDPOINTS`** (preferred) — a comma-separated allowlist of the
  exact endpoints permitted, e.g.
  `AI_ALLOWED_ENDPOINTS=http://ollama:11434,http://192.168.1.10:11434`. Matched by
  host:port (path ignored). This opens *only those boxes*, not the whole LAN, so
  it's the safe choice on a box where others can sign up. The allowed list is
  shown (read-only) on Settings → AI so an admin knows what they can enter.
- **`AI_ALLOW_PRIVATE_ENDPOINTS`** — the blunt switch: `true` opens *all* private
  ranges to any account owner. Fine for a single-user box; prefer the allowlist
  otherwise.

Leave both off on a public deployment.

---

## Operations

**Backups.** Two stateful volumes when running the bundled services:

```bash
# Database (expands POSTGRES_* from inside the container, where they're set)
docker compose -f docker/docker-compose.yml exec postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > backup.sql
# Receipts (local-FS driver) — archive the storage_data volume. The volume is
# named <project>_storage_data; for the default invocation that's
# docker_storage_data (it changes if you pass -p). `docker volume ls` to check.
docker run --rm -v docker_storage_data:/data -v "$PWD":/out alpine \
  tar czf /out/receipts.tgz -C /data .
```

On managed Postgres + S3/R2 you back those up with the provider's tools and the
volumes above don't apply.

**Upgrades.** Pull the new GHCR images and recreate; migrations run on boot (or
via your dedicated migrate step). Bump `THALERMARK_VERSION` in `.env` to the
target release tag first (or leave it unset to track `latest`):

```bash
docker compose --env-file .env -f docker/docker-compose.yml pull
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

**Migration baseline policy.** The migration history was collapsed once, to
`packages/db/migrations/0000_baseline.sql`. From that baseline forward the chain
is append-only and is **never squashed or rewritten again** — doing so changes
the recorded hashes and breaks in-place upgrades for any DB that applied the old
chain. The practical rules:

- The first GA release tag is the permanent migration floor; upgrades are
  supported from there forward.
- Pre-GA `alpha`/`beta` builds are **reinstall-only**, not upgrade-supported.
  (The pre-baseline `v0.1.0-alpha.1` tag + images were removed for exactly this
  reason — they carried the old granular chain and couldn't migrate onto the
  baseline. `v0.1.0-alpha.2` onward is post-baseline.)

**Logs / health.** `docker compose ... logs -f api`. The api exposes two probes:
`/health` is liveness — cheap, DB-independent, always `{ "status": "ok" }` when
the process is up (used by the container healthcheck). `/ready` is readiness — it
pings the database and returns `503` when the DB is unreachable or the connection
pool is exhausted, so a load balancer can pull the instance out of rotation;
point your LB/orchestrator health check at `/ready`, not `/health`. The boot log
reports the active email transport, storage driver, Stripe, AI, and
address-autocomplete config — the fastest way to confirm a deploy picked up your
`.env`.

**Background jobs (single box vs. multiple replicas).** The api runs pg-boss
in-process for the recurring-invoice sweep (scheduler + worker). On a single box
this is automatic — leave `JOBS_ENABLED` unset (defaults true). pg-boss is
multi-instance-safe at the worker level: jobs are claimed with `FOR UPDATE SKIP
LOCKED`, so a job is processed exactly once no matter how many api replicas are
running. If you scale the api **horizontally**, run the scheduler on exactly one
instance — set `JOBS_ENABLED=false` on every replica but one (or run a single
dedicated worker container) — so the cron is asserted from one place and job load
is isolated from request traffic. Don't run the sweep on zero instances: pick one.

**Rotating secrets.** `THALERMARK_APP_PASSWORD` is re-applied on every boot (the
`ALTER ROLE` is idempotent), so rotating it is just an `.env` change + redeploy.
The same goes for `STORAGE_URL_SECRET` (rotating it invalidates outstanding
receipt links) and `BETTER_AUTH_SECRET` (rotating it invalidates sessions).

---

## Sizing & resources

The **runtime** is light: no Chromium/headless browser, the api is a plain Node
process, and Postgres is the main memory consumer. A small VPS (≈1–2 GB RAM)
runs the runtime comfortably for a single-tenant or small-team deploy.

Because the prod compose runs **prebuilt GHCR images**, the deploy host never
compiles anything — image builds (the heavy step: installing + compiling the
workspace) happen in CI. You only build locally if you fork and customize, via
`docker/docker-compose.dev.yml` on a box with more headroom.

---

## The mobile app against your server

The React Native app has a pre-sign-in **server picker** — self-hosters point it
at `https://your.host.com` before signing in. Your server must allow the app's
origin scheme `thalermark://` in `TRUSTED_ORIGINS`; the default compose already
includes it. (TLS with a real, publicly-trusted certificate is required — the
app won't trust Caddy's internal `localhost` CA.)

---

## Footguns

- **Run the prod compose with a distinct project name** if you also run the dev
  compose (`docker/docker-compose.dev.yml`). Both live in `docker/`, so they
  share the default project name `docker` — running one can reconcile against
  and tear down the other's containers. Use `-p thalermark` (or run them on
  different machines).
- **`STORAGE_DRIVER` is pinned inline** in the compose, which overrides whatever
  `.env` says. To use object storage you must edit the compose (see
  [Storage options](#storage-options)).
- **`--env-file .env`** — see the note under [Quick start](#quick-start-localhost).
  Interpolated variables (domain, passwords) silently use defaults if Compose
  can't find your env file.
