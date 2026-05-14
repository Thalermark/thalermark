# Contributing to Thalermark

Thanks for your interest. Thalermark is a small project right now and contributions are very welcome.

## Before you start

- **Read [PROJECT.md](./PROJECT.md) and [TECH-STACK.md](./TECH-STACK.md).** They explain what we're building, for whom, and the locked technical decisions. A "this would be cooler in X" PR rarely lands; a PR that aligns with the locked stack almost always does.
- **Open an issue first for non-trivial changes.** A new MVP feature, a refactor that touches multiple packages, or a dependency change all benefit from a quick discussion before code. Typo fixes and small bug fixes can go straight to PR.
- **MVP is intentionally tight.** See PROJECT.md for the locked feature list. Out-of-scope features will be politely deferred to v1.x.

## Contributor License Agreement

Before your first PR lands, you'll be asked to sign a one-click Contributor License Agreement via the [CLA Assistant](https://cla-assistant.io/) bot. Full text is in [CLA.md](./CLA.md). It grants the project the right to relicense your contribution under both AGPL v3 and the commercial license — the same dual-license arrangement the rest of the codebase lives under. You retain copyright on your contributions.

The CLA signs once and applies to all future PRs.

## Development setup

**Requirements:**
- Node 24 (use `nvm use` to pick up `.nvmrc`)
- pnpm 9 (via `corepack enable`)
- Docker (for Postgres in dev)
- Git

**First time:**

```bash
git clone https://github.com/Thalermark/thalermark.git
cd thalermark
nvm use
corepack enable
pnpm install
```

**Common commands:**

```bash
pnpm dev          # run all apps in dev mode via turbo
pnpm lint         # biome lint check
pnpm lint:fix     # biome lint + write fixes
pnpm format       # biome format
pnpm typecheck    # turbo run typecheck across packages
pnpm test         # turbo run test (vitest)
pnpm build        # production build
```

## Code style

- **Biome** does linting and formatting. There is no ESLint and no Prettier — Biome replaces both.
- **TypeScript everywhere.** Strict mode is on across the monorepo.
- **Comments are rare.** Names should carry meaning; comments are reserved for hidden constraints or non-obvious *why*.
- **Tests live next to source** as `*.test.ts` files. The runner is Vitest.

## Commits and PRs

- Branch from `main`. Branch naming is informal — `feature/`, `fix/`, `docs/` prefixes are common but not required.
- Keep PRs focused. One concern per PR makes review fast and revert safe.
- Reference issues in the PR description (`Closes #123`) so the issue auto-closes on merge.
- CI must be green before merge: lint, typecheck, test, build.
- PRs are merged via **squash and merge** (configured as the only allowed strategy). Your PR title becomes the commit message on `main`, so it should follow our commit message convention below.

## Commit message conventions

We use [**Conventional Commits**](https://www.conventionalcommits.org/). The format gives us readable history today and unlocks automated changelogs and version bumps later (`release-please` or `semantic-release`) without re-litigating commit-message style.

### Format

```
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

### Types we use

| Type | When |
|---|---|
| `feat` | A new feature or user-visible capability |
| `fix` | A bug fix |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `docs` | Documentation only |
| `test` | Adding or correcting tests |
| `build` | Changes to build system or external dependencies (Dependabot uses this) |
| `ci` | CI configuration changes |
| `chore` | Other changes that don't modify `src` or `test` files |
| `revert` | Reverts a previous commit |

### Scope (optional)

A noun describing the area of the codebase: `feat(invoice):`, `fix(api):`, `docs(self-host):`. Skip when the change is broad (`ci: bump GitHub Actions to v6`).

### Breaking changes

Mark either by adding `!` after the type/scope, or by including a `BREAKING CHANGE:` footer:

```
feat(api)!: rename /api/invoices to /api/v2/invoices
```

```
feat(api): rename /api/invoices to /api/v2/invoices

BREAKING CHANGE: clients using /api/invoices must migrate to /api/v2/invoices.
```

### Examples from our history

```
feat(invoice): add recurring invoice generator
fix(api): handle null customer in invoice serializer
docs: add SECURITY.md (vulnerability disclosure policy)
ci: bump GitHub Actions to v6 (Node 24 runtime)
build(deps-dev): bump vitest from 2.1.8 to 2.1.9
chore: migrate biome.json to v2 schema
```

### Notes

- **The PR title is what matters** — since we squash-merge, the PR title becomes the single commit on `main`. The individual commit messages on your feature branch can be anything; only the PR title needs to follow the convention.
- **Dependabot follows Conventional Commits natively** — its PRs come pre-formatted as `build(deps-dev): bump X from A to B`. No special handling needed.
- **No commit-lint enforcement.** We rely on convention plus reviewer eyes rather than pre-commit hooks. If a PR title doesn't follow the convention, the reviewer will ask you to update it before merge.

## Reporting bugs

Open an issue with:

- What you expected to happen
- What actually happened
- Steps to reproduce (smallest possible reproduction)
- Environment: OS, Node version, browser/mobile, self-hosted vs SaaS

A failing test is the most valuable kind of bug report.

## Security

Please do not file security issues in public GitHub issues. Email **security@thalermark.com** with details and a recommended fix if you have one. We commit to acknowledging within 1 week and patching coordinated-disclosure issues within a reasonable timeline relative to severity.

## License of contributions

By submitting a contribution, you agree it is licensed under the terms set out in [CLA.md](./CLA.md), which permits Thalermark to distribute it under AGPL v3 and the commercial license.

## Where to ask questions

- **Architectural / direction:** open a discussion on GitHub
- **Quick "how do I" questions:** community Discord (link in README once launched)
- **Anything sensitive:** email hello@thalermark.com

Welcome aboard.
