import { authUser, chartOfAccounts, companies, memberships } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Tax worksheet (TMC-155 for Schedule C, TMC-162 for the other three forms).
//
// Two surfaces here. The first is the cash/accrual split: the GL is always
// accrual, so cash basis is a read-time lens, and these assert the lens actually
// moves money between tax years — a paid-in-January invoice must not land in the
// prior year's return on cash basis, and an unpaid bill must not be deducted
// before it's paid. Those run against Schedule C via the legacy alias, which
// doubles as the regression test that the alias still returns the shape shipped
// mobile builds parse.
//
// The second is form dispatch: a partnership, S-corp and C-corp each get their
// own return off the same endpoint, with the accounts landing on that form's
// line numbers.

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

// --- The generalised endpoint ---------------------------------------------

type Worksheet = {
  form: string;
  formCode: string;
  year: number;
  basis: string;
  from: string;
  to: string;
  income: WorksheetRow[];
  deductions: WorksheetRow[];
  unmappedExpenses: { code: string; name: string; amount: string }[];
  totalDeductions: string;
  netIncome: string;
};

type WorksheetRow = {
  line: string;
  label: string;
  role: string;
  amount: string | null;
  accounts: { code: string; name: string; amount: string }[];
  itemized?: true;
  userSupplied?: true;
  subLine?: true;
};

// A second company on the same account, seeded with the chart for its business
// type. The signup company is always sole-prop, so every non-Schedule-C case
// needs one of these.
async function companyOfType(ctx: Ctx, name: string, businessType: string): Promise<string> {
  const res = await ctx.app.request('/api/companies', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({ name, businessType }),
  });
  if (res.status !== 201)
    throw new Error(`company create failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function getWorksheet(ctx: Ctx, companyId: string, query = ''): Promise<Worksheet> {
  const res = await ctx.app.request(`/api/companies/${companyId}/tax-worksheet${query}`, {
    headers: headers(ctx),
  });
  if (res.status !== 200)
    throw new Error(`tax-worksheet failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as Worksheet;
}

function row(w: Worksheet, id: string): WorksheetRow {
  const found = [...w.income, ...w.deductions].find((r) => r.line === id);
  if (!found) throw new Error(`line ${id} missing from ${w.form}`);
  return found;
}

// Posts a direct expense against a specific company (the shared `expense` helper
// is pinned to ctx.companyId, which is always the sole-prop signup company).
async function expenseFor(
  ctx: Ctx,
  companyId: string,
  opts: { categoryCode: string; amount: string; expenseDate: string },
): Promise<void> {
  const categoryAccountId = await coaId(companyId, opts.categoryCode);
  const paymentAccountId = await coaId(companyId, '1000');
  const res = await ctx.app.request('/api/expenses', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId,
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

describe('GET /api/companies/:id/tax-worksheet', () => {
  beforeEach(resetDb);

  it('gives a sole proprietor Schedule C', async () => {
    const { ctx, close } = await setup('tw-sole@example.com');
    try {
      const w = await getWorksheet(ctx, ctx.companyId, '?year=2026');
      expect(w.formCode).toBe('schedule_c');
      expect(w.form).toBe('Schedule C (Form 1040)');
      expect(w.deductions.at(0)?.line).toBe('8');
      expect(w.deductions.at(-1)?.line).toBe('31');
    } finally {
      await close();
    }
  });

  it('gives a partnership Form 1065, with the chart on 1065 line numbers', async () => {
    const { ctx, close } = await setup('tw-partnership@example.com');
    try {
      const id = await companyOfType(ctx, 'Two Guys Landscaping', 'partnership');
      // 6700 Office Expense has no dedicated line on the 1065 — it lands on the
      // catch-all. 6900 Repairs does have one, line 11.
      await expenseFor(ctx, id, {
        categoryCode: '6700',
        amount: '240.00',
        expenseDate: '2026-05-01',
      });
      await expenseFor(ctx, id, {
        categoryCode: '6900',
        amount: '175.00',
        expenseDate: '2026-05-02',
      });

      const w = await getWorksheet(ctx, id, '?year=2026&basis=cash');
      expect(w.formCode).toBe('1065');
      expect(w.form).toBe('Form 1065');
      expect(row(w, '11').amount).toBe('175.00');
      // 21, not 20 — line 20 is the energy efficient buildings deduction as of
      // TY2023, which is what TMC-167 corrected.
      expect(row(w, '21').amount).toBe('240.00');
      expect(row(w, '20').amount).toBe('0.00');
      expect(row(w, '22').role).toBe('totalDeductions');
      expect(w.totalDeductions).toBe('415.00');
      expect(row(w, '23').amount).toBe('-415.00');
      // Income runs 1a–8 on this form, not 1–7.
      expect(w.income.at(0)?.line).toBe('1a');
      expect(w.income.at(-1)?.line).toBe('8');
    } finally {
      await close();
    }
  });

  // The point of the whole ticket: 13 of the 1065's 23 mapped accounts land on
  // line 20, so the statement attached to it is the real deliverable. A
  // worksheet that says "Other deductions: $2,433.72" and stops is useless.
  it('itemises the accounts behind the catch-all line', async () => {
    const { ctx, close } = await setup('tw-itemised@example.com');
    try {
      const id = await companyOfType(ctx, 'Partners LLC', 'partnership');
      for (const [code, amount] of [
        ['6700', '240.00'],
        ['7000', '1105.60'],
        ['7400', '88.12'],
      ] as const) {
        await expenseFor(ctx, id, { categoryCode: code, amount, expenseDate: '2026-06-01' });
      }

      const w = await getWorksheet(ctx, id, '?year=2026&basis=cash');
      const other = row(w, '21');
      expect(other.itemized).toBe(true);
      expect(other.amount).toBe('1433.72');
      expect(other.accounts.map((a) => a.code)).toEqual(['6700', '7000', '7400']);
      expect(other.accounts.map((a) => a.amount)).toEqual(['240.00', '1105.60', '88.12']);
    } finally {
      await close();
    }
  });

  it('gives an S-corp Form 1120-S, where advertising has its own line', async () => {
    const { ctx, close } = await setup('tw-scorp@example.com');
    try {
      const id = await companyOfType(ctx, 'Scorp Inc', 's_corp');
      // Advertising is line 16 on the 1120-S but has no line at all on the
      // 1065 — the clearest signal the right form's table is in play.
      await expenseFor(ctx, id, {
        categoryCode: '6000',
        amount: '500.00',
        expenseDate: '2026-02-01',
      });

      const w = await getWorksheet(ctx, id, '?year=2026&basis=cash');
      expect(w.formCode).toBe('1120s');
      expect(row(w, '16').amount).toBe('500.00');
      expect(row(w, '20').itemized).toBe(true);
      expect(row(w, '19').amount).toBe('0.00');
      expect(w.totalDeductions).toBe('500.00');
      // Officer compensation renders at zero until payroll (TMC-161) lands —
      // the line must be visible, not omitted.
      expect(row(w, '7').label).toBe('Compensation of officers');
      expect(row(w, '7').amount).toBe('0.00');
    } finally {
      await close();
    }
  });

  // The correctness bug this ticket had to fix. 7800 Income Tax Expense is a
  // real expense account mapped to line 31; income tax is NOT deductible on the
  // corporation's own return, so letting it into total deductions understates
  // taxable income by exactly the tax.
  it('keeps a C-corp income tax expense off total deductions', async () => {
    const { ctx, close } = await setup('tw-ccorp@example.com');
    try {
      const id = await companyOfType(ctx, 'Ccorp Inc', 'c_corp');
      // The contact has to belong to the same company as the invoice.
      const contactRes = await ctx.app.request('/api/contacts', {
        method: 'POST',
        headers: headers(ctx),
        body: JSON.stringify({ companyId: id, name: 'Client' }),
      });
      expect(contactRes.status).toBe(201);
      const cust = ((await contactRes.json()) as { id: string }).id;
      const inv = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: headers(ctx),
        body: JSON.stringify({
          companyId: id,
          contactId: cust,
          number: 'INV-CC-1',
          issueDate: '2026-03-01',
          dueDate: '2026-03-01',
          subtotal: '10000.00',
          tax: '0.00',
          total: '10000.00',
          lineItems: [
            {
              position: 1,
              description: 'Service',
              quantity: '1',
              unitPrice: '10000.00',
              amount: '10000.00',
            },
          ],
        }),
      });
      expect(inv.status).toBe(201);
      const invId = ((await inv.json()) as { id: string }).id;
      await post(ctx, `/api/invoices/${invId}/mark-sent`);
      await post(ctx, `/api/invoices/${invId}/mark-paid`, {
        method: 'cash',
        paidOn: '2026-03-05',
      });

      await expenseFor(ctx, id, {
        categoryCode: '7000',
        amount: '1000.00',
        expenseDate: '2026-04-01',
      });
      await expenseFor(ctx, id, {
        categoryCode: '7800',
        amount: '4200.00',
        expenseDate: '2026-04-02',
      });

      const w = await getWorksheet(ctx, id, '?year=2026&basis=cash');
      expect(w.formCode).toBe('1120');
      expect(row(w, '31').amount).toBe('4200.00');
      expect(row(w, '26').amount).toBe('1000.00');
      // 1000, not 5200.
      expect(w.totalDeductions).toBe('1000.00');
      expect(row(w, '27').amount).toBe('1000.00');
      // Taxable income = 10000 − 1000. If the tax had leaked into deductions
      // this would read 4800.00.
      expect(row(w, '28').amount).toBe('9000.00');
      expect(w.netIncome).toBe('9000.00');
      // 29a/29b/29c have no data model — blank, never a confident 0.00.
      expect(row(w, '29c').amount).toBeNull();
      expect(row(w, '29c').userSupplied).toBe(true);
    } finally {
      await close();
    }
  });

  // Form 1065 line 21 sums the right-hand column, where 16c is the entry — not
  // 16a. A reader adding up the column must not double-count depreciation.
  it('nets the 1065 depreciation sub-lines into 16c', async () => {
    const { ctx, close } = await setup('tw-depreciation@example.com');
    try {
      const id = await companyOfType(ctx, 'Depreciating Partners', 'partnership');
      await expenseFor(ctx, id, {
        categoryCode: '6350',
        amount: '900.00',
        expenseDate: '2026-08-01',
      });

      const w = await getWorksheet(ctx, id, '?year=2026&basis=cash');
      expect(row(w, '16a').amount).toBe('900.00');
      expect(row(w, '16a').subLine).toBe(true);
      expect(row(w, '16b').amount).toBe('0.00');
      expect(row(w, '16c').amount).toBe('900.00');
      // Counted once.
      expect(w.totalDeductions).toBe('900.00');
    } finally {
      await close();
    }
  });

  // Shipped mobile binaries call /schedule-c and cannot be upgraded in place, so
  // the alias has to keep behaving exactly as it did — including refusing a
  // business that doesn't file one.
  it('still 409s the legacy alias for a business that files another form', async () => {
    const { ctx, close } = await setup('tw-alias@example.com');
    try {
      const id = await companyOfType(ctx, 'Alias Partners', 'partnership');
      const res = await ctx.app.request(`/api/companies/${id}/schedule-c?year=2026`, {
        headers: headers(ctx),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'wrong_tax_form', taxForm: 'Form 1065' });

      // ...while the generalised endpoint serves that same company its own form.
      const w = await getWorksheet(ctx, id, '?year=2026');
      expect(w.formCode).toBe('1065');
    } finally {
      await close();
    }
  });

  // An account whose mapping names a form the company doesn't file must land in
  // "review these", not on whatever that line number happens to mean here.
  it('refuses a mapping that names a different form', async () => {
    const { ctx, close } = await setup('tw-stale@example.com');
    try {
      const id = await companyOfType(ctx, 'Stale Mapping Inc', 'c_corp');
      const db = getTestDb();
      // Line 7 is gross royalties on the 1120 and officer compensation on the
      // 1120-S. A parser that resolved /1120/ loosely would put $5,000 of wages
      // onto an income line.
      await db
        .update(chartOfAccounts)
        .set({ taxMapping: 'Form 1120-S, Line 7' })
        .where(and(eq(chartOfAccounts.companyId, id), eq(chartOfAccounts.code, '7450')));
      await expenseFor(ctx, id, {
        categoryCode: '7450',
        amount: '5000.00',
        expenseDate: '2026-09-01',
      });

      const w = await getWorksheet(ctx, id, '?year=2026&basis=cash');
      expect(row(w, '12').amount).toBe('0.00');
      expect(w.unmappedExpenses).toEqual([
        { code: '7450', name: 'Officer Compensation', amount: '5000.00' },
      ]);
      // Still counted, so the total keeps agreeing with the P&L.
      expect(w.totalDeductions).toBe('5000.00');
    } finally {
      await close();
    }
  });

  it('rejects a bad basis, a bad year, and a foreign company', async () => {
    const { ctx, close } = await setup('tw-validation@example.com');
    try {
      const bad = await ctx.app.request(
        `/api/companies/${ctx.companyId}/tax-worksheet?basis=hybrid`,
        { headers: headers(ctx) },
      );
      expect(bad.status).toBe(400);

      const missing = await ctx.app.request(`/api/companies/${uuidv7()}/tax-worksheet?year=2026`, {
        headers: headers(ctx),
      });
      expect(missing.status).toBe(404);
    } finally {
      await close();
    }
  });
});
