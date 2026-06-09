# Dev/ops scripts

One-off scripts run with `tsx`. They are **not** part of the build (`dist/`) and
must never run against production data without intent — the seeder requires an
explicit `--yes`.

Both read `DATABASE_URL` / `APP_DATABASE_URL` from the repo-root `.env`.

## Load testing (query performance at volume)

The hidden double-entry ledger means a naive bulk insert of invoices/expenses
leaves the dashboard, trial balance, AR, cash-flow, and top-products queries
empty or wrong. The seeder avoids that by reusing the pure ledger posting
helpers, so the books stay balanced and the aggregate queries are realistic.

Seed into an account you've already created (sign up normally first), so there's
a loginable user + a real chart of accounts and the data shows up in app/web:

```sh
# dry run (prints the plan, writes nothing)
pnpm --filter @thalermark/api seed:load-test -- --email you@example.com

# write 100k invoices + 50k expenses, dates spread over 24 months
pnpm --filter @thalermark/api seed:load-test -- \
  --email you@example.com --invoices 100000 --expenses 50000 --yes
```

Flags: `--email <addr>` | `--company <uuid>` (target), `--invoices`,
`--expenses`, `--estimates`, `--customers`, `--items`, `--months` (date spread),
`--yes` (required to write). Re-running appends (invoice/estimate numbers
continue past existing ones).

The seeder connects as the superuser `DATABASE_URL` to bypass RLS for the bulk
insert. Then benchmark the **reads** as the runtime `thalermark_app` role so RLS
overhead and index usage are real:

```sh
pnpm --filter @thalermark/api bench:reads -- --company <uuid>          # summary
pnpm --filter @thalermark/api bench:reads -- --company <uuid> --verbose # full plans
```

`bench:reads` runs `EXPLAIN (ANALYZE, BUFFERS)` on the hot paths (invoice list,
activity feed, top-products, cash-on-hand / AR ledger nets, expense windows,
per-entity audit) and flags any `Seq Scan` on a large table — a candidate
missing index.
