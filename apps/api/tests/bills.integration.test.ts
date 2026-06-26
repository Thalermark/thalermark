import {
  authUser,
  bills,
  chartOfAccounts,
  companies,
  contacts,
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

// Bills (accounts payable) — the accrual sibling of expenses. Asserts the full
// hidden-ledger chain: create → Dr <category> / Cr AP (2000); mark-paid → Dr AP
// / Cr <payment asset>; edit (open) → reversal + repost; void (open) → reversal.
// Plus the lifecycle guards, the AP aging report, and the dashboard "owing"
// figure (the AP balance). Pure posting-policy coverage lives in
// apps/api/src/lib/ledger.test.ts.

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

async function coaId(companyId: string, code: string): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.companyId, companyId), eq(chartOfAccounts.code, code)));
  if (!row) throw new Error(`COA ${code} not seeded for company ${companyId}`);
  return row.id;
}

// Seed a vendor contact directly (the test db bypasses RLS). The bill create
// would also flip is_vendor, but we set it here so the row is realistic.
async function makeVendor(accountId: string, companyId: string, name = 'Ace Hardware') {
  const db = getTestDb();
  const id = uuidv7();
  await db.insert(contacts).values({ id, accountId, companyId, name, isVendor: true });
  return id;
}

async function createBill(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request('/api/bills', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function billBody(over: Record<string, unknown> = {}) {
  return {
    amount: '320.00',
    billDate: '2026-06-01',
    dueDate: '2026-07-01',
    reference: 'INV-9912',
    ...over,
  };
}

async function entriesFor(billId: string) {
  const db = getTestDb();
  return db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.sourceEntityId, billId))
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

async function dashboard(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  companyId: string,
) {
  const res = await app.request(`/api/companies/${companyId}/dashboard`, {
    headers: { cookie, 'x-account-id': accountId },
  });
  return (await res.json()) as { owed: string; owing: string; moneyOut: string };
}

describe('bills — CRUD + ledger (accounts payable)', () => {
  beforeEach(resetDb);

  it('create posts Dr <category> / Cr Accounts Payable and returns an open bill', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'bill-create@example.com');
      const { accountId, companyId } = await userContext('bill-create@example.com');
      const vendor = await makeVendor(accountId, companyId);
      const category = await coaId(companyId, '7000'); // Supplies (expense)

      const res = await createBill(
        ctx.app,
        cookie,
        accountId,
        billBody({ companyId, contactId: vendor, categoryAccountId: category }),
      );
      expect(res.status).toBe(201);
      const row = (await res.json()) as { id: string; status: string; amount: string };
      expect(row.status).toBe('open');
      expect(row.amount).toBe('320.00');

      const entries = await entriesFor(row.id);
      expect(entries).toHaveLength(1);
      const lines = await linesFor(entries[0]?.id as string);
      const byCode = new Map(lines.map((l) => [l.code, l]));
      expect(byCode.get('7000')).toMatchObject({ side: 'debit', amount: '320.00' });
      expect(byCode.get('2000')).toMatchObject({ side: 'credit', amount: '320.00' });

      // "owing" on the dashboard is the AP balance.
      const dash = await dashboard(ctx.app, cookie, accountId, companyId);
      expect(dash.owing).toBe('320.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('mark-paid posts Dr AP / Cr Cash, flips status, and clears owing', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'bill-pay@example.com');
      const { accountId, companyId } = await userContext('bill-pay@example.com');
      const vendor = await makeVendor(accountId, companyId);
      const category = await coaId(companyId, '7000');

      const created = (await (
        await createBill(
          ctx.app,
          cookie,
          accountId,
          billBody({ companyId, contactId: vendor, categoryAccountId: category }),
        )
      ).json()) as { id: string };

      const res = await ctx.app.request(`/api/bills/${created.id}/mark-paid`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'check', reference: '1042', paidOn: '2026-06-15' }),
      });
      expect(res.status).toBe(200);
      const paid = (await res.json()) as { status: string; paymentMethod: string };
      expect(paid.status).toBe('paid');
      expect(paid.paymentMethod).toBe('check');

      // Two entries now: the open (Dr Supplies / Cr AP) + the payment (Dr AP /
      // Cr Cash). AP nets to zero; cash went out.
      const entries = await entriesFor(created.id);
      expect(entries).toHaveLength(2);
      const payLines = await linesFor(entries[1]?.id as string);
      const byCode = new Map(payLines.map((l) => [l.code, l]));
      expect(byCode.get('2000')).toMatchObject({ side: 'debit', amount: '320.00' });
      expect(byCode.get('1000')).toMatchObject({ side: 'credit', amount: '320.00' });

      const dash = await dashboard(ctx.app, cookie, accountId, companyId);
      expect(dash.owing).toBe('0.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('edit (open) reverses the prior posting and reposts the new amount', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'bill-edit@example.com');
      const { accountId, companyId } = await userContext('bill-edit@example.com');
      const vendor = await makeVendor(accountId, companyId);
      const category = await coaId(companyId, '7000');

      const created = (await (
        await createBill(
          ctx.app,
          cookie,
          accountId,
          billBody({ companyId, contactId: vendor, categoryAccountId: category }),
        )
      ).json()) as { id: string };

      const res = await ctx.app.request(`/api/bills/${created.id}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ amount: '500.00' }),
      });
      expect(res.status).toBe(200);

      // create + reversal + repost = 3 entries; AP balance nets to the new 500.
      const entries = await entriesFor(created.id);
      expect(entries).toHaveLength(3);
      const dash = await dashboard(ctx.app, cookie, accountId, companyId);
      expect(dash.owing).toBe('500.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('void (open) reverses the open posting; paid/voided are terminal', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'bill-void@example.com');
      const { accountId, companyId } = await userContext('bill-void@example.com');
      const vendor = await makeVendor(accountId, companyId);
      const category = await coaId(companyId, '7000');

      const created = (await (
        await createBill(
          ctx.app,
          cookie,
          accountId,
          billBody({ companyId, contactId: vendor, categoryAccountId: category }),
        )
      ).json()) as { id: string };

      const voidRes = await ctx.app.request(`/api/bills/${created.id}/void`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(voidRes.status).toBe(200);
      expect(((await voidRes.json()) as { status: string }).status).toBe('voided');

      const dash = await dashboard(ctx.app, cookie, accountId, companyId);
      expect(dash.owing).toBe('0.00');

      // A voided bill can't be voided again, paid, or edited.
      const reVoid = await ctx.app.request(`/api/bills/${created.id}/void`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(reVoid.status).toBe(409);

      const editAfter = await ctx.app.request(`/api/bills/${created.id}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ amount: '10.00' }),
      });
      expect(editAfter.status).toBe(409);
      expect(((await editAfter.json()) as { error: string }).error).toBe('bill_not_editable');
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a non-expense category account', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'bill-badcat@example.com');
      const { accountId, companyId } = await userContext('bill-badcat@example.com');
      const vendor = await makeVendor(accountId, companyId);
      const cash = await coaId(companyId, '1000'); // asset, not expense

      const res = await createBill(
        ctx.app,
        cookie,
        accountId,
        billBody({ companyId, contactId: vendor, categoryAccountId: cash }),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_category_account');
    } finally {
      await ctx.handle.close();
    }
  });

  it('AP aging buckets open bills by days past due', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'bill-aging@example.com');
      const { accountId, companyId } = await userContext('bill-aging@example.com');
      const vendor = await makeVendor(accountId, companyId);
      const category = await coaId(companyId, '7000');

      // One not-yet-due (current) and one long overdue (90+).
      const today = new Date();
      const future = new Date(today);
      future.setUTCDate(future.getUTCDate() + 20);
      const longAgo = new Date(today);
      longAgo.setUTCDate(longAgo.getUTCDate() - 200);
      const ymd = (d: Date) => d.toISOString().slice(0, 10);

      await createBill(
        ctx.app,
        cookie,
        accountId,
        billBody({
          companyId,
          contactId: vendor,
          categoryAccountId: category,
          amount: '100.00',
          dueDate: ymd(future),
        }),
      );
      await createBill(
        ctx.app,
        cookie,
        accountId,
        billBody({
          companyId,
          contactId: vendor,
          categoryAccountId: category,
          amount: '250.00',
          billDate: ymd(longAgo),
          dueDate: ymd(longAgo),
        }),
      );

      const res = await ctx.app.request(`/api/bills/aging?companyId=${companyId}`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      const aging = (await res.json()) as {
        total: string;
        buckets: { current: string; d90_plus: string };
        bills: { bucket: string; amount: string }[];
      };
      expect(aging.total).toBe('350.00');
      expect(aging.buckets.current).toBe('100.00');
      expect(aging.buckets.d90_plus).toBe('250.00');
      expect(aging.bills).toHaveLength(2);
    } finally {
      await ctx.handle.close();
    }
  });

  it("does not leak another account's bills", async () => {
    const ctx = buildApp();
    try {
      const cookieA = await signUp(ctx.app, 'bill-tenant-a@example.com');
      const a = await userContext('bill-tenant-a@example.com');
      const vendorA = await makeVendor(a.accountId, a.companyId);
      const categoryA = await coaId(a.companyId, '7000');
      const created = (await (
        await createBill(ctx.app, cookieA, a.accountId, {
          ...billBody(),
          companyId: a.companyId,
          contactId: vendorA,
          categoryAccountId: categoryA,
        })
      ).json()) as { id: string };

      const cookieB = await signUp(ctx.app, 'bill-tenant-b@example.com');
      const b = await userContext('bill-tenant-b@example.com');

      // B cannot read A's bill.
      const cross = await ctx.app.request(`/api/bills/${created.id}`, {
        headers: { cookie: cookieB, 'x-account-id': b.accountId },
      });
      expect(cross.status).toBe(404);

      // B's list is empty.
      const list = await ctx.app.request(`/api/bills?companyId=${b.companyId}`, {
        headers: { cookie: cookieB, 'x-account-id': b.accountId },
      });
      const body = (await list.json()) as { bills: unknown[] };
      expect(body.bills).toHaveLength(0);

      // Sanity: the row really exists for A.
      const db = getTestDb();
      const [row] = await db.select().from(bills).where(eq(bills.id, created.id));
      expect(row?.accountId).toBe(a.accountId);
    } finally {
      await ctx.handle.close();
    }
  });
});
