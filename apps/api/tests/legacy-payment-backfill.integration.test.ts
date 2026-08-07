import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  authUser,
  chartOfAccounts,
  companies,
  journalEntries,
  journalLines,
  memberships,
} from '@thalermark/db';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// The legacy-settlement backfill (TMC-194 / migration 0032).
//
// Invoices marked paid before partial payments shipped carry their settlement
// on the header and have no payment rows, which leaves them unrefundable,
// showing an empty payments panel, and disagreeing with any AR check derived
// from sum(total - paid). The migration writes one row per such invoice.
//
// THE LOAD-BEARING ASSERTION IS THAT NOTHING MOVES. The original mark-paid
// already posted the cash; if the backfill also posted, the same money would be
// banked twice. So every test here brackets the backfill with a full ledger
// snapshot and demands it be byte-identical.
//
// The SQL is READ FROM THE MIGRATION FILE rather than copied into this test. A
// copy would drift, and then the thing under test would be the copy — which is
// exactly the shape of bug that ships.

const MIGRATION = resolve(
  import.meta.dirname,
  '../../../packages/db/migrations/0032_backfill_legacy_invoice_payments.sql',
);

function backfillStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^SET search_path/i.test(s));
}

const testEnv: Env = {
  nodeEnv: 'test',
  port: 3000,
  logLevel: 'error',
  errorTrackingDsn: undefined,
  release: undefined,
  databaseUrl: '',
  appDatabaseUrl: '',
  appRolePassword: undefined,
  migrateOnBoot: false,
  betterAuthSecret: 'test-secret-at-least-32-characters-long',
  betterAuthUrl: 'http://localhost:3000',
  trustedOrigins: [],
  publicAppUrl: 'http://localhost:5173',
  resendApiKey: undefined,
  emailFrom: 'Thalermark <test@thalermark.test>',
  stripeSecretKey: undefined,
  stripePublishableKey: undefined,
  stripeWebhookSecret: undefined,
  recurringSweepCron: '0 6 * * *',
};

function extractSessionCookie(res: Response): string {
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

async function setup(email: string) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
  });
  const signRes = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (signRes.status !== 200) throw new Error(`sign-up failed: ${signRes.status}`);
  const cookie = extractSessionCookie(signRes);

  const db = getTestDb();
  const [user] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email));
  if (!user) throw new Error('user not seeded');
  const [m] = await db
    .select({ accountId: memberships.accountId })
    .from(memberships)
    .where(eq(memberships.userId, user.id));
  if (!m) throw new Error('membership not seeded');
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.accountId, m.accountId));
  if (!company) throw new Error('company not seeded');

  return {
    app,
    handle,
    accountId: m.accountId,
    companyId: company.id,
    headers: { cookie, 'x-account-id': m.accountId, 'content-type': 'application/json' },
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function runBackfill(): Promise<void> {
  const db = getTestDb();
  for (const statement of backfillStatements()) {
    await db.execute(sql.raw(statement));
  }
}

// Whole-ledger fingerprint: every account's signed balance, plus the entry and
// line counts. If the backfill posts anything at all, this changes.
async function ledgerSnapshot(companyId: string) {
  const db = getTestDb();
  const balances = await db
    .select({
      code: chartOfAccounts.code,
      net: sql<string>`coalesce(sum(case when ${journalLines.side} = 'debit' then ${journalLines.amount} else -${journalLines.amount} end), 0)::numeric(15,2)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
    .where(eq(journalEntries.companyId, companyId))
    .groupBy(chartOfAccounts.code)
    .orderBy(chartOfAccounts.code);
  const [counts] = await db
    .select({
      entries: sql<number>`count(distinct ${journalEntries.id})::int`,
      lines: sql<number>`count(${journalLines.id})::int`,
    })
    .from(journalEntries)
    .leftJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
    .where(eq(journalEntries.companyId, companyId));
  return JSON.stringify({ balances, counts });
}

async function makeContact(ctx: Ctx, name: string): Promise<string> {
  const res = await ctx.app.request('/api/contacts', {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({ companyId: ctx.companyId, name }),
  });
  return ((await res.json()) as { id: string }).id;
}

// A LEGACY invoice: issued, then settled the way mark-paid used to settle —
// header stamps written, cash on the ledger, and NO payment rows.
//
// That state can no longer be produced by calling mark-paid. TMC-196 made
// mark-paid record a receipt like every other path, which is precisely the fix
// that stops new legacy invoices being created. So the shape this migration
// exists to repair now has to be built deliberately: settle through the API,
// then drop the receipt row and leave the ledger entry standing.
//
// Deleting the row directly rather than through the API is the point — the API
// would post a reversal, and what we need is cash on the books with nothing to
// explain it. That is exactly what a pre-TMC-187 database contains.
async function makeLegacyPaidInvoice(
  ctx: Ctx,
  number: string,
  total: string,
  opts: { send?: boolean; method?: string; paidOn?: string } = {},
): Promise<string> {
  const contactId = await makeContact(ctx, `Customer ${number}`);
  const res = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId,
      number,
      issueDate: '2026-03-01',
      dueDate: '2026-04-01',
      subtotal: total,
      total,
      lineItems: [
        {
          position: 1,
          description: 'Work',
          quantity: '1',
          unitPrice: total,
          amount: total,
          type: 'service',
        },
      ],
    }),
  });
  const id = ((await res.json()) as { id: string }).id;
  if (opts.send !== false) {
    await ctx.app.request(`/api/invoices/${id}/mark-sent`, {
      method: 'POST',
      headers: ctx.headers,
    });
  }
  const paid = await ctx.app.request(`/api/invoices/${id}/mark-paid`, {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({
      method: opts.method ?? 'check',
      reference: 'chk-1001',
      paidOn: opts.paidOn ?? '2026-03-15',
    }),
  });
  if (paid.status !== 200) throw new Error(`mark-paid failed: ${paid.status}`);

  // Strip the receipt, keep the ledger entry — see the note above. The entry
  // mark-paid posts is byte-identical to the one the old single-shot path
  // posted (Dr Cash / Cr AR when issued, Dr Cash / Cr Revenue when not), so
  // what is left behind is a faithful pre-TMC-187 row.
  await getTestDb().execute(sql`delete from invoice_payments where invoice_id = ${id}`);
  return id;
}

describe('legacy payment backfill (migration 0032)', () => {
  beforeEach(resetDb);

  it('creates one payment row per legacy invoice and moves no money', async () => {
    const ctx = await setup('backfill-basic@test.com');
    try {
      const id = await makeLegacyPaidInvoice(ctx, 'INV-L1', '1200.00');

      // Precondition: the legacy shape really is header-only.
      const before = await ctx.app.request(`/api/invoices/${id}/payments`, {
        headers: ctx.headers,
      });
      expect(((await before.json()) as { payments: unknown[] }).payments).toHaveLength(0);

      const ledgerBefore = await ledgerSnapshot(ctx.companyId);
      await runBackfill();
      const ledgerAfter = await ledgerSnapshot(ctx.companyId);

      // THE assertion. Not a single journal line moved.
      expect(ledgerAfter).toBe(ledgerBefore);

      const after = await ctx.app.request(`/api/invoices/${id}/payments`, {
        headers: ctx.headers,
      });
      const body = (await after.json()) as {
        payments: {
          amount: string;
          receivedOn: string;
          method: string;
          reference: string | null;
        }[];
        settlement: string;
        paid: string;
        outstanding: string;
      };
      expect(body.payments).toHaveLength(1);
      expect(body.payments[0]?.amount).toBe('1200.00');
      // The date the user actually picked, not shifted by a timezone.
      expect(body.payments[0]?.receivedOn).toBe('2026-03-15');
      expect(body.payments[0]?.method).toBe('check');
      expect(body.payments[0]?.reference).toBe('chk-1001');
      expect(body.settlement).toBe('paid');
      expect(body.outstanding).toBe('0.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('unfreezes the invoice — a refund becomes possible', async () => {
    // The user-visible point of the whole migration. Before it, this 409s with
    // settled_without_payments and there is no way to adjust the invoice at all.
    const ctx = await setup('backfill-refund@test.com');
    try {
      const id = await makeLegacyPaidInvoice(ctx, 'INV-L2', '500.00');

      const blocked = await ctx.app.request(`/api/invoices/${id}/payments`, {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({ amount: '-100.00', receivedOn: '2026-04-02', method: 'other' }),
      });
      expect(blocked.status).toBe(409);
      expect(((await blocked.json()) as { error: string }).error).toBe('settled_without_payments');

      await runBackfill();

      const refund = await ctx.app.request(`/api/invoices/${id}/payments`, {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({ amount: '-100.00', receivedOn: '2026-04-02', method: 'other' }),
      });
      expect(refund.status).toBe(201);
      const body = (await refund.json()) as { settlement: string; outstanding: string };
      expect(body.settlement).toBe('partial');
      expect(body.outstanding).toBe('100.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('is idempotent — a second run changes nothing', async () => {
    const ctx = await setup('backfill-idempotent@test.com');
    try {
      await makeLegacyPaidInvoice(ctx, 'INV-L3', '300.00');
      await runBackfill();
      const ledgerAfterFirst = await ledgerSnapshot(ctx.companyId);
      const [firstCount] = await getTestDb()
        .execute<{ n: number }>(sql`select count(*)::int as n from invoice_payments`)
        .then((r) => r.rows);

      await runBackfill();

      const [secondCount] = await getTestDb()
        .execute<{ n: number }>(sql`select count(*)::int as n from invoice_payments`)
        .then((r) => r.rows);
      expect(Number(secondCount?.n)).toBe(Number(firstCount?.n));
      expect(await ledgerSnapshot(ctx.companyId)).toBe(ledgerAfterFirst);
    } finally {
      await ctx.handle.close();
    }
  });

  it('leaves invoices that already have payment rows alone', async () => {
    const ctx = await setup('backfill-modern@test.com');
    try {
      const contactId = await makeContact(ctx, 'Modern');
      const res = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          companyId: ctx.companyId,
          contactId,
          number: 'INV-M1',
          issueDate: '2026-03-01',
          dueDate: '2026-04-01',
          subtotal: '800.00',
          total: '800.00',
          lineItems: [
            {
              position: 1,
              description: 'Work',
              quantity: '1',
              unitPrice: '800.00',
              amount: '800.00',
              type: 'service',
            },
          ],
        }),
      });
      const id = ((await res.json()) as { id: string }).id;
      await ctx.app.request(`/api/invoices/${id}/mark-sent`, {
        method: 'POST',
        headers: ctx.headers,
      });
      // Settled the NEW way: two partial receipts.
      for (const amount of ['300.00', '500.00']) {
        await ctx.app.request(`/api/invoices/${id}/payments`, {
          method: 'POST',
          headers: ctx.headers,
          body: JSON.stringify({ amount, receivedOn: '2026-03-10', method: 'cash' }),
        });
      }

      await runBackfill();

      const after = await ctx.app.request(`/api/invoices/${id}/payments`, {
        headers: ctx.headers,
      });
      const body = (await after.json()) as { payments: unknown[]; paid: string };
      // Still two rows — no phantom third for the full total.
      expect(body.payments).toHaveLength(2);
      expect(body.paid).toBe('800.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('skips a zero-total invoice rather than writing a zero receipt', async () => {
    const ctx = await setup('backfill-zero@test.com');
    try {
      const contactId = await makeContact(ctx, 'Freebie');
      const res = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          companyId: ctx.companyId,
          contactId,
          number: 'INV-Z1',
          issueDate: '2026-03-01',
          dueDate: '2026-04-01',
          subtotal: '0.00',
          total: '0.00',
          lineItems: [
            {
              position: 1,
              description: 'Goodwill',
              quantity: '1',
              unitPrice: '0.00',
              amount: '0.00',
              type: 'service',
            },
          ],
        }),
      });
      const id = ((await res.json()) as { id: string }).id;
      await ctx.app.request(`/api/invoices/${id}/mark-sent`, {
        method: 'POST',
        headers: ctx.headers,
      });
      await ctx.app.request(`/api/invoices/${id}/mark-paid`, {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({ method: 'cash', paidOn: '2026-03-05' }),
      });

      await runBackfill();

      const [row] = await getTestDb()
        .execute<{ n: number }>(
          sql`select count(*)::int as n from invoice_payments where invoice_id = ${id}`,
        )
        .then((r) => r.rows);
      // A zero-amount receipt is rejected by the API schema; the migration must
      // not create one behind its back.
      expect(Number(row?.n)).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('backfills an invoice paid without ever being sent', async () => {
    // draft -> paid posts Dr Cash / Cr Revenue, never touching AR. The backfill
    // still records the receipt, and still must not move the ledger.
    const ctx = await setup('backfill-draft@test.com');
    try {
      const id = await makeLegacyPaidInvoice(ctx, 'INV-D1', '250.00', {
        send: false,
        method: 'cash',
      });
      const before = await ledgerSnapshot(ctx.companyId);
      await runBackfill();
      expect(await ledgerSnapshot(ctx.companyId)).toBe(before);

      const after = await ctx.app.request(`/api/invoices/${id}/payments`, {
        headers: ctx.headers,
      });
      const body = (await after.json()) as { payments: { amount: string }[]; settlement: string };
      expect(body.payments).toHaveLength(1);
      expect(body.payments[0]?.amount).toBe('250.00');
      expect(body.settlement).toBe('paid');
    } finally {
      await ctx.handle.close();
    }
  });
});
