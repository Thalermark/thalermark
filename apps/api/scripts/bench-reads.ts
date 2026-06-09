/**
 * Read-path benchmark — runs EXPLAIN (ANALYZE, BUFFERS) on the queries that
 * get slow at volume, as the `thalermark_app` role with the tenant GUCs set,
 * so RLS overhead and index usage are both real. Pair with seed-load-test.ts.
 *
 *   pnpm --filter @thalermark/api bench:reads -- --company <uuid> [--verbose]
 *   pnpm --filter @thalermark/api bench:reads -- --email you@example.com
 *
 * Resolves the company/account over the superuser DATABASE_URL (RLS would
 * otherwise hide the lookup), then benchmarks over APP_DATABASE_URL. Prints
 * per-query execution time and flags any Seq Scan; --verbose dumps full plans.
 */
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import {
  type Database,
  authUser,
  companies,
  createDatabase,
  invoices,
  memberships,
  withAccountContext,
} from '@thalermark/db';
import { asc, eq, sql } from 'drizzle-orm';

loadEnvFile(resolve(import.meta.dirname, '../../../.env'));

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const verbose = process.argv.includes('--verbose');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const superUrl = process.env.DATABASE_URL;
  const appUrl = process.env.APP_DATABASE_URL;
  if (!superUrl || !appUrl) throw new Error('DATABASE_URL and APP_DATABASE_URL are required');

  const sup = createDatabase(superUrl);
  const target = await resolve_(sup, arg('company'), arg('email'));
  if (!UUID_RE.test(target.accountId) || !UUID_RE.test(target.companyId)) {
    throw new Error('resolved ids are not valid uuids');
  }
  const acc = `'${target.accountId}'::uuid`;
  const co = `'${target.companyId}'::uuid`;

  // A sample invoice id (within tenant context) for the per-entity audit query.
  const app: Database = createDatabase(appUrl);
  const sampleInvoiceId = await withAccountContext(
    app,
    { accountId: target.accountId },
    async (tx) => {
      const [r] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(eq(invoices.companyId, target.companyId))
        .limit(1);
      return r?.id;
    },
  );
  const sampleId =
    sampleInvoiceId && UUID_RE.test(sampleInvoiceId) ? `'${sampleInvoiceId}'::uuid` : null;

  const queries: { name: string; sql: string }[] = [
    {
      name: 'invoices_list (newest 50)',
      sql: `SELECT id, number, status, total, issue_date FROM invoices WHERE account_id = ${acc} AND company_id = ${co} ORDER BY created_at DESC LIMIT 50`,
    },
    {
      name: 'invoices_by_status (sent)',
      sql: `SELECT id, number, total FROM invoices WHERE account_id = ${acc} AND company_id = ${co} AND status = 'sent' ORDER BY created_at DESC LIMIT 50`,
    },
    {
      name: 'activity_feed (newest 100)',
      sql: `SELECT ae.id, ae.action, ae.entity_type, ae.entity_id, ae.created_at, u.name FROM audit_events ae LEFT JOIN auth_user u ON u.id = ae.actor_user_id WHERE ae.account_id = ${acc} ORDER BY ae.created_at DESC LIMIT 100`,
    },
    {
      name: 'top_products (paid, grouped)',
      sql: `SELECT li.source_item_id, SUM(li.amount) AS revenue, COUNT(*) AS lines FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id WHERE li.account_id = ${acc} AND i.company_id = ${co} AND i.status = 'paid' GROUP BY li.source_item_id ORDER BY revenue DESC NULLS LAST`,
    },
    {
      name: 'cash_on_hand (ledger net)',
      sql: `SELECT SUM(CASE WHEN jl.side = 'debit' THEN jl.amount ELSE -jl.amount END) FROM journal_lines jl JOIN chart_of_accounts coa ON coa.id = jl.coa_account_id WHERE jl.account_id = ${acc} AND coa.company_id = ${co} AND coa.code = '1000'`,
    },
    {
      name: 'ar_balance (ledger net)',
      sql: `SELECT SUM(CASE WHEN jl.side = 'debit' THEN jl.amount ELSE -jl.amount END) FROM journal_lines jl JOIN chart_of_accounts coa ON coa.id = jl.coa_account_id WHERE jl.account_id = ${acc} AND coa.company_id = ${co} AND coa.code = '1200'`,
    },
    {
      name: 'spending_30d (expenses sum)',
      sql: `SELECT SUM(amount) FROM expenses WHERE account_id = ${acc} AND company_id = ${co} AND deleted_at IS NULL AND expense_date >= (CURRENT_DATE - INTERVAL '30 days')`,
    },
  ];
  if (sampleId) {
    queries.push({
      name: 'audit_per_entity (one invoice)',
      sql: `SELECT id, action, created_at FROM audit_events WHERE account_id = ${acc} AND entity_type = 'invoice' AND entity_id = ${sampleId} ORDER BY created_at DESC LIMIT 50`,
    });
  }

  console.log(`Benchmarking as thalermark_app · company ${target.name} (${target.companyId})\n`);
  console.log('  query                              exec(ms)   scan');
  console.log(`  ${'-'.repeat(58)}`);

  for (const q of queries) {
    const plan = await withAccountContext(app, { accountId: target.accountId }, async (tx) => {
      const res = await tx.execute(sql.raw(`EXPLAIN (ANALYZE, BUFFERS) ${q.sql}`));
      // node-postgres returns { rows: [{ 'QUERY PLAN': '...' }, ...] }
      const rows = (res as unknown as { rows: Record<string, string>[] }).rows ?? [];
      return rows.map((r) => r['QUERY PLAN'] as string);
    });
    const text = plan.join('\n');
    const execMs = /Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? '?';
    const seq = /Seq Scan/.test(text) ? 'SEQ ⚠' : 'index';
    console.log(`  ${q.name.padEnd(34)} ${execMs.padStart(8)}   ${seq}`);
    if (verbose)
      console.log(
        text
          .split('\n')
          .map((l) => `      ${l}`)
          .join('\n'),
        '\n',
      );
  }

  console.log(
    '\nSeq scans on large tables = a candidate missing index. Re-run with --verbose for full plans.',
  );
  await process.exit(0);
}

async function resolve_(
  db: Database,
  companyId?: string,
  email?: string,
): Promise<{ companyId: string; accountId: string; name: string }> {
  if (companyId) {
    const [c] = await db
      .select({ id: companies.id, accountId: companies.accountId, name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    if (!c) throw new Error(`no company ${companyId}`);
    return { companyId: c.id, accountId: c.accountId, name: c.name };
  }
  if (email) {
    const [u] = await db
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.email, email.toLowerCase()))
      .limit(1);
    if (!u) throw new Error(`no user ${email}`);
    const [m] = await db
      .select({ accountId: memberships.accountId })
      .from(memberships)
      .where(eq(memberships.userId, u.id))
      .limit(1);
    if (!m) throw new Error(`user ${email} has no membership`);
    const [c] = await db
      .select({ id: companies.id, accountId: companies.accountId, name: companies.name })
      .from(companies)
      .where(eq(companies.accountId, m.accountId))
      .orderBy(asc(companies.createdAt))
      .limit(1);
    if (!c) throw new Error('account has no company');
    return { companyId: c.id, accountId: c.accountId, name: c.name };
  }
  const [c] = await db
    .select({ id: companies.id, accountId: companies.accountId, name: companies.name })
    .from(companies)
    .orderBy(asc(companies.createdAt))
    .limit(1);
  if (!c) throw new Error('no companies — seed first');
  return { companyId: c.id, accountId: c.accountId, name: c.name };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
