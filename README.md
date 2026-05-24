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

The project is in early scaffolding — only the workspace plumbing is in place today. Phases 1–7 (database, telemetry, API, web/mobile shells, CI/CD) are tracked in [SCAFFOLDING.md](./SCAFFOLDING.md).

## Self-host

The full stack — postgres + api + web + caddy (TLS-terminating reverse proxy) — runs from a single Docker Compose file:

```bash
cp .env.example .env
# At minimum, replace BETTER_AUTH_SECRET (openssl rand -base64 32) and
# THALERMARK_APP_PASSWORD (any long random string — used as the password
# for the non-superuser thalermark_app Postgres role the api runs as).
docker compose -f docker/docker-compose.yml up -d
```

Open [https://localhost](https://localhost). Caddy serves with its internal CA on the default `localhost` host; the browser will warn once on first visit — accept and proceed.

For a real domain, set `THALERMARK_DOMAIN=your.host.com` in `.env` before bringing the stack up. Caddy auto-issues a Let's Encrypt cert (requires ports 80 and 443 reachable from the public internet).

## Documentation

- [PROJECT.md](./PROJECT.md) — what we're building and for whom
- [TECH-STACK.md](./TECH-STACK.md) — every locked technical decision and why
- [TELEMETRY.md](./TELEMETRY.md) — what we collect, when, and how to opt out
- [SCAFFOLDING.md](./SCAFFOLDING.md) — phase plan from empty repo to first MVP feature
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
