import { authUser, chartOfAccounts, companies, memberships, periodCloses } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Year-end close (TMC-159) — the accountant-portal operation that rolls a fiscal
// year's revenue + expenses (and withdrawals) into equity and locks the year.
//
// The invariants worth guarding, in order of how badly they'd hurt:
//   1. after a close the balance sheet STILL BALANCES and total equity is
//      unchanged — the profit just moved from the derived net-income line into a
//      real equity balance;
//   2. the P&L for the closed year still reports that year's trading, i.e. the
//      closing entry is excluded from P&L-shaped reports (otherwise the year
//      reads as zero);
//   3. the lock actually rejects a backdated posting, from an ordinary domain
//      route rather than only the ledger portal;
//   4. re-opening restores the prior state exactly.
//
// Everything is dated in years that are already over, so the assertions don't
// depend on the wall clock — a year still running can't be closed at all, which
// is itself asserted below using the current year. The company's zone stays UTC
// so the boundary instant is plain.

const CLOSED_YEAR = 2024;
const IN_YEAR = '2024-06-15';
// The year after the one under test — finished too, so it can be closed second.
const NEXT_YEAR = 2025;
const IN_NEXT_YEAR = '2025-02-01';

const testEnv: Env = {
  nodeEnv: 'test',
  port: 3000,
  logLevel: 'info',
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

function buildApp() {
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
  return { app, handle };
}

type App = ReturnType<typeof createApp>;

async function signUp(app: App, email: string): Promise<string> {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`);
  return extractSessionCookie(res);
}

async function ownerContext(email: string) {
  const db = getTestDb();
  const [user] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email));
  if (!user) throw new Error(`user ${email} not seeded`);
  const [m] = await db
    .select({ accountId: memberships.accountId })
    .from(memberships)
    .where(eq(memberships.userId, user.id));
  if (!m) throw new Error(`membership for ${email} not seeded`);
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.accountId, m.accountId));
  if (!company) throw new Error(`company for ${email} not seeded`);
  return { accountId: m.accountId, companyId: company.id };
}

type Ctx = {
  app: App;
  cookie: string;
  accountId: string;
  companyId: string;
  cashId: string;
  fuelId: string;
};

function req(ctx: Ctx, path: string, init?: RequestInit) {
  const headers: Record<string, string> = {
    cookie: ctx.cookie,
    'x-account-id': ctx.accountId,
  };
  if (init?.body) headers['content-type'] = 'application/json';
  return ctx.app.request(path, { ...init, headers: { ...headers, ...init?.headers } });
}

// COA account id for a company by its 4-digit code (runs as the test superuser,
// bypassing RLS — fine for fetching ids to feed the API under test).
async function coaId(companyId: string, code: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.companyId, companyId), eq(chartOfAccounts.code, code)));
  if (!row) throw new Error(`COA ${code} not seeded for company ${companyId}`);
  return row.id;
}

// Book an expense on a given date. Split out because several tests need to
// probe whether a date is still postable.
function spend(ctx: Ctx, on: string, amount: string, merchant: string, categoryId: string) {
  return req(ctx, '/api/expenses', {
    method: 'POST',
    body: JSON.stringify({
      companyId: ctx.companyId,
      categoryAccountId: categoryId,
      paymentAccountId: ctx.cashId,
      amount,
      expenseDate: on,
      merchant,
    }),
  });
}

// A company with a full year of trading on the books: 1000.00 of revenue and
// 300.00 of expense, net 700.00.
//
// The invoice goes draft → paid directly (not via sent) on purpose: mark-sent
// posts at `now` with no backdating hook, while mark-paid takes `paidOn`, so
// this is the only route that puts revenue in a finished year. Draft → paid
// posts Dr Cash / Cr Revenue in a single entry.
async function seedTradingYear(ctx: Ctx) {
  const contactRes = await req(ctx, '/api/contacts', {
    method: 'POST',
    body: JSON.stringify({ companyId: ctx.companyId, name: 'Acme' }),
  });
  const contact = (await contactRes.json()) as { id: string };

  const invRes = await req(ctx, '/api/invoices', {
    method: 'POST',
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId: contact.id,
      number: 'INV-2024-1',
      issueDate: IN_YEAR,
      dueDate: IN_YEAR,
      subtotal: '1000.00',
      tax: '0.00',
      total: '1000.00',
      lineItems: [
        {
          position: 1,
          description: 'Mowing',
          quantity: '1',
          unitPrice: '1000.00',
          amount: '1000.00',
        },
      ],
    }),
  });
  if (invRes.status !== 201) throw new Error(`invoice create failed: ${invRes.status}`);
  const invoice = (await invRes.json()) as { id: string };

  const paid = await req(ctx, `/api/invoices/${invoice.id}/mark-paid`, {
    method: 'POST',
    body: JSON.stringify({ method: 'cash', paidOn: IN_YEAR }),
  });
  if (paid.status !== 200) throw new Error(`mark-paid failed: ${paid.status}`);

  const exp = await spend(ctx, IN_YEAR, '300.00', 'Fuel', ctx.fuelId);
  if (exp.status !== 201) throw new Error(`expense create failed: ${exp.status}`);

  return { contactId: contact.id, invoiceId: invoice.id };
}

type BalanceSheet = {
  equity: { code: string; amount: string }[];
  netIncome: string;
  totalAssets: string;
  totalEquity: string;
  balanced: boolean;
};

async function balanceSheet(ctx: Ctx, asOf: string): Promise<BalanceSheet> {
  const res = await req(ctx, `/api/companies/${ctx.companyId}/balance-sheet?asOf=${asOf}`);
  return (await res.json()) as BalanceSheet;
}

type ProfitLoss = { totalRevenue: string; totalExpenses: string; netProfit: string };

async function profitLoss(ctx: Ctx, from: string, to: string): Promise<ProfitLoss> {
  const res = await req(ctx, `/api/companies/${ctx.companyId}/profit-loss?from=${from}&to=${to}`);
  return (await res.json()) as ProfitLoss;
}

function closeYear(ctx: Ctx, fiscalYear = CLOSED_YEAR) {
  return req(ctx, '/api/ledger/period-closes', {
    method: 'POST',
    body: JSON.stringify({ companyId: ctx.companyId, fiscalYear }),
  });
}

async function setup(email: string): Promise<{ ctx: Ctx; close: () => Promise<void> }> {
  const { app, handle } = buildApp();
  const cookie = await signUp(app, email);
  const { accountId, companyId } = await ownerContext(email);
  const cashId = await coaId(companyId, '1000');
  const fuelId = await coaId(companyId, '6200');
  return {
    ctx: { app, cookie, accountId, companyId, cashId, fuelId },
    close: () => handle.close(),
  };
}

describe('year-end close', () => {
  beforeEach(resetDb);

  it('rolls the year into equity, keeps the balance sheet balanced, and leaves the P&L intact', async () => {
    const { ctx, close } = await setup('pc-roll@example.com');
    try {
      await seedTradingYear(ctx);

      const before = await balanceSheet(ctx, '2024-12-31');
      expect(before.netIncome).toBe('700.00');
      expect(before.balanced).toBe(true);

      const preview = (await (
        await req(
          ctx,
          `/api/ledger/period-closes/preview?companyId=${ctx.companyId}&fiscalYear=${CLOSED_YEAR}`,
        )
      ).json()) as { netIncome: string; equityCode: string; equityLabel: string; empty: boolean };
      expect(preview.netIncome).toBe('700.00');
      // Sole prop (the signup default) rolls into Owner's Equity, not 3400.
      expect(preview.equityCode).toBe('3000');
      expect(preview.equityLabel).toBe("Owner's equity");
      expect(preview.empty).toBe(false);

      const res = await closeYear(ctx);
      expect(res.status).toBe(201);
      const created = (await res.json()) as { netIncome: string; equityCode: string };
      expect(created.netIncome).toBe('700.00');

      const after = await balanceSheet(ctx, '2024-12-31');
      // THE invariant: total equity is unchanged — the profit moved from the
      // derived net-income line into a real 3000 balance.
      expect(after.totalEquity).toBe(before.totalEquity);
      expect(after.totalAssets).toBe(before.totalAssets);
      expect(after.balanced).toBe(true);
      expect(after.netIncome).toBe('0.00');
      const equityByCode = new Map(after.equity.map((l) => [l.code, l.amount]));
      expect(equityByCode.get('3000')).toBe('700.00');

      // The closing entry is dated inside the closed year, so a P&L for that
      // year would see its flip lines and report zero unless it excludes them.
      const pl = await profitLoss(ctx, '2024-01-01', '2024-12-31');
      expect(pl.totalRevenue).toBe('1000.00');
      expect(pl.totalExpenses).toBe('300.00');
      expect(pl.netProfit).toBe('700.00');
    } finally {
      await close();
    }
  });

  it('locks the year: a backdated expense is rejected with 409 period_closed', async () => {
    const { ctx, close } = await setup('pc-lock@example.com');
    try {
      await seedTradingYear(ctx);
      expect((await closeYear(ctx)).status).toBe(201);

      // An ordinary domain route, not the ledger portal — the lock lives in the
      // posting funnel so every route inherits it.
      const res = await spend(ctx, IN_YEAR, '50.00', 'Late receipt', ctx.fuelId);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; closedThrough: string };
      expect(body.error).toBe('period_closed');
      expect(body.closedThrough).toBe('2025-01-01T00:00:00.000Z');

      // The open year is unaffected.
      const open = await spend(ctx, IN_NEXT_YEAR, '50.00', 'Still open', ctx.fuelId);
      expect(open.status).toBe(201);
    } finally {
      await close();
    }
  });

  it('a draw rolls into equity alongside the profit', async () => {
    const { ctx, close } = await setup('pc-draw@example.com');
    try {
      await seedTradingYear(ctx);
      await req(ctx, '/api/owner-money', {
        method: 'POST',
        body: JSON.stringify({
          companyId: ctx.companyId,
          kind: 'draw',
          amount: '200.00',
          occurredOn: IN_YEAR,
        }),
      });

      const before = await balanceSheet(ctx, '2024-12-31');
      expect(before.balanced).toBe(true);

      const created = (await (await closeYear(ctx)).json()) as {
        netIncome: string;
        withdrawals: string;
      };
      // Withdrawals move equity but are not profit — they must not distort the
      // reported figure.
      expect(created.netIncome).toBe('700.00');
      expect(created.withdrawals).toBe('200.00');

      const after = await balanceSheet(ctx, '2024-12-31');
      expect(after.balanced).toBe(true);
      expect(after.totalEquity).toBe(before.totalEquity);
      const equityByCode = new Map(after.equity.map((l) => [l.code, l.amount]));
      // 700 profit − 200 taken out, and the draw account is back to zero.
      expect(equityByCode.get('3000')).toBe('500.00');
      expect(equityByCode.has('3100')).toBe(false);
    } finally {
      await close();
    }
  });

  it('re-opening reverses the close and unlocks the year', async () => {
    const { ctx, close } = await setup('pc-reopen@example.com');
    try {
      await seedTradingYear(ctx);
      const before = await balanceSheet(ctx, '2024-12-31');

      const created = (await (await closeYear(ctx)).json()) as { id: string };
      const reopen = await req(ctx, `/api/ledger/period-closes/${created.id}/reopen`, {
        method: 'POST',
      });
      expect(reopen.status).toBe(200);

      // Back to a derived net income, with the same totals as before the close.
      const after = await balanceSheet(ctx, '2024-12-31');
      expect(after.netIncome).toBe(before.netIncome);
      expect(after.totalEquity).toBe(before.totalEquity);
      expect(after.balanced).toBe(true);

      // And the year accepts postings again.
      const res = await spend(ctx, IN_YEAR, '50.00', 'Now allowed', ctx.fuelId);
      expect(res.status).toBe(201);

      // Soft-deleted, so the year can be closed again.
      const rows = await getTestDb()
        .select({ deletedAt: periodCloses.deletedAt })
        .from(periodCloses)
        .where(eq(periodCloses.id, created.id));
      expect(rows[0]?.deletedAt).not.toBeNull();
      expect((await closeYear(ctx)).status).toBe(201);
    } finally {
      await close();
    }
  });

  it('closing a second year rolls only that year, not the already-closed one', async () => {
    const { ctx, close } = await setup('pc-two-years@example.com');
    try {
      await seedTradingYear(ctx);
      expect((await closeYear(ctx, CLOSED_YEAR)).status).toBe(201);

      // The following year: 400.00 of expense and nothing else.
      await spend(ctx, IN_NEXT_YEAR, '400.00', 'Next year fuel', ctx.fuelId);

      const created = (await (await closeYear(ctx, NEXT_YEAR)).json()) as { netIncome: string };
      // Only the second year's loss — the first year's 700 profit was already
      // rolled and must not be counted twice.
      expect(created.netIncome).toBe('-400.00');

      const after = await balanceSheet(ctx, '2025-12-31');
      expect(after.balanced).toBe(true);
      const equityByCode = new Map(after.equity.map((l) => [l.code, l.amount]));
      expect(equityByCode.get('3000')).toBe('300.00');
    } finally {
      await close();
    }
  });

  it('refuses a year that has not finished, a repeat close, and an out-of-order re-open', async () => {
    const { ctx, close } = await setup('pc-guards@example.com');
    try {
      await seedTradingYear(ctx);

      const future = await closeYear(ctx, new Date().getUTCFullYear());
      expect(future.status).toBe(409);
      expect(((await future.json()) as { error: string }).error).toBe('year_not_finished');

      const first = (await (await closeYear(ctx, CLOSED_YEAR)).json()) as { id: string };
      const repeat = await closeYear(ctx, CLOSED_YEAR);
      expect(repeat.status).toBe(409);
      expect(((await repeat.json()) as { error: string }).error).toBe('already_closed');

      // The following year needs its own activity — an empty span has no
      // balanced entry to post, which is its own 409.
      const empty = await closeYear(ctx, NEXT_YEAR);
      expect(empty.status).toBe(409);
      expect(((await empty.json()) as { error: string }).error).toBe('nothing_to_close');

      await spend(ctx, IN_NEXT_YEAR, '25.00', 'Following year', ctx.fuelId);
      expect((await closeYear(ctx, NEXT_YEAR)).status).toBe(201);
      // The later year is still closed, so re-opening the first would leave
      // it locked anyway.
      const reopen = await req(ctx, `/api/ledger/period-closes/${first.id}/reopen`, {
        method: 'POST',
      });
      expect(reopen.status).toBe(409);
      expect(((await reopen.json()) as { error: string }).error).toBe('later_year_still_closed');
    } finally {
      await close();
    }
  });
});
