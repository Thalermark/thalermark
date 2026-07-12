# Thalermark

> Open source, AI-first accounting for freelancers and trades people.

**Status:** Pre-MVP, scaffolding in progress. Not yet usable.

Thalermark is for landscapers, dog sitters, power washers, independent contractors — people who are great at their craft and have no interest in becoming their own accountant. Most accounting software asks *"would you like to create a journal entry?"* Thalermark asks *"you have 3 unpaid invoices totalling $1,240 — want me to send reminders?"*

The AI layer is woven into the core interaction model, not a chatbot bolted on the side.

## Highlights

- **AI-first** — anomaly flagging, cash flow nudges, late payer detection, expense categorization, receipt extraction
- **Mobile first** — primary surface is React Native + Expo; web app is for desk-bound and accountant workflows
- **Open source under AGPL v3** — community edition free forever, self-hostable via one `docker compose up`
- **Multi-tenant from day one** — row-level isolation enforced by Postgres RLS; the same code runs SaaS and self-host

## Project structure

```
apps/        web (SvelteKit), mobile (Expo), api (Hono)
packages/    db, validation, ai, telemetry, brand, location, api-contract
docker/      docker-compose for self-host
```

The repo follows a single-monorepo layout with [pnpm workspaces](https://pnpm.io/workspaces) and [Turborepo](https://turbo.build/).

## Development

**Requirements:** Node 24, pnpm 9, Docker (for Postgres).

```bash
nvm use            # picks up .nvmrc → Node 24
corepack enable    # gives you the pinned pnpm
pnpm install
pnpm dev
```

The MVP is feature-complete on web and mobile (Phases 0–9 shipped); current work is production hardening ahead of launch. Phase history is tracked in [SCAFFOLDING.md](./SCAFFOLDING.md).

## Self-host

The full stack — postgres + api + web + caddy (TLS-terminating reverse proxy) — runs from a single Docker Compose file. The quickest path is the installer: it checks for Docker, generates every secret, walks you through the optional settings (domain/TLS, email, Stripe), and writes a ready-to-run `.env`. AI is configured in-app after sign-in (Settings → AI), not in `.env`.

```bash
curl -fsSL https://raw.githubusercontent.com/Thalermark/thalermark/main/install.sh | bash
```

Docker + the Compose plugin are the only prerequisites (the script links the install docs if either is missing). It sets everything up but **doesn't start the stack** — review the generated `.env`, then run the `docker compose … up -d` command it prints for you.

<details>
<summary>Prefer manual setup? Clone the repo instead.</summary>

```bash
cp .env.example .env
# At minimum, replace BETTER_AUTH_SECRET (openssl rand -base64 32) and
# THALERMARK_APP_PASSWORD (any long random string — the password for the
# non-superuser thalermark_app Postgres role the api runs as).
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

The explicit `--env-file .env` makes Compose apply your values regardless of which directory you invoke it from — some Compose builds otherwise look for the env file next to the compose file and silently fall back to the insecure defaults.
</details>

Open [https://localhost](https://localhost). Caddy serves with its internal CA on the default `localhost` host; the browser will warn once on first visit — accept and proceed.

For a real domain, set `THALERMARK_DOMAIN=your.host.com` in `.env` before bringing the stack up (the installer prompts for this). Caddy auto-issues a Let's Encrypt cert (requires ports 80 and 443 reachable from the public internet).

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full guide — the production secrets checklist, storage and database options (local FS vs S3/R2, bundled vs managed Postgres), running behind an existing proxy, backups, and sizing.

## Documentation

- [PROJECT.md](./PROJECT.md) — what we're building and for whom
- [TECH-STACK.md](./TECH-STACK.md) — every locked technical decision and why
- [TELEMETRY.md](./TELEMETRY.md) — what we collect, when, and how to opt out
- [DEPLOYMENT.md](./DEPLOYMENT.md) — self-hosting: configuration, storage/database options, TLS, backups, sizing
- [SCAFFOLDING.md](./SCAFFOLDING.md) — phase plan + realized record (Phases 0–9)
- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to contribute, including the CLA

## License

Thalermark is dual-licensed:

- **AGPL v3** ([LICENSE](./LICENSE)) — the community edition. Free to use, modify, run, and distribute under AGPL terms. Network use of a modified copy requires sharing source.
- **Commercial license** ([LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md)) — available for embedders, white-label resellers, and OEMs whose own products can't be AGPL.

Contributors sign a lightweight [CLA](./CLA.md) (one click via CLA Assistant on first PR) so the project can offer both licenses durably.

## Community

- Website: [thalermark.com](https://thalermark.com)
- GitHub: [github.com/Thalermark](https://github.com/Thalermark)

## Trademark

"Thalermark" and the Thalermark logo are trademarks of the Thalermark project. AGPL grants rights to the source code, not to the name or marks. Forks must be renamed before distribution.
