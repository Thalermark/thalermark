import {
  authUser,
  chartOfAccounts,
  companies,
  contacts,
  expenses,
  journalEntries,
  journalLines,
  memberships,
} from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// 8.9c — expense CRUD + ledger wiring. Asserts the full chain (create →
// balanced Dr category / Cr payment entry; edit → reversal + new entry;
// soft-delete → reversal) plus filters, account-type validation, and tenant
// isolation. Pure-policy coverage of expensePostingLines / reverseLedgerLines
// lives in apps/api/src/lib/ledger.test.ts.

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

async function signUp(app: ReturnType<typeof createApp>, email: string) {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`);
  return extractSessionCookie(res);
}

async function userContext(email: string) {
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

// Resolve a chart_of_accounts row id by its 4-digit code for a company. The
// API takes COA row UUIDs (the form picks them); tests look them up by code.
async function coaId(companyId: string, code: string): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.companyId, companyId), eq(chartOfAccounts.code, code)));
  if (!row) throw new Error(`COA ${code} not seeded for company ${companyId}`);
  return row.id;
}

function expenseBody(over: Record<string, unknown> = {}) {
  return {
    amount: '42.50',
    expenseDate: '2026-05-20',
    merchant: 'Home Depot',
    ...over,
  };
}

async function createExpense(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request('/api/expenses', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function entriesFor(expenseId: string) {
  const db = getTestDb();
  return db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.sourceEntityId, expenseId))
    .orderBy(journalEntries.postedAt);
}

async function linesFor(entryId: string) {
  const db = getTestDb();
  return db
    .select({
      side: journalLines.side,
      amount: journalLines.amount,
      code: chartOfAccounts.code,
    })
    .from(journalLines)
    .leftJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
    .where(eq(journalLines.journalEntryId, entryId));
}

describe('expenses — CRUD + ledger', () => {
  beforeEach(resetDb);

  it('create posts Dr <category> / Cr <payment> and returns the row', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'exp-create@example.com');
      const { accountId, companyId } = await userContext('exp-create@example.com');
      const category = await coaId(companyId, '6000'); // Advertising (expense)
      const payment = await coaId(companyId, '1000'); // Cash (asset)

      const res = await createExpense(
        ctx.app,
        cookie,
        accountId,
        expenseBody({ companyId, categoryAccountId: category, paymentAccountId: payment }),
      );
      expect(res.status).toBe(201);
      const row = (await res.json()) as { id: string; amount: string; merchant: string };
      expect(row.amount).toBe('42.50');
      expect(row.merchant).toBe('Home Depot');

      const entries = await entriesFor(row.id);
      expect(entries).toHaveLength(1);
      const lines = await linesFor(entries[0]?.id as string);
      const byCode = new Map(lines.map((l) => [l.code, l]));
      expect(byCode.get('6000')).toMatchObject({ side: 'debit', amount: '42.50' });
      expect(byCode.get('1000')).toMatchObject({ side: 'credit', amount: '42.50' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a non-expense category and a non-asset payment account', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'exp-badtype@example.com');
      const { accountId, companyId } = await userContext('exp-badtype@example.com');
      const cash = await coaId(companyId, '1000'); // asset
      const advertising = await coaId(companyId, '6000'); // expense

      // Cash (asset) as the category → invalid_category_account
      const r1 = await createExpense(
        ctx.app,
        cookie,
        accountId,
        expenseBody({ companyId, categoryAccountId: cash, paymentAccountId: cash }),
      );
      expect(r1.status).toBe(400);
      expect((await r1.json()) as { error: string }).toMatchObject({
        error: 'invalid_category_account',
      });

      // Advertising (expense) as the payment account → invalid_payment_account
      const r2 = await createExpense(
        ctx.app,
        cookie,
        accountId,
        expenseBody({ companyId, categoryAccountId: advertising, paymentAccountId: advertising }),
      );
      expect(r2.status).toBe(400);
      expect((await r2.json()) as { error: string }).toMatchObject({
        error: 'invalid_payment_account',
      });
    } finally {
      await ctx.handle.close();
    }
  });

  it('404s on an unknown company', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'exp-nocompany@example.com');
      const { accountId, companyId } = await userContext('exp-nocompany@example.com');
      const category = await coaId(companyId, '6000');
      const payment = await coaId(companyId, '1000');

      const res = await createExpense(
        ctx.app,
        cookie,
        accountId,
        expenseBody({
          companyId: '00000000-0000-7000-8000-0000000000aa',
          categoryAccountId: category,
          paymentAccountId: payment,
        }),
      );
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'company_not_found' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('lists with companyId / date-range / merchant / category filters and hides soft-deleted', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'exp-list@example.com');
      const { accountId, companyId } = await userContext('exp-list@example.com');
      const advertising = await coaId(companyId, '6000');
      const carTruck = await coaId(companyId, '6100');
      const payment = await coaId(companyId, '1000');

      const mk = (over: Record<string, unknown>) =>
        createExpense(ctx.app, cookie, accountId, expenseBody({ companyId, ...over }));

      await mk({
        categoryAccountId: advertising,
        paymentAccountId: payment,
        merchant: 'Facebook Ads',
        expenseDate: '2026-01-10',
        amount: '10.00',
      });
      await mk({
        categoryAccountId: carTruck,
        paymentAccountId: payment,
        merchant: 'Shell Gas',
        expenseDate: '2026-05-15',
        amount: '60.00',
      });
      const delRes = await mk({
        categoryAccountId: advertising,
        paymentAccountId: payment,
        merchant: 'Old Banner Co',
        expenseDate: '2026-05-16',
        amount: '5.00',
      });
      const toDelete = ((await delRes.json()) as { id: string }).id;

      const list = async (qs: string) => {
        const r = await ctx.app.request(`/api/expenses${qs}`, {
          headers: { cookie, 'x-account-id': accountId },
        });
        expect(r.status).toBe(200);
        return ((await r.json()) as { expenses: { id: string; merchant: string }[] }).expenses;
      };

      // All three present, newest expense_date first.
      const all = await list(`?companyId=${companyId}`);
      expect(all.map((e) => e.merchant)).toEqual(['Old Banner Co', 'Shell Gas', 'Facebook Ads']);

      // Date range (inclusive) drops the January row.
      const ranged = await list(`?companyId=${companyId}&from=2026-05-01&to=2026-05-31`);
      expect(ranged.map((e) => e.merchant)).toEqual(['Old Banner Co', 'Shell Gas']);

      // Merchant contains-search.
      const searched = await list(`?companyId=${companyId}&q=gas`);
      expect(searched.map((e) => e.merchant)).toEqual(['Shell Gas']);

      // Category filter.
      const byCat = await list(`?companyId=${companyId}&categoryAccountId=${carTruck}`);
      expect(byCat.map((e) => e.merchant)).toEqual(['Shell Gas']);

      // Soft-delete hides the row from the list.
      const del = await ctx.app.request(`/api/expenses/${toDelete}`, {
        method: 'DELETE',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(del.status).toBe(200);
      const afterDelete = await list(`?companyId=${companyId}`);
      expect(afterDelete.map((e) => e.merchant)).toEqual(['Shell Gas', 'Facebook Ads']);

      // Malformed date bound → clean 400.
      const bad = await ctx.app.request('/api/expenses?from=garbage', {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(bad.status).toBe(400);
    } finally {
      await ctx.handle.close();
    }
  });

  it('edit reverses the prior posting and posts a fresh one', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'exp-edit@example.com');
      const { accountId, companyId } = await userContext('exp-edit@example.com');
      const advertising = await coaId(companyId, '6000');
      const carTruck = await coaId(companyId, '6100');
      const payment = await coaId(companyId, '1000');

      const created = await createExpense(
        ctx.app,
        cookie,
        accountId,
        expenseBody({
          companyId,
          categoryAccountId: advertising,
          paymentAccountId: payment,
          amount: '100.00',
        }),
      );
      const id = ((await created.json()) as { id: string }).id;

      // Recategorise + change the amount.
      const patch = await ctx.app.request(`/api/expenses/${id}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ categoryAccountId: carTruck, amount: '150.00' }),
      });
      expect(patch.status).toBe(200);
      const updated = (await patch.json()) as { amount: string; categoryAccountId: string };
      expect(updated.amount).toBe('150.00');
      expect(updated.categoryAccountId).toBe(carTruck);

      // Three entries: original create, reversal, new create.
      const entries = await entriesFor(id);
      expect(entries).toHaveLength(3);

      // Net by code across every line must zero out per side: the original
      // create (Dr 6000 100 / Cr 1000 100) is undone by the reversal (Cr 6000
      // 100 / Dr 1000 100); the new create books Dr 6100 150 / Cr 1000 150.
      const allLines = (await Promise.all(entries.map((e) => linesFor(e.id)))).flat();
      const net = new Map<string, number>();
      for (const l of allLines) {
        const signed = (l.side === 'debit' ? 1 : -1) * Number(l.amount);
        net.set(l.code as string, (net.get(l.code as string) ?? 0) + signed);
      }
      expect(net.get('6000')).toBe(0); // old category fully reversed
      expect(net.get('6100')).toBe(150); // new category debited
      expect(net.get('1000')).toBe(-150); // cash net credit = new total
    } finally {
      await ctx.handle.close();
    }
  });

  it('soft-delete posts a reversal and the GL nets to zero', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'exp-del@example.com');
      const { accountId, companyId } = await userContext('exp-del@example.com');
      const advertising = await coaId(companyId, '6000');
      const payment = await coaId(companyId, '1000');

      const created = await createExpense(
        ctx.app,
        cookie,
        accountId,
        expenseBody({
          companyId,
          categoryAccountId: advertising,
          paymentAccountId: payment,
          amount: '80.00',
        }),
      );
      const id = ((await created.json()) as { id: string }).id;

      const del = await ctx.app.request(`/api/expenses/${id}`, {
        method: 'DELETE',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(del.status).toBe(200);

      // Row stays, marked deleted.
      const db = getTestDb();
      const [row] = await db.select().from(expenses).where(eq(expenses.id, id));
      expect(row?.deletedAt).not.toBeNull();

      // GET one now 404s.
      const getOne = await ctx.app.request(`/api/expenses/${id}`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(getOne.status).toBe(404);

      // Create + reversal = two entries, net zero per account.
      const entries = await entriesFor(id);
      expect(entries).toHaveLength(2);
      const allLines = (await Promise.all(entries.map((e) => linesFor(e.id)))).flat();
      const net = new Map<string, number>();
      for (const l of allLines) {
        const signed = (l.side === 'debit' ? 1 : -1) * Number(l.amount);
        net.set(l.code as string, (net.get(l.code as string) ?? 0) + signed);
      }
      expect(net.get('6000')).toBe(0);
      expect(net.get('1000')).toBe(0);

      // Double-delete → 404 (already deleted).
      const again = await ctx.app.request(`/api/expenses/${id}`, {
        method: 'DELETE',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(again.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });

  // TMC-240: the round trip. The delete above proves the books survive a delete;
  // this proves they survive the undo, which is what makes the soft delete worth
  // keeping the row for.
  it('restore reposts the expense and the GL returns to where it started', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'exp-restore@example.com');
      const { accountId, companyId } = await userContext('exp-restore@example.com');
      const advertising = await coaId(companyId, '6000');
      const payment = await coaId(companyId, '1000');

      const created = await createExpense(
        ctx.app,
        cookie,
        accountId,
        expenseBody({
          companyId,
          categoryAccountId: advertising,
          paymentAccountId: payment,
          amount: '80.00',
        }),
      );
      const id = ((await created.json()) as { id: string }).id;

      await ctx.app.request(`/api/expenses/${id}`, {
        method: 'DELETE',
        headers: { cookie, 'x-account-id': accountId },
      });

      // The show-deleted list is the only place the row is reachable from.
      const hidden = (await (
        await ctx.app.request(`/api/expenses?companyId=${companyId}`, {
          headers: { cookie, 'x-account-id': accountId },
        })
      ).json()) as { expenses: unknown[] };
      expect(hidden.expenses).toHaveLength(0);
      const shown = (await (
        await ctx.app.request(`/api/expenses?companyId=${companyId}&includeDeleted=true`, {
          headers: { cookie, 'x-account-id': accountId },
        })
      ).json()) as { expenses: { id: string; deletedAt: string | null }[] };
      expect(shown.expenses).toHaveLength(1);
      expect(shown.expenses[0]?.deletedAt).not.toBeNull();

      const res = await ctx.app.request(`/api/expenses/${id}/restore`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);

      const db = getTestDb();
      const [row] = await db.select().from(expenses).where(eq(expenses.id, id));
      expect(row?.deletedAt).toBeNull();

      // Create + reversal + repost = three entries netting to one expense: the
      // same balances as before the delete, reached without rewriting history.
      const entries = await entriesFor(id);
      expect(entries).toHaveLength(3);
      const allLines = (await Promise.all(entries.map((e) => linesFor(e.id)))).flat();
      const net = new Map<string, number>();
      for (const l of allLines) {
        const signed = (l.side === 'debit' ? 1 : -1) * Number(l.amount);
        net.set(l.code as string, (net.get(l.code as string) ?? 0) + signed);
      }
      expect(net.get('6000')).toBe(80);
      expect(net.get('1000')).toBe(-80);

      // Reachable again through the ordinary reads.
      const getOne = await ctx.app.request(`/api/expenses/${id}`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(getOne.status).toBe(200);

      // Restoring a live expense is a no-op, not a second posting.
      const noop = await ctx.app.request(`/api/expenses/${id}/restore`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(noop.status).toBe(200);
      expect(await entriesFor(id)).toHaveLength(3);
    } finally {
      await ctx.handle.close();
    }
  });

  it('isolates expenses across accounts', async () => {
    const ctx = buildApp();
    try {
      const cookieA = await signUp(ctx.app, 'exp-a@example.com');
      const { accountId: accountA, companyId: companyA } = await userContext('exp-a@example.com');
      const category = await coaId(companyA, '6000');
      const payment = await coaId(companyA, '1000');
      const created = await createExpense(
        ctx.app,
        cookieA,
        accountA,
        expenseBody({
          companyId: companyA,
          categoryAccountId: category,
          paymentAccountId: payment,
        }),
      );
      const id = ((await created.json()) as { id: string }).id;

      const cookieB = await signUp(ctx.app, 'exp-b@example.com');
      const { accountId: accountB } = await userContext('exp-b@example.com');

      // B cannot read A's expense.
      const getB = await ctx.app.request(`/api/expenses/${id}`, {
        headers: { cookie: cookieB, 'x-account-id': accountB },
      });
      expect(getB.status).toBe(404);

      // B cannot delete A's expense.
      const delB = await ctx.app.request(`/api/expenses/${id}`, {
        method: 'DELETE',
        headers: { cookie: cookieB, 'x-account-id': accountB },
      });
      expect(delB.status).toBe(404);

      // B's list does not contain A's expense.
      const listB = await ctx.app.request('/api/expenses', {
        headers: { cookie: cookieB, 'x-account-id': accountB },
      });
      const bRows = ((await listB.json()) as { expenses: { id: string }[] }).expenses;
      expect(bRows.find((e) => e.id === id)).toBeUndefined();
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('expenses — vendor link + needs-review', () => {
  beforeEach(resetDb);

  async function seedContact(
    accountId: string,
    companyId: string,
    name: string,
    isVendor = false,
  ): Promise<string> {
    const db = getTestDb();
    const id = uuidv7();
    await db.insert(contacts).values({ id, accountId, companyId, name, isVendor });
    return id;
  }

  async function patchExpense(
    app: ReturnType<typeof createApp>,
    cookie: string,
    accountId: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return app.request(`/api/expenses/${id}`, {
      method: 'PATCH',
      headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  type ExpenseRow = {
    id: string;
    merchant: string;
    vendorContactId: string | null;
    vendorReview: string | null;
  };

  it('linking a vendor on create mirrors merchant, flips is_vendor, no review', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'vend-create@example.com');
      const { accountId, companyId } = await userContext('vend-create@example.com');
      const category = await coaId(companyId, '6000');
      const payment = await coaId(companyId, '1000');
      // Seeded as a customer-only contact — linking it as a vendor should flip
      // is_vendor (the buy-from half of the unified relationship).
      const vendorId = await seedContact(accountId, companyId, 'Acme Supply');

      const res = await createExpense(
        ctx.app,
        cookie,
        accountId,
        expenseBody({
          companyId,
          categoryAccountId: category,
          paymentAccountId: payment,
          merchant: 'typed-over',
          vendorContactId: vendorId,
        }),
      );
      expect(res.status).toBe(201);
      const row = (await res.json()) as ExpenseRow;
      expect(row.vendorContactId).toBe(vendorId);
      expect(row.merchant).toBe('Acme Supply'); // mirrored from the contact, not 'typed-over'
      expect(row.vendorReview).toBeNull();

      const db = getTestDb();
      const [linked] = await db.select().from(contacts).where(eq(contacts.id, vendorId));
      expect(linked?.isVendor).toBe(true);
    } finally {
      await ctx.handle.close();
    }
  });

  it('linking a vendor via PATCH clears the review flag and mirrors merchant', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'vend-link@example.com');
      const { accountId, companyId } = await userContext('vend-link@example.com');
      const category = await coaId(companyId, '6000');
      const payment = await coaId(companyId, '1000');
      const vendorId = await seedContact(accountId, companyId, 'Home Depot', true);

      const create = await createExpense(
        ctx.app,
        cookie,
        accountId,
        expenseBody({
          companyId,
          categoryAccountId: category,
          paymentAccountId: payment,
          merchant: 'HD #4412',
        }),
      );
      const { id } = (await create.json()) as { id: string };
      // Simulate a scanned-but-unlinked expense (receipt + needs_review).
      const db = getTestDb();
      await db
        .update(expenses)
        .set({ receiptStorageKey: 'fake-key', vendorReview: 'needs_review' })
        .where(eq(expenses.id, id));

      const res = await patchExpense(ctx.app, cookie, accountId, id, { vendorContactId: vendorId });
      expect(res.status).toBe(200);
      const row = (await res.json()) as ExpenseRow;
      expect(row.vendorContactId).toBe(vendorId);
      expect(row.merchant).toBe('Home Depot');
      expect(row.vendorReview).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('unlinking a vendor via PATCH re-flags when a receipt is attached', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'vend-unlink@example.com');
      const { accountId, companyId } = await userContext('vend-unlink@example.com');
      const category = await coaId(companyId, '6000');
      const payment = await coaId(companyId, '1000');
      const vendorId = await seedContact(accountId, companyId, 'Office Depot', true);

      const create = await createExpense(
        ctx.app,
        cookie,
        accountId,
        expenseBody({
          companyId,
          categoryAccountId: category,
          paymentAccountId: payment,
          vendorContactId: vendorId,
        }),
      );
      const { id } = (await create.json()) as { id: string };
      const db = getTestDb();
      await db.update(expenses).set({ receiptStorageKey: 'fake-key' }).where(eq(expenses.id, id));

      const res = await patchExpense(ctx.app, cookie, accountId, id, {
        vendorContactId: null,
        merchant: 'OFFICE DEPOT #91',
      });
      expect(res.status).toBe(200);
      const row = (await res.json()) as ExpenseRow;
      expect(row.vendorContactId).toBeNull();
      expect(row.merchant).toBe('OFFICE DEPOT #91');
      expect(row.vendorReview).toBe('needs_review');
    } finally {
      await ctx.handle.close();
    }
  });

  it('dismiss-review clears the flag without creating a contact', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'vend-dismiss@example.com');
      const { accountId, companyId } = await userContext('vend-dismiss@example.com');
      const category = await coaId(companyId, '6000');
      const payment = await coaId(companyId, '1000');
      const create = await createExpense(
        ctx.app,
        cookie,
        accountId,
        expenseBody({ companyId, categoryAccountId: category, paymentAccountId: payment }),
      );
      const { id } = (await create.json()) as { id: string };
      const db = getTestDb();
      await db.update(expenses).set({ vendorReview: 'needs_review' }).where(eq(expenses.id, id));
      const before = await db.select().from(contacts).where(eq(contacts.accountId, accountId));

      const res = await ctx.app.request(`/api/expenses/${id}/dismiss-review`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as ExpenseRow).vendorReview).toBeNull();

      const after = await db.select().from(contacts).where(eq(contacts.accountId, accountId));
      expect(after.length).toBe(before.length); // no contact created
    } finally {
      await ctx.handle.close();
    }
  });

  it('?needsReview=true returns only the flagged expenses', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'vend-filter@example.com');
      const { accountId, companyId } = await userContext('vend-filter@example.com');
      const category = await coaId(companyId, '6000');
      const payment = await coaId(companyId, '1000');
      const body = { companyId, categoryAccountId: category, paymentAccountId: payment };
      const flagged = (await (
        await createExpense(
          ctx.app,
          cookie,
          accountId,
          expenseBody({ ...body, merchant: 'Flag me' }),
        )
      ).json()) as { id: string };
      await createExpense(
        ctx.app,
        cookie,
        accountId,
        expenseBody({ ...body, merchant: 'Leave me' }),
      );
      const db = getTestDb();
      await db
        .update(expenses)
        .set({ vendorReview: 'needs_review' })
        .where(eq(expenses.id, flagged.id));

      const res = await ctx.app.request(`/api/expenses?companyId=${companyId}&needsReview=true`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      const rows = ((await res.json()) as { expenses: ExpenseRow[] }).expenses;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(flagged.id);
    } finally {
      await ctx.handle.close();
    }
  });
});
