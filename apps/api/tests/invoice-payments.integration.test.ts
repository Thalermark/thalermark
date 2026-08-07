import {
  authUser,
  chartOfAccounts,
  companies,
  journalEntries,
  journalLines,
  memberships,
} from '@thalermark/db';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Partial payments and deposits (TMC-187). The case the whole ticket exists for
// is the first test here: a landscaper takes 50% down on a $1,200 job.
//
// EVERY money test asserts the company trial balance still nets to zero. The
// deferred trigger guarantees each individual entry balances; it says nothing
// about whether the right entries were posted, and that is the class of bug a
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

// Signed balance on one chart-of-accounts code (debits − credits). Cash (1000)
// and AR (1200) are what a payment moves between.
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

async function makeContact(ctx: Ctx, name: string): Promise<string> {
  const res = await ctx.app.request('/api/contacts', {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({ companyId: ctx.companyId, name }),
  });
  if (res.status !== 201) throw new Error(`contact create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function makeInvoice(ctx: Ctx, number: string, total: string, send = true): Promise<string> {
  const contactId = await makeContact(ctx, `Customer ${number}`);
  const res = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId,
      number,
      issueDate: '2026-06-10',
      dueDate: '2026-07-10',
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
  if (res.status !== 201) throw new Error(`invoice create failed: ${res.status}`);
  const id = ((await res.json()) as { id: string }).id;
  if (send) {
    const sent = await ctx.app.request(`/api/invoices/${id}/mark-sent`, {
      method: 'POST',
      headers: ctx.headers,
    });
    if (sent.status !== 200) throw new Error(`mark-sent failed: ${sent.status}`);
  }
  return id;
}

type PaymentBody = { amount: string; receivedOn?: string; method?: string; reference?: string };

function pay(ctx: Ctx, invoiceId: string, body: PaymentBody) {
  return ctx.app.request(`/api/invoices/${invoiceId}/payments`, {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({
      receivedOn: '2026-06-15',
      method: 'check',
      ...body,
    }),
  });
}

type SettlementResponse = {
  settlement: string;
  paid: string;
  outstanding: string;
  invoice: { status: string; paidAt: string | null; paymentMethod: string | null };
  payment?: { id: string };
};

describe('POST /api/invoices/:id/payments', () => {
  beforeEach(resetDb);

  it('records a 50% deposit and leaves the invoice open for the rest', async () => {
    const ctx = await setup('deposit@test.com');
    const id = await makeInvoice(ctx, 'INV-001', '1200.00');

    const res = await pay(ctx, id, { amount: '600.00' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SettlementResponse;

    expect(body.settlement).toBe('partial');
    expect(body.paid).toBe('600.00');
    expect(body.outstanding).toBe('600.00');
    // The invoice is NOT paid. This is the assertion the old model could not
    // make: before this change the only options were "paid" or "untouched".
    expect(body.invoice.status).toBe('sent');
    expect(body.invoice.paidAt).toBeNull();

    // Half the receivable is relieved, half the cash is in.
    expect(await balanceCents(ctx.companyId, '1000')).toBe(60_000);
    expect(await balanceCents(ctx.companyId, '1200')).toBe(60_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });

  it('partial → partial → full settles the invoice exactly', async () => {
    const ctx = await setup('progress@test.com');
    const id = await makeInvoice(ctx, 'INV-002', '1200.00');

    await pay(ctx, id, { amount: '500.00', receivedOn: '2026-06-15' });
    const second = (await (
      await pay(ctx, id, { amount: '400.00', receivedOn: '2026-06-20' })
    ).json()) as SettlementResponse;
    expect(second.settlement).toBe('partial');
    expect(second.outstanding).toBe('300.00');

    const final = (await (
      await pay(ctx, id, { amount: '300.00', receivedOn: '2026-06-25', method: 'cash' })
    ).json()) as SettlementResponse;
    expect(final.settlement).toBe('paid');
    expect(final.outstanding).toBe('0.00');
    expect(final.invoice.status).toBe('paid');
    // The header mirrors the LAST receipt, which is what the public view and
    // the customer statement read.
    expect(final.invoice.paymentMethod).toBe('cash');
    expect(final.invoice.paidAt).not.toBeNull();

    // Receivable fully cleared, all the cash banked, books balanced.
    expect(await balanceCents(ctx.companyId, '1200')).toBe(0);
    expect(await balanceCents(ctx.companyId, '1000')).toBe(120_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });

  it('records an overpayment rather than refusing it', async () => {
    const ctx = await setup('overpay@test.com');
    const id = await makeInvoice(ctx, 'INV-003', '1200.00');

    const body = (await (await pay(ctx, id, { amount: '1300.00' })).json()) as SettlementResponse;
    expect(body.settlement).toBe('overpaid');
    expect(body.outstanding).toBe('-100.00');
    expect(body.invoice.status).toBe('paid');

    // AR goes contra by the excess — the business owes the customer $100, and
    // the books say so rather than hiding it.
    expect(await balanceCents(ctx.companyId, '1200')).toBe(-10_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });

  it('a refund is a negative payment that reopens the invoice', async () => {
    const ctx = await setup('refund@test.com');
    const id = await makeInvoice(ctx, 'INV-004', '1200.00');

    await pay(ctx, id, { amount: '1200.00' });
    const refunded = (await (
      await pay(ctx, id, { amount: '-1200.00', receivedOn: '2026-06-28' })
    ).json()) as SettlementResponse;

    expect(refunded.settlement).toBe('unpaid');
    expect(refunded.paid).toBe('0.00');
    expect(refunded.invoice.status).toBe('sent');
    // The paid stamp must be cleared — an invoice that was refunded is owed
    // again, and leaving paid_at behind would have it read as settled.
    expect(refunded.invoice.paidAt).toBeNull();

    // Cash back out, receivable restored in full.
    expect(await balanceCents(ctx.companyId, '1000')).toBe(0);
    expect(await balanceCents(ctx.companyId, '1200')).toBe(120_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });

  it('a partial credit note reduces what is owed', async () => {
    const ctx = await setup('credit@test.com');
    const id = await makeInvoice(ctx, 'INV-005', '1200.00');

    await pay(ctx, id, { amount: '1000.00' });
    const credited = (await (
      await pay(ctx, id, { amount: '-150.00', method: 'other', reference: 'goodwill credit' })
    ).json()) as SettlementResponse;

    expect(credited.settlement).toBe('partial');
    expect(credited.paid).toBe('850.00');
    expect(credited.outstanding).toBe('350.00');
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });

  it('refuses a payment against a draft — there is no receivable yet', async () => {
    const ctx = await setup('draft-pay@test.com');
    const id = await makeInvoice(ctx, 'INV-006', '500.00', false);

    const res = await pay(ctx, id, { amount: '100.00' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('not_issued');
    // Nothing posted at all — a draft is off the books entirely.
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);
    expect(await balanceCents(ctx.companyId, '1000')).toBe(0);

    await ctx.handle.close();
  });

  it('refuses a payment against an invoice settled by the legacy path', async () => {
    // The guard that makes this safe against live data: mark-paid posted the
    // cash already, so a payment row would bank the same money twice.
    const ctx = await setup('legacy-paid@test.com');
    const id = await makeInvoice(ctx, 'INV-007', '400.00');
    const marked = await ctx.app.request(`/api/invoices/${id}/mark-paid`, {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({ method: 'cash', paidOn: '2026-06-14' }),
    });
    expect(marked.status).toBe(200);
    const cashAfterMarkPaid = await balanceCents(ctx.companyId, '1000');

    const res = await pay(ctx, id, { amount: '100.00' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('settled_without_payments');
    // Cash is untouched by the refusal.
    expect(await balanceCents(ctx.companyId, '1000')).toBe(cashAfterMarkPaid);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });

  it('rejects a zero-amount receipt', async () => {
    const ctx = await setup('zero-pay@test.com');
    const id = await makeInvoice(ctx, 'INV-008', '400.00');
    const res = await pay(ctx, id, { amount: '0.00' });
    expect(res.status).toBe(400);
    await ctx.handle.close();
  });
});

describe('DELETE /api/invoices/:id/payments/:paymentId', () => {
  beforeEach(resetDb);

  it('reverses the posting and reopens the invoice', async () => {
    const ctx = await setup('unpay@test.com');
    const id = await makeInvoice(ctx, 'INV-100', '900.00');

    const created = (await (await pay(ctx, id, { amount: '900.00' })).json()) as SettlementResponse;
    expect(created.invoice.status).toBe('paid');
    const paymentId = created.payment?.id as string;

    const res = await ctx.app.request(`/api/invoices/${id}/payments/${paymentId}`, {
      method: 'DELETE',
      headers: ctx.headers,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SettlementResponse;
    expect(body.settlement).toBe('unpaid');
    expect(body.invoice.status).toBe('sent');
    expect(body.invoice.paidAt).toBeNull();

    // The reversal cancels the receipt to the cent: cash back to nothing, the
    // full receivable restored, books balanced.
    expect(await balanceCents(ctx.companyId, '1000')).toBe(0);
    expect(await balanceCents(ctx.companyId, '1200')).toBe(90_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });

  it('removing one of several payments leaves the rest intact', async () => {
    const ctx = await setup('unpay-partial@test.com');
    const id = await makeInvoice(ctx, 'INV-101', '1000.00');

    const first = (await (await pay(ctx, id, { amount: '400.00' })).json()) as SettlementResponse;
    await pay(ctx, id, { amount: '600.00', receivedOn: '2026-06-20' });

    await ctx.app.request(`/api/invoices/${id}/payments/${first.payment?.id}`, {
      method: 'DELETE',
      headers: ctx.headers,
    });

    const list = await ctx.app.request(`/api/invoices/${id}/payments`, { headers: ctx.headers });
    const body = (await list.json()) as SettlementResponse & { payments: unknown[] };
    expect(body.payments).toHaveLength(1);
    expect(body.paid).toBe('600.00');
    expect(body.settlement).toBe('partial');
    expect(await balanceCents(ctx.companyId, '1000')).toBe(60_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });

  it('404s a payment belonging to another invoice', async () => {
    const ctx = await setup('cross-invoice@test.com');
    const a = await makeInvoice(ctx, 'INV-102', '100.00');
    const b = await makeInvoice(ctx, 'INV-103', '100.00');
    const onA = (await (await pay(ctx, a, { amount: '50.00' })).json()) as SettlementResponse;

    const res = await ctx.app.request(`/api/invoices/${b}/payments/${onA.payment?.id}`, {
      method: 'DELETE',
      headers: ctx.headers,
    });
    expect(res.status).toBe(404);

    await ctx.handle.close();
  });
});

describe('invoice settlement does not disturb what already shipped', () => {
  beforeEach(resetDb);

  it('an invoice with no payment rows behaves exactly as before', async () => {
    // The additive claim, asserted rather than assumed: the legacy full-payment
    // path posts the same ledger it always did and needs no payment rows.
    const ctx = await setup('unchanged@test.com');
    const id = await makeInvoice(ctx, 'INV-200', '750.00');

    const marked = await ctx.app.request(`/api/invoices/${id}/mark-paid`, {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({ method: 'venmo', reference: 'abc123', paidOn: '2026-06-18' }),
    });
    expect(marked.status).toBe(200);
    const invoice = (await marked.json()) as {
      status: string;
      paymentMethod: string;
      paymentReference: string;
    };
    expect(invoice.status).toBe('paid');
    expect(invoice.paymentMethod).toBe('venmo');
    expect(invoice.paymentReference).toBe('abc123');

    const list = await ctx.app.request(`/api/invoices/${id}/payments`, { headers: ctx.headers });
    const body = (await list.json()) as SettlementResponse & { payments: unknown[] };
    // No rows — and the summary honestly reports what the rows say, which is
    // why the eligibility guard exists rather than trusting this number.
    expect(body.payments).toHaveLength(0);

    expect(await balanceCents(ctx.companyId, '1000')).toBe(75_000);
    expect(await balanceCents(ctx.companyId, '1200')).toBe(0);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });
});
