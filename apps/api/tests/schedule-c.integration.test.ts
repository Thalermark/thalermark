import { authUser, chartOfAccounts, companies, memberships } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Schedule C worksheet (TMC-155). The interesting surface is the cash/accrual
// split: the GL is always accrual, so cash basis is a read-time lens. These
// assert that the lens actually moves money between tax years — a paid-in-
// January invoice must not land in the prior year's return on cash basis, and
// an unpaid bill must not be deducted before it's paid.

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

async function signUp(app: ReturnType<typeof createApp>, email: string) {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return extractSessionCookie(res);
}

async function userContext(email: string): Promise<{ accountId: string; companyId: string }> {
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
  if (!company) throw new Error(`default company for ${email} not seeded`);
  return { accountId: m.accountId, companyId: company.id };
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

type Ctx = {
  app: ReturnType<typeof createApp>;
  cookie: string;
  accountId: string;
  companyId: string;
};

async function setup(email: string): Promise<{ ctx: Ctx; close: () => Promise<void> }> {
  const { app, handle } = buildApp();
  const cookie = await signUp(app, email);
  const { accountId, companyId } = await userContext(email);
  return { ctx: { app, cookie, accountId, companyId }, close: handle.close };
}

function headers(ctx: Ctx) {
  return { cookie: ctx.cookie, 'x-account-id': ctx.accountId, 'content-type': 'application/json' };
}

async function coaId(companyId: string, code: string): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.companyId, companyId), eq(chartOfAccounts.code, code)));
  if (!row) throw new Error(`COA ${code} not seeded for company ${companyId}`);
  return row.id;
}

async function createContact(ctx: Ctx, name = 'Acme'): Promise<string> {
  const res = await ctx.app.request('/api/contacts', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({ companyId: ctx.companyId, name }),
  });
  if (res.status !== 201) throw new Error(`contact create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function post(ctx: Ctx, path: string, body?: unknown): Promise<void> {
  const res = await ctx.app.request(path, {
    method: 'POST',
    headers: headers(ctx),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status !== 200) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
}

// Issues an invoice and optionally settles it. `issueDate` drives the accrual
// posting date (mark-sent), `paidOn` the cash one — deliberately separable so a
// test can straddle a year boundary.
async function invoice(
  ctx: Ctx,
  contactId: string,
  opts: { number: string; subtotal: string; issueDate: string; paidOn?: string },
): Promise<string> {
  const res = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId,
      number: opts.number,
      issueDate: opts.issueDate,
      dueDate: opts.issueDate,
      subtotal: opts.subtotal,
      tax: '0.00',
      total: opts.subtotal,
      lineItems: [
        {
          position: 1,
          description: 'Service',
          quantity: '1',
          unitPrice: opts.subtotal,
          amount: opts.subtotal,
        },
      ],
    }),
  });
  if (res.status !== 201)
    throw new Error(`invoice create failed: ${res.status} ${await res.text()}`);
  const id = ((await res.json()) as { id: string }).id;
  await post(ctx, `/api/invoices/${id}/mark-sent`);
  if (opts.paidOn) {
    await post(ctx, `/api/invoices/${id}/mark-paid`, { method: 'cash', paidOn: opts.paidOn });
  }
  return id;
}

async function bill(
  ctx: Ctx,
  vendorId: string,
  opts: { categoryCode: string; amount: string; billDate: string; paidOn?: string },
): Promise<void> {
  const categoryAccountId = await coaId(ctx.companyId, opts.categoryCode);
  const res = await ctx.app.request('/api/bills', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId: vendorId,
      categoryAccountId,
      amount: opts.amount,
      billDate: opts.billDate,
      dueDate: opts.billDate,
    }),
  });
  if (res.status !== 201) throw new Error(`bill create failed: ${res.status} ${await res.text()}`);
  const id = ((await res.json()) as { id: string }).id;
  if (opts.paidOn) {
    await post(ctx, `/api/bills/${id}/mark-paid`, { method: 'check', paidOn: opts.paidOn });
  }
}

async function expense(
  ctx: Ctx,
  opts: { categoryCode: string; amount: string; expenseDate: string },
): Promise<void> {
  const categoryAccountId = await coaId(ctx.companyId, opts.categoryCode);
  const paymentAccountId = await coaId(ctx.companyId, '1000');
  const res = await ctx.app.request('/api/expenses', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      categoryAccountId,
      paymentAccountId,
      amount: opts.amount,
      expenseDate: opts.expenseDate,
      merchant: 'Vendor',
    }),
  });
  if (res.status !== 201)
    throw new Error(`expense create failed: ${res.status} ${await res.text()}`);
}

type ScheduleC = {
  year: number;
  basis: string;
  companyAccountingMethod: string;
  from: string;
  to: string;
  partI: { grossReceipts: string; grossIncome: string };
  partII: { line: string; label: string; amount: string; userSupplied?: true }[];
  unmappedExpenses: { code: string; name: string; amount: string }[];
  totalExpenses: string;
  tentativeProfit: string;
  homeOffice: null;
  netProfit: string;
};

async function getScheduleC(ctx: Ctx, query = ''): Promise<{ status: number; body: ScheduleC }> {
  const res = await ctx.app.request(`/api/companies/${ctx.companyId}/schedule-c${query}`, {
    headers: headers(ctx),
  });
  return { status: res.status, body: (await res.json()) as ScheduleC };
}

function line(body: ScheduleC, id: string): string {
  const row = body.partII.find((r) => r.line === id);
  if (!row) throw new Error(`line ${id} missing from Part II`);
  return row.amount;
}

describe('GET /api/companies/:id/schedule-c', () => {
  beforeEach(resetDb);

  it('defaults to the company accounting method, which defaults to cash', async () => {
    const { ctx, close } = await setup('sc-default@example.com');
    try {
      const { status, body } = await getScheduleC(ctx, '?year=2026');
      expect(status).toBe(200);
      expect(body.basis).toBe('cash');
      expect(body.companyAccountingMethod).toBe('cash');
      expect(body.from).toBe('2026-01-01');
      expect(body.to).toBe('2026-12-31');
    } finally {
      await close();
    }
  });

  it('emits the whole Part II skeleton zero-filled, with the blanks flagged', async () => {
    const { ctx, close } = await setup('sc-skeleton@example.com');
    try {
      const { body } = await getScheduleC(ctx, '?year=2026');
      // Lines we never seed still render — otherwise it reads as a filtered P&L.
      expect(line(body, '12')).toBe('0.00');
      expect(line(body, '14')).toBe('0.00');
      expect(line(body, '16a')).toBe('0.00');
      expect(line(body, '19')).toBe('0.00');
      // Car and truck: mileage is deferred, so it's the user's to fill in.
      expect(body.partII.find((r) => r.line === '9')?.userSupplied).toBe(true);
      // Home office has no data model — null, not a misleading 0.00.
      expect(body.homeOffice).toBeNull();
    } finally {
      await close();
    }
  });

  // The whole point of the basis toggle: an invoice sent in December and paid in
  // January belongs to different tax years depending on the method.
  it('moves a year-straddling invoice between years by basis', async () => {
    const { ctx, close } = await setup('sc-straddle@example.com');
    try {
      const cust = await createContact(ctx);
      await invoice(ctx, cust, {
        number: 'INV-1',
        subtotal: '8000.00',
        issueDate: '2026-12-20',
        paidOn: '2027-01-15',
      });

      const accrual2026 = await getScheduleC(ctx, '?year=2026&basis=accrual');
      expect(accrual2026.body.partI.grossReceipts).toBe('8000.00');
      const cash2026 = await getScheduleC(ctx, '?year=2026&basis=cash');
      expect(cash2026.body.partI.grossReceipts).toBe('0.00');

      const cash2027 = await getScheduleC(ctx, '?year=2027&basis=cash');
      expect(cash2027.body.partI.grossReceipts).toBe('8000.00');
      const accrual2027 = await getScheduleC(ctx, '?year=2027&basis=accrual');
      expect(accrual2027.body.partI.grossReceipts).toBe('0.00');
    } finally {
      await close();
    }
  });

  it('excludes an unpaid invoice from cash gross receipts', async () => {
    const { ctx, close } = await setup('sc-unpaid@example.com');
    try {
      const cust = await createContact(ctx);
      await invoice(ctx, cust, { number: 'INV-1', subtotal: '500.00', issueDate: '2026-03-01' });
      const { body } = await getScheduleC(ctx, '?year=2026&basis=cash');
      expect(body.partI.grossReceipts).toBe('0.00');
      expect(body.netProfit).toBe('0.00');
    } finally {
      await close();
    }
  });

  it('maps expenses onto their Schedule C lines', async () => {
    const { ctx, close } = await setup('sc-expenses@example.com');
    try {
      await expense(ctx, { categoryCode: '6000', amount: '150.00', expenseDate: '2026-04-01' });
      await expense(ctx, { categoryCode: '7000', amount: '75.50', expenseDate: '2026-04-02' });
      const { body } = await getScheduleC(ctx, '?year=2026&basis=cash');
      expect(line(body, '8')).toBe('150.00'); // Advertising
      expect(line(body, '22')).toBe('75.50'); // Supplies
      expect(body.totalExpenses).toBe('225.50');
      expect(body.unmappedExpenses).toEqual([]);
    } finally {
      await close();
    }
  });

  // A bill hits the expense account when opened (Dr category / Cr AP), so an
  // accrual filer deducts it immediately while a cash filer waits for payment.
  it('defers an unpaid bill on cash basis but not on accrual', async () => {
    const { ctx, close } = await setup('sc-bill@example.com');
    try {
      const vendor = await createContact(ctx, 'Ace Hardware');
      await bill(ctx, vendor, {
        categoryCode: '7000',
        amount: '300.00',
        billDate: '2026-06-01',
      });

      const accrual = await getScheduleC(ctx, '?year=2026&basis=accrual');
      expect(line(accrual.body, '22')).toBe('300.00');

      const cash = await getScheduleC(ctx, '?year=2026&basis=cash');
      expect(line(cash.body, '22')).toBe('0.00');
      expect(cash.body.totalExpenses).toBe('0.00');
    } finally {
      await close();
    }
  });

  it('deducts a bill on cash basis in the year it was paid', async () => {
    const { ctx, close } = await setup('sc-bill-paid@example.com');
    try {
      const vendor = await createContact(ctx, 'Ace Hardware');
      await bill(ctx, vendor, {
        categoryCode: '7000',
        amount: '300.00',
        billDate: '2026-12-01',
        paidOn: '2027-02-10',
      });

      expect(line((await getScheduleC(ctx, '?year=2026&basis=cash')).body, '22')).toBe('0.00');
      expect(line((await getScheduleC(ctx, '?year=2027&basis=cash')).body, '22')).toBe('300.00');
      // Accrual books it when the bill was opened, not paid.
      expect(line((await getScheduleC(ctx, '?year=2026&basis=accrual')).body, '22')).toBe('300.00');
      expect(line((await getScheduleC(ctx, '?year=2027&basis=accrual')).body, '22')).toBe('0.00');
    } finally {
      await close();
    }
  });

  // A direct expense and a paid bill can share a category; they must land on one
  // Part II row rather than two.
  it('merges a direct expense and a paid bill on the same line', async () => {
    const { ctx, close } = await setup('sc-merge@example.com');
    try {
      const vendor = await createContact(ctx, 'Ace Hardware');
      await expense(ctx, { categoryCode: '7000', amount: '25.00', expenseDate: '2026-05-01' });
      await bill(ctx, vendor, {
        categoryCode: '7000',
        amount: '100.00',
        billDate: '2026-05-02',
        paidOn: '2026-05-20',
      });
      const { body } = await getScheduleC(ctx, '?year=2026&basis=cash');
      expect(line(body, '22')).toBe('125.00');
      expect(body.totalExpenses).toBe('125.00');
    } finally {
      await close();
    }
  });

  it('computes net profit from gross receipts less total expenses', async () => {
    const { ctx, close } = await setup('sc-profit@example.com');
    try {
      const cust = await createContact(ctx);
      await invoice(ctx, cust, {
        number: 'INV-1',
        subtotal: '1000.00',
        issueDate: '2026-03-01',
        paidOn: '2026-03-15',
      });
      await expense(ctx, { categoryCode: '6000', amount: '250.00', expenseDate: '2026-04-01' });
      const { body } = await getScheduleC(ctx, '?year=2026&basis=cash');
      expect(body.partI.grossReceipts).toBe('1000.00');
      expect(body.partI.grossIncome).toBe('1000.00');
      expect(body.totalExpenses).toBe('250.00');
      expect(body.tentativeProfit).toBe('750.00');
      expect(body.netProfit).toBe('750.00');
    } finally {
      await close();
    }
  });

  it('honours a stored accrual election without a query override', async () => {
    const { ctx, close } = await setup('sc-elected@example.com');
    try {
      const patch = await ctx.app.request(`/api/companies/${ctx.companyId}`, {
        method: 'PATCH',
        headers: headers(ctx),
        body: JSON.stringify({ accountingMethod: 'accrual' }),
      });
      expect(patch.status).toBe(200);

      const cust = await createContact(ctx);
      await invoice(ctx, cust, { number: 'INV-1', subtotal: '400.00', issueDate: '2026-07-01' });

      const { body } = await getScheduleC(ctx, '?year=2026');
      expect(body.basis).toBe('accrual');
      expect(body.companyAccountingMethod).toBe('accrual');
      expect(body.partI.grossReceipts).toBe('400.00');
    } finally {
      await close();
    }
  });

  // RLS pins the account, not the company, so a company-scoped read that forgets
  // companyId silently spans every company on the account.
  it('scopes to the requested company, not the whole account', async () => {
    const { ctx, close } = await setup('sc-scope@example.com');
    try {
      const cust = await createContact(ctx);
      await invoice(ctx, cust, {
        number: 'INV-1',
        subtotal: '900.00',
        issueDate: '2026-03-01',
        paidOn: '2026-03-02',
      });

      const created = await ctx.app.request('/api/companies', {
        method: 'POST',
        headers: headers(ctx),
        body: JSON.stringify({ name: 'Second Co', businessType: 'sole_prop' }),
      });
      expect(created.status).toBe(201);
      const second = (await created.json()) as { id: string };

      const res = await ctx.app.request(`/api/companies/${second.id}/schedule-c?year=2026`, {
        headers: headers(ctx),
      });
      const body = (await res.json()) as ScheduleC;
      expect(body.partI.grossReceipts).toBe('0.00');
      expect(body.totalExpenses).toBe('0.00');
    } finally {
      await close();
    }
  });

  it('surfaces an expense account that maps to no Schedule C line', async () => {
    const { ctx, close } = await setup('sc-unmapped@example.com');
    try {
      // A custom expense account with no tax mapping — the v1.x entity-aware
      // seeds and hand-added accounts can both produce these.
      const db = getTestDb();
      await db.insert(chartOfAccounts).values({
        id: uuidv7(),
        accountId: ctx.accountId,
        companyId: ctx.companyId,
        code: '8100',
        name: 'Custom Thing',
        accountType: 'expense',
        normalBalance: 'debit',
        taxMapping: null,
      });
      await expense(ctx, { categoryCode: '8100', amount: '60.00', expenseDate: '2026-04-01' });

      const { body } = await getScheduleC(ctx, '?year=2026&basis=cash');
      expect(body.unmappedExpenses).toEqual([
        { code: '8100', name: 'Custom Thing', amount: '60.00' },
      ]);
      // Still counted, so line 28 keeps agreeing with the P&L.
      expect(body.totalExpenses).toBe('60.00');
    } finally {
      await close();
    }
  });

  it('rejects a bad basis, a bad year, and a foreign company', async () => {
    const { ctx, close } = await setup('sc-validation@example.com');
    try {
      const badBasis = await ctx.app.request(
        `/api/companies/${ctx.companyId}/schedule-c?basis=hybrid`,
        { headers: headers(ctx) },
      );
      expect(badBasis.status).toBe(400);

      const badYear = await ctx.app.request(
        `/api/companies/${ctx.companyId}/schedule-c?year=banana`,
        { headers: headers(ctx) },
      );
      expect(badYear.status).toBe(400);

      const missing = await ctx.app.request(`/api/companies/${uuidv7()}/schedule-c?year=2026`, {
        headers: headers(ctx),
      });
      expect(missing.status).toBe(404);
    } finally {
      await close();
    }
  });
});
