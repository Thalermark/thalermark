import {
  authUser,
  chartOfAccounts,
  companies,
  contacts,
  journalEntries,
  journalLines,
  memberships,
} from '@thalermark/db';
import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Partial payments for bills (TMC-192) — the accounts-payable mirror of
// invoice-payments.integration.test.ts. The case the ticket exists for is the
// first test: a supplier wants half up front on a materials order.
//
// EVERY money test asserts the company trial balance still nets to zero. The
// deferred trigger guarantees each individual entry balances; it says nothing
// about whether the RIGHT entries were posted, and that is the class of bug a
// re-grained posting path introduces.

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

type Ctx = Awaited<ReturnType<typeof setup>>;

async function setup(email: string) {
  const { app, handle } = buildApp();
  const cookie = await signUp(app, email);
  const { accountId, companyId } = await userContext(email);
  const headers = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };
  return { app, handle, cookie, accountId, companyId, headers };
}

// The invariant. Sums every journal line in the company, debits positive and
// credits negative — a correct set of books nets to exactly zero, always, no
// matter which paths ran.
async function trialBalanceCents(companyId: string): Promise<number> {
  const db = getTestDb();
  const [row] = await db
    .select({
      net: sql<string>`coalesce(sum(case when ${journalLines.side} = 'debit' then ${journalLines.amount} else -${journalLines.amount} end), 0)::numeric(15,2)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .where(eq(journalEntries.companyId, companyId));
  return Math.round(Number(row?.net ?? '0') * 100);
}

// Signed balance on one chart-of-accounts code (debits − credits). AP (2000)
// and the payment asset are what a bill payment moves between.
async function balanceCents(companyId: string, code: string): Promise<number> {
  const db = getTestDb();
  const [row] = await db
    .select({
      net: sql<string>`coalesce(sum(case when ${journalLines.side} = 'debit' then ${journalLines.amount} else -${journalLines.amount} end), 0)::numeric(15,2)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
    .where(and(eq(journalEntries.companyId, companyId), eq(chartOfAccounts.code, code)));
  return Math.round(Number(row?.net ?? '0') * 100);
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

async function makeVendor(ctx: Ctx, name = 'Ace Hardware'): Promise<string> {
  const db = getTestDb();
  const id = uuidv7();
  await db
    .insert(contacts)
    .values({ id, accountId: ctx.accountId, companyId: ctx.companyId, name, isVendor: true });
  return id;
}

async function makeBill(ctx: Ctx, amount = '320.00'): Promise<string> {
  const res = await ctx.app.request('/api/bills', {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId: await makeVendor(ctx),
      categoryAccountId: await coaId(ctx.companyId, '7000'), // Supplies (expense)
      amount,
      billDate: '2026-06-01',
      dueDate: '2026-07-01',
      reference: 'INV-9912',
    }),
  });
  if (res.status !== 201) throw new Error(`bill create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

type PaymentBody = {
  amount: string;
  paidOn?: string;
  method?: string;
  reference?: string;
  paymentAccountId?: string;
};

function pay(ctx: Ctx, billId: string, body: PaymentBody) {
  return ctx.app.request(`/api/bills/${billId}/payments`, {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({ paidOn: '2026-06-15', method: 'check', ...body }),
  });
}

type SettlementResponse = {
  settlement: string;
  paid: string;
  outstanding: string;
  status: string;
  bill: { status: string; paidAt: string | null; paymentMethod: string | null };
  payment?: { id: string; paymentAccountId: string | null };
};

describe('POST /api/bills/:id/payments', () => {
  beforeEach(resetDb);

  it('records a deposit to the supplier and leaves the bill open for the rest', async () => {
    const ctx = await setup('bill-deposit@test.com');
    const id = await makeBill(ctx, '320.00');

    const res = await pay(ctx, id, { amount: '160.00' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SettlementResponse;

    expect(body.settlement).toBe('partial');
    expect(body.paid).toBe('160.00');
    expect(body.outstanding).toBe('160.00');
    // The bill is NOT paid. This is the assertion the old model could not make:
    // before this change the only options were "paid" or "untouched".
    expect(body.bill.status).toBe('open');
    expect(body.bill.paidAt).toBeNull();

    // Half the liability is relieved, half the cash is out. AP is a credit
    // balance, so its signed (debit − credit) balance is negative.
    expect(await balanceCents(ctx.companyId, '2000')).toBe(-16_000);
    expect(await balanceCents(ctx.companyId, '1000')).toBe(-16_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);
  });

  it('paying the balance settles it and stamps the legacy header columns', async () => {
    const ctx = await setup('bill-settle@test.com');
    const id = await makeBill(ctx, '320.00');

    await pay(ctx, id, { amount: '160.00', paidOn: '2026-06-15' });
    const res = await pay(ctx, id, {
      amount: '160.00',
      paidOn: '2026-06-20',
      method: 'zelle',
      reference: 'CONF-77',
    });
    const body = (await res.json()) as SettlementResponse;

    expect(body.settlement).toBe('paid');
    expect(body.bill.status).toBe('paid');
    // The header mirrors the MOST RECENT payment, so every existing reader —
    // the aging report, both clients — keeps saying something true.
    expect(body.bill.paymentMethod).toBe('zelle');
    expect(body.bill.paidAt?.slice(0, 10)).toBe('2026-06-20');

    expect(await balanceCents(ctx.companyId, '2000')).toBe(0);
    expect(await balanceCents(ctx.companyId, '1000')).toBe(-32_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);
  });

  // Every payment stores the account it left from — that is what
  // payment_account_id is for, and what a second bank account will need. It
  // resolves to Cash today because Cash is the only thing in the seeded chart
  // money can leave from.
  it('stamps the resolved account on the payment row', async () => {
    const ctx = await setup('bill-account-stamp@test.com');
    const id = await makeBill(ctx, '320.00');
    const cash = await coaId(ctx.companyId, '1000');

    const res = await pay(ctx, id, { amount: '160.00' });
    const body = (await res.json()) as SettlementResponse;
    expect(body.payment?.paymentAccountId).toBe(cash);
  });

  // The old check was account_type === 'asset', which the chart also gives to
  // Accounts Receivable, Vehicles & Equipment and Accumulated Depreciation.
  // "Paid this bill out of Accumulated Depreciation" posts a BALANCED entry
  // that is nonsense, and a balanced wrong answer is the failure mode this
  // codebase exists to avoid.
  it('refuses an asset account that money cannot actually leave from', async () => {
    const ctx = await setup('bill-bad-account@test.com');
    const id = await makeBill(ctx, '320.00');
    const accumulatedDepreciation = await coaId(ctx.companyId, '1900');

    const res = await pay(ctx, id, {
      amount: '160.00',
      paymentAccountId: accumulatedDepreciation,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_payment_account');
    expect(await balanceCents(ctx.companyId, '1900')).toBe(0);
  });

  it('a refund from the vendor is a negative payment and reopens the bill', async () => {
    const ctx = await setup('bill-refund@test.com');
    const id = await makeBill(ctx, '320.00');

    await pay(ctx, id, { amount: '320.00' });
    const res = await pay(ctx, id, { amount: '-320.00', paidOn: '2026-06-25' });
    const body = (await res.json()) as SettlementResponse;

    expect(body.settlement).toBe('unpaid');
    expect(body.bill.status).toBe('open');
    // A reopened bill must not keep a paid_at claiming it was settled.
    expect(body.bill.paidAt).toBeNull();

    expect(await balanceCents(ctx.companyId, '1000')).toBe(0);
    expect(await balanceCents(ctx.companyId, '2000')).toBe(-32_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);
  });

  it('overpaying a vendor is recorded, not refused', async () => {
    const ctx = await setup('bill-overpay@test.com');
    const id = await makeBill(ctx, '320.00');

    const res = await pay(ctx, id, { amount: '350.00' });
    const body = (await res.json()) as SettlementResponse;
    expect(body.settlement).toBe('overpaid');
    expect(body.outstanding).toBe('-30.00');
    expect(body.bill.status).toBe('paid');
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);
  });

  it('refuses a payment against a voided bill', async () => {
    const ctx = await setup('bill-voided-pay@test.com');
    const id = await makeBill(ctx);
    await ctx.app.request(`/api/bills/${id}/void`, { method: 'POST', headers: ctx.headers });

    const res = await pay(ctx, id, { amount: '10.00' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('voided');
  });

  // The guard that makes this safe against live data. A bill settled by the old
  // single-shot path has header stamps and no rows, and its cash has already
  // left; accepting a payment would pay the vendor twice.
  it('refuses a payment against a bill settled through the legacy path', async () => {
    const ctx = await setup('bill-legacy@test.com');
    const id = await makeBill(ctx);
    const marked = await ctx.app.request(`/api/bills/${id}/mark-paid`, {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({ method: 'cash' }),
    });
    expect(marked.status).toBe(200);

    const res = await pay(ctx, id, { amount: '10.00' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('settled_without_payments');
    // And it is untouched — exactly the bill it was before this feature existed.
    expect(await balanceCents(ctx.companyId, '2000')).toBe(0);
    expect(await balanceCents(ctx.companyId, '1000')).toBe(-32_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);
  });
});

describe('DELETE /api/bills/:id/payments/:paymentId', () => {
  beforeEach(resetDb);

  it('reverses the payment at its ORIGINAL date and reopens the bill', async () => {
    const ctx = await setup('bill-remove@test.com');
    const id = await makeBill(ctx, '320.00');
    const created = (await (
      await pay(ctx, id, { amount: '320.00', paidOn: '2026-06-15' })
    ).json()) as SettlementResponse;
    const paymentId = created.payment?.id;
    if (!paymentId) throw new Error('no payment id');

    const res = await ctx.app.request(`/api/bills/${id}/payments/${paymentId}`, {
      method: 'DELETE',
      headers: ctx.headers,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SettlementResponse;
    expect(body.settlement).toBe('unpaid');
    expect(body.bill.status).toBe('open');

    // The reversal lands in the period the payment did — removing a mistake
    // must not move cash off one month and onto another.
    const db = getTestDb();
    const entries = await db
      .select({ postedAt: journalEntries.postedAt, memo: journalEntries.memo })
      .from(journalEntries)
      .where(eq(journalEntries.sourceEntityId, id));
    const reversal = entries.find((e) => e.memo?.includes('payment reversal'));
    expect(reversal?.postedAt.toISOString().slice(0, 10)).toBe('2026-06-15');

    expect(await balanceCents(ctx.companyId, '1000')).toBe(0);
    expect(await balanceCents(ctx.companyId, '2000')).toBe(-32_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);
  });

  // Removing one of several payments leaves the others exactly where they were.
  // The reversal is built from the removed row's OWN stored account rather than
  // the bill header's, which is what keeps this true once a second bank account
  // can exist.
  it('removes one payment and leaves the rest untouched', async () => {
    const ctx = await setup('bill-remove-one@test.com');
    const id = await makeBill(ctx, '320.00');

    const first = (await (await pay(ctx, id, { amount: '160.00' })).json()) as SettlementResponse;
    await pay(ctx, id, { amount: '160.00', paidOn: '2026-06-20' });

    const paymentId = first.payment?.id;
    if (!paymentId) throw new Error('no payment id');
    await ctx.app.request(`/api/bills/${id}/payments/${paymentId}`, {
      method: 'DELETE',
      headers: ctx.headers,
    });

    const remaining = await ctx.app.request(`/api/bills/${id}/payments`, { headers: ctx.headers });
    const body = (await remaining.json()) as { payments: unknown[]; paid: string };
    expect(body.payments).toHaveLength(1);
    expect(body.paid).toBe('160.00');

    expect(await balanceCents(ctx.companyId, '1000')).toBe(-16_000);
    expect(await balanceCents(ctx.companyId, '2000')).toBe(-16_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);
  });
});

// A part-paid bill is still 'open', which used to be proof that no money had
// moved. These are the two paths that assumption was load-bearing for.
describe('bill transitions once payments exist', () => {
  beforeEach(resetDb);

  it('void refuses a part-paid bill rather than clearing AP twice', async () => {
    const ctx = await setup('bill-void-guard@test.com');
    const id = await makeBill(ctx, '320.00');
    await pay(ctx, id, { amount: '160.00' });

    const res = await ctx.app.request(`/api/bills/${id}/void`, {
      method: 'POST',
      headers: ctx.headers,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('has_payments');

    expect(await balanceCents(ctx.companyId, '2000')).toBe(-16_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);
  });

  // ...but "we paid, they refunded us in full, now cancel it" still voids: the
  // two rows net to zero and AP is back at the full amount, which is exactly
  // what the void reverses.
  it('void still works when the payments net to zero', async () => {
    const ctx = await setup('bill-void-net-zero@test.com');
    const id = await makeBill(ctx, '320.00');
    await pay(ctx, id, { amount: '320.00' });
    await pay(ctx, id, { amount: '-320.00' });

    const res = await ctx.app.request(`/api/bills/${id}/void`, {
      method: 'POST',
      headers: ctx.headers,
    });
    expect(res.status).toBe(200);
    expect(await balanceCents(ctx.companyId, '2000')).toBe(0);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);
  });

  it('mark-paid refuses a bill that already has payments — it would pay twice', async () => {
    const ctx = await setup('bill-markpaid-guard@test.com');
    const id = await makeBill(ctx, '320.00');
    await pay(ctx, id, { amount: '160.00' });

    const res = await ctx.app.request(`/api/bills/${id}/mark-paid`, {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({ method: 'cash' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('has_payments');
    expect(await balanceCents(ctx.companyId, '1000')).toBe(-16_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);
  });

  // A corrected bill that comes in at the deposit amount is settled, and the
  // status column has to say so rather than contradicting the rows.
  it('editing the amount down to what was paid settles the bill', async () => {
    const ctx = await setup('bill-edit-settles@test.com');
    const id = await makeBill(ctx, '320.00');
    await pay(ctx, id, { amount: '160.00' });

    const res = await ctx.app.request(`/api/bills/${id}`, {
      method: 'PATCH',
      headers: ctx.headers,
      body: JSON.stringify({ amount: '160.00' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('paid');

    expect(await balanceCents(ctx.companyId, '2000')).toBe(0);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);
  });
});

describe('GET /api/bills/aging with partial payments', () => {
  beforeEach(resetDb);

  // Aging that reported the full amount would overstate payables by every
  // deposit already made — the number this report exists to get right.
  it('ages what is still owed, not what was billed', async () => {
    const ctx = await setup('bill-aging@test.com');
    const id = await makeBill(ctx, '320.00');
    await pay(ctx, id, { amount: '120.00' });

    const res = await ctx.app.request(`/api/bills/aging?companyId=${ctx.companyId}`, {
      headers: ctx.headers,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: string;
      bills: { id: string; amount: string }[];
    };
    expect(body.total).toBe('200.00');
    expect(body.bills.find((b) => b.id === id)?.amount).toBe('200.00');
    // And it agrees with the ledger, which is the only cross-check that leaves
    // the code path being tested.
    expect(await balanceCents(ctx.companyId, '2000')).toBe(-20_000);
  });
});
