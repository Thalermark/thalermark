import {
  authUser,
  billPayments,
  chartOfAccounts,
  companies,
  contacts,
  invoicePayments,
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

// Payment idempotency (TMC-218).
//
// A double-click on "Record payment" posted two identical receipts, and the
// invoice then reported itself overpaid with the cash on the books twice — a
// silent books error. Disabling the button is not a fix: two tabs, a
// back-button resubmit and a network retry all reach the same handler without a
// second click.
//
// WHAT THESE TESTS ARE ACTUALLY GUARDING. The duplicate row was never the real
// damage; the second LEDGER POSTING behind it was. A fix that deduplicated the
// row while still calling postInvoicePayment would leave the books more wrong
// than the bug it replaced, because the receipt list would look correct while
// AR and Cash quietly disagreed with it. So every dedupe test here asserts the
// account balances and the posting count, not just `select count(*)`.
//
// AND THE CONTROL THAT MATTERS. Two genuine $50 cash instalments on one day are
// a real thing a landscaper does. A fix that deduplicated on amount + date
// would pass every "same key twice" test in this file and silently swallow the
// second instalment. `different keys, same amount and date` is the test that
// catches it.

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

// The invariant. Debits positive, credits negative, across the whole company —
// a correct set of books nets to exactly zero.
//
// On its own this proves very little: the deferred trigger already guarantees
// each individual entry balances, so a double-posted payment nets to zero just
// as happily as a single one. It is here to catch a malformed entry, and the
// balanceCents assertions beside it are what actually catch a double-post.
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

// Signed balance on one chart-of-accounts code (debits − credits). Cash (1000),
// AR (1200) and AP (2000) are what these payments move between.
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

// How many journal ENTRIES carry this exact memo. postInvoicePayment writes
// "Invoice <number> payment" and postBillPaymentReceipt writes
// "Bill <vendor> #<ref> payment", one entry per receipt — so this counts
// postings directly rather than inferring them from a balance that a pair of
// offsetting mistakes could fake.
async function postingCount(companyId: string, memo: string): Promise<number> {
  const db = getTestDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, companyId), eq(journalEntries.memo, memo)));
  return Number(row?.count ?? 0);
}

async function entryCount(companyId: string): Promise<number> {
  const db = getTestDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(journalEntries)
    .where(eq(journalEntries.companyId, companyId));
  return Number(row?.count ?? 0);
}

async function invoicePaymentRows(invoiceId: string) {
  return getTestDb().select().from(invoicePayments).where(eq(invoicePayments.invoiceId, invoiceId));
}

async function billPaymentRows(billId: string) {
  return getTestDb().select().from(billPayments).where(eq(billPayments.billId, billId));
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

type InvoicePayBody = {
  amount: string;
  receivedOn?: string;
  method?: string;
  idempotencyKey?: string;
};

function payInvoice(ctx: Ctx, invoiceId: string, body: InvoicePayBody) {
  return ctx.app.request(`/api/invoices/${invoiceId}/payments`, {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({ receivedOn: '2026-06-15', method: 'check', ...body }),
  });
}

type BillPayBody = { amount: string; paidOn?: string; method?: string; idempotencyKey?: string };

function payBill(ctx: Ctx, billId: string, body: BillPayBody) {
  return ctx.app.request(`/api/bills/${billId}/payments`, {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({ paidOn: '2026-06-15', method: 'check', ...body }),
  });
}

function takeDeposit(
  ctx: Ctx,
  invoiceId: string,
  body: { amount: string; receivedOn?: string; idempotencyKey?: string },
) {
  return ctx.app.request(`/api/invoices/${invoiceId}/deposit`, {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({ receivedOn: '2026-06-15', ...body }),
  });
}

type InvoicePayResponse = {
  payment: { id: string; amount: string; idempotencyKey: string | null };
  invoice: { id: string; status: string; sentAt: string | null };
  settlement: string;
  paid: string;
  outstanding: string;
  replayed: boolean;
};

type BillPayResponse = {
  payment: { id: string; amount: string; idempotencyKey: string | null };
  bill: { id: string; status: string };
  settlement: string;
  paid: string;
  outstanding: string;
  replayed: boolean;
};

// A key the client would actually mint. Long enough to clear the schema's
// min(8) and opaque to the server, which only ever compares it.
const KEY_A = 'form-render-0f2c9a41-aaaa';
const KEY_B = 'form-render-0f2c9a41-bbbb';

describe('POST /api/invoices/:id/payments — idempotency', () => {
  beforeEach(resetDb);

  it('replays the same key instead of booking the money twice', async () => {
    const ctx = await setup('idem-invoice@test.com');
    const id = await makeInvoice(ctx, 'INV-001', '1200.00');

    const first = await payInvoice(ctx, id, { amount: '600.00', idempotencyKey: KEY_A });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as InvoicePayResponse;
    expect(firstBody.replayed).toBe(false);

    // The double-click. Byte-identical body, same key.
    const second = await payInvoice(ctx, id, { amount: '600.00', idempotencyKey: KEY_A });

    // Both look successful to the caller — that is the whole contract. A retry
    // that 500s or 409s just moves the confusion somewhere else.
    expect(second.ok).toBe(true);
    // 200 rather than 201: nothing was created by the second request, and 201
    // would be a claim that something was.
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as InvoicePayResponse;
    expect(secondBody.replayed).toBe(true);

    // The SAME receipt comes back, not a new one wearing the same numbers.
    expect(secondBody.payment.id).toBe(firstBody.payment.id);
    // And the settlement the caller renders is identical, so a client that
    // simply draws the response cannot tell the two apart.
    expect(secondBody.settlement).toBe(firstBody.settlement);
    expect(secondBody.paid).toBe('600.00');
    expect(secondBody.outstanding).toBe('600.00');
    expect(secondBody.invoice.status).toBe('sent');

    // One row.
    const rows = await invoicePaymentRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey).toBe(KEY_A);

    // ONE LEDGER POSTING. This is the assertion the bug was really about: a
    // dedupe that still posted would leave the row count right and the books
    // wrong.
    expect(await postingCount(ctx.companyId, 'Invoice INV-001 payment')).toBe(1);
    // Issue posting + one payment posting. Nothing else.
    expect(await entryCount(ctx.companyId)).toBe(2);

    // AR moved exactly once: 1200 receivable less a 600 receipt. A double-post
    // would read 0 here and 120000 in Cash.
    expect(await balanceCents(ctx.companyId, '1200')).toBe(60_000);
    expect(await balanceCents(ctx.companyId, '1000')).toBe(60_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });

  // THE CONTROL. Two genuine $50 cash instalments on one day, which is a real
  // thing and must both be recorded. Any fix that deduplicated on amount + date
  // would pass the test above and fail this one.
  it('records both when the amount and date match but the keys differ', async () => {
    const ctx = await setup('idem-invoice-control@test.com');
    const id = await makeInvoice(ctx, 'INV-002', '1200.00');

    const first = await payInvoice(ctx, id, {
      amount: '50.00',
      receivedOn: '2026-06-15',
      idempotencyKey: KEY_A,
    });
    const second = await payInvoice(ctx, id, {
      amount: '50.00',
      receivedOn: '2026-06-15',
      idempotencyKey: KEY_B,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(((await second.json()) as InvoicePayResponse).replayed).toBe(false);

    const rows = await invoicePaymentRows(id);
    expect(rows).toHaveLength(2);

    // Both postings are real and both moved the books.
    expect(await postingCount(ctx.companyId, 'Invoice INV-002 payment')).toBe(2);
    expect(await balanceCents(ctx.companyId, '1000')).toBe(10_000);
    expect(await balanceCents(ctx.companyId, '1200')).toBe(110_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });

  it('leaves the unkeyed path exactly as it was — two calls, two receipts', async () => {
    const ctx = await setup('idem-invoice-nokey@test.com');
    const id = await makeInvoice(ctx, 'INV-003', '1200.00');

    const first = await payInvoice(ctx, id, { amount: '600.00' });
    const second = await payInvoice(ctx, id, { amount: '600.00' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    // Unchanged behaviour: no key, no protection, nothing existing breaks. This
    // is what keeps mobile working until it ships its half.
    const rows = await invoicePaymentRows(id);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.idempotencyKey).toBeNull();
    expect(await postingCount(ctx.companyId, 'Invoice INV-003 payment')).toBe(2);
    expect(await balanceCents(ctx.companyId, '1000')).toBe(120_000);
    expect(await balanceCents(ctx.companyId, '1200')).toBe(0);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });

  // The index is on (account_id, idempotency_key), so one tenant's keys can
  // never suppress another's payments. Two clients minting from the same
  // generator must not collide across the tenancy boundary.
  it('scopes keys to the account', async () => {
    const a = await setup('idem-tenant-a@test.com');
    const b = await setup('idem-tenant-b@test.com');
    const invoiceA = await makeInvoice(a, 'INV-A', '1200.00');
    const invoiceB = await makeInvoice(b, 'INV-B', '1200.00');

    const first = await payInvoice(a, invoiceA, { amount: '600.00', idempotencyKey: KEY_A });
    const second = await payInvoice(b, invoiceB, { amount: '600.00', idempotencyKey: KEY_A });

    expect(first.status).toBe(201);
    // Same key string, different account: an ordinary insert, not a replay.
    expect(second.status).toBe(201);
    expect(((await second.json()) as InvoicePayResponse).replayed).toBe(false);

    expect(await invoicePaymentRows(invoiceA)).toHaveLength(1);
    expect(await invoicePaymentRows(invoiceB)).toHaveLength(1);
    expect(await balanceCents(a.companyId, '1000')).toBe(60_000);
    expect(await balanceCents(b.companyId, '1000')).toBe(60_000);

    await a.handle.close();
    await b.handle.close();
  });

  // Within ONE account the key is account-wide, so aiming it at a second
  // invoice is a client bug. Returning the other invoice's receipt would tell
  // the caller their payment was recorded when nothing was written — an error
  // dressed as success. It has to be an error.
  it('refuses a key already spent on a different invoice', async () => {
    const ctx = await setup('idem-invoice-reuse@test.com');
    const first = await makeInvoice(ctx, 'INV-004', '1200.00');
    const other = await makeInvoice(ctx, 'INV-005', '1200.00');

    expect((await payInvoice(ctx, first, { amount: '600.00', idempotencyKey: KEY_A })).status).toBe(
      201,
    );
    const res = await payInvoice(ctx, other, { amount: '600.00', idempotencyKey: KEY_A });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('idempotency_key_reused');

    // Nothing written against the second invoice, and no stray posting.
    expect(await invoicePaymentRows(other)).toHaveLength(0);
    expect(await postingCount(ctx.companyId, 'Invoice INV-005 payment')).toBe(0);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });
});

// The deposit route welds a STATE TRANSITION to the insert: it issues the
// invoice and banks the money in one transaction. "Dedupe the row but re-run
// the transition" is a distinct failure mode from anything on the payments
// route, so the issue side is asserted as hard as the money side.
describe('POST /api/invoices/:id/deposit — idempotency', () => {
  beforeEach(resetDb);

  it('replays without issuing the invoice or posting the deposit twice', async () => {
    const ctx = await setup('idem-deposit@test.com');
    const id = await makeInvoice(ctx, 'INV-D01', '1200.00', false);

    const first = await takeDeposit(ctx, id, { amount: '600.00', idempotencyKey: KEY_A });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as InvoicePayResponse;
    expect(firstBody.replayed).toBe(false);
    expect(firstBody.invoice.status).toBe('sent');
    const sentAt = firstBody.invoice.sentAt;
    expect(sentAt).not.toBeNull();

    const second = await takeDeposit(ctx, id, { amount: '600.00', idempotencyKey: KEY_A });

    // Without the key this is a 409 invalid_transition — mark-sent only accepts
    // a draft — which tells the user their deposit failed when it did not, and
    // invites them to re-record it through the payments route, where it really
    // would double-book.
    expect(second.ok).toBe(true);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as InvoicePayResponse;
    expect(secondBody.replayed).toBe(true);
    expect(secondBody.payment.id).toBe(firstBody.payment.id);
    expect(secondBody.paid).toBe('600.00');
    expect(secondBody.outstanding).toBe('600.00');

    // THE ISSUE HAPPENED EXACTLY ONCE. sent_at is not re-stamped, so the
    // invoice's issue date — which is what the AR posting is dated on — did not
    // move under the replay.
    expect(secondBody.invoice.sentAt).toBe(sentAt);

    // One receipt.
    expect(await invoicePaymentRows(id)).toHaveLength(1);

    // One deposit posting AND one issue posting. Two entries total: if the
    // transition had re-run there would be a second AR debit here, and AR would
    // read 180000 instead of 60000.
    expect(await postingCount(ctx.companyId, 'Invoice INV-D01 payment')).toBe(1);
    expect(await entryCount(ctx.companyId)).toBe(2);
    expect(await balanceCents(ctx.companyId, '1200')).toBe(60_000);
    expect(await balanceCents(ctx.companyId, '1000')).toBe(60_000);
    // Revenue recognised once, on the issue. A re-run transition would double it.
    expect(await balanceCents(ctx.companyId, '4000')).toBe(-120_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });

  // The reuse case is why the deposit route checks the key BEFORE issuing
  // rather than leaning on the insert like the payments route does. Once
  // applyInvoiceTransition has written, every `return c.json(...)` COMMITS — the
  // tenant tx rolls back only on a throw — so a duplicate noticed after the
  // issue could leave an invoice issued with no deposit behind it, the exact
  // half-done state this endpoint's atomicity exists to prevent.
  it('refuses a key already spent, before issuing the second invoice', async () => {
    const ctx = await setup('idem-deposit-reuse@test.com');
    const first = await makeInvoice(ctx, 'INV-D03', '1200.00', false);
    const other = await makeInvoice(ctx, 'INV-D04', '1200.00', false);

    expect(
      (await takeDeposit(ctx, first, { amount: '600.00', idempotencyKey: KEY_A })).status,
    ).toBe(201);

    const res = await takeDeposit(ctx, other, { amount: '600.00', idempotencyKey: KEY_A });
    // A clean 409, not the 500 a raised unique violation would produce after the
    // issue had already been written.
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('idempotency_key_reused');

    // AND THE SECOND INVOICE WAS NEVER ISSUED. This is the assertion the
    // ordering exists for: refused before the transition, so no stray
    // receivable, no revenue recognised, no document the customer never saw
    // sitting in 'sent'.
    const read = await ctx.app.request(`/api/invoices/${other}`, { headers: ctx.headers });
    const body = (await read.json()) as { status: string; sentAt: string | null };
    expect(body.status).toBe('draft');
    expect(body.sentAt).toBeNull();

    expect(await invoicePaymentRows(other)).toHaveLength(0);
    // Only the first invoice's issue + deposit entries exist.
    expect(await entryCount(ctx.companyId)).toBe(2);
    expect(await balanceCents(ctx.companyId, '1200')).toBe(60_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });

  it('still takes a second deposit under a different key', async () => {
    const ctx = await setup('idem-deposit-control@test.com');
    const id = await makeInvoice(ctx, 'INV-D02', '1200.00', false);

    expect((await takeDeposit(ctx, id, { amount: '50.00', idempotencyKey: KEY_A })).status).toBe(
      201,
    );
    // The invoice is issued now, so the second instalment goes through the
    // payments route — the same route the client uses once a deposit exists.
    const second = await payInvoice(ctx, id, {
      amount: '50.00',
      receivedOn: '2026-06-15',
      idempotencyKey: KEY_B,
    });
    expect(second.status).toBe(201);

    expect(await invoicePaymentRows(id)).toHaveLength(2);
    expect(await balanceCents(ctx.companyId, '1000')).toBe(10_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });
});

describe('POST /api/bills/:id/payments — idempotency', () => {
  beforeEach(resetDb);

  const BILL_MEMO = 'Bill Ace Hardware #INV-9912 payment';

  it('replays the same key instead of paying the vendor twice', async () => {
    const ctx = await setup('idem-bill@test.com');
    const id = await makeBill(ctx, '320.00');

    const first = await payBill(ctx, id, { amount: '160.00', idempotencyKey: KEY_A });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as BillPayResponse;
    expect(firstBody.replayed).toBe(false);

    const second = await payBill(ctx, id, { amount: '160.00', idempotencyKey: KEY_A });
    expect(second.ok).toBe(true);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as BillPayResponse;
    expect(secondBody.replayed).toBe(true);
    expect(secondBody.payment.id).toBe(firstBody.payment.id);
    expect(secondBody.paid).toBe('160.00');
    expect(secondBody.outstanding).toBe('160.00');
    expect(secondBody.bill.status).toBe('open');

    const rows = await billPaymentRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey).toBe(KEY_A);

    // One posting. AP is a credit balance, so its signed balance is negative:
    // 320 owed less a 160 payment. A double-post would clear AP to 0 and show
    // 320 out of Cash for a bill that was only half paid.
    expect(await postingCount(ctx.companyId, BILL_MEMO)).toBe(1);
    expect(await balanceCents(ctx.companyId, '2000')).toBe(-16_000);
    expect(await balanceCents(ctx.companyId, '1000')).toBe(-16_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });

  // The AP control: two genuine same-day payments to one vendor.
  it('records both when the amount and date match but the keys differ', async () => {
    const ctx = await setup('idem-bill-control@test.com');
    const id = await makeBill(ctx, '320.00');

    const first = await payBill(ctx, id, {
      amount: '50.00',
      paidOn: '2026-06-15',
      idempotencyKey: KEY_A,
    });
    const second = await payBill(ctx, id, {
      amount: '50.00',
      paidOn: '2026-06-15',
      idempotencyKey: KEY_B,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    expect(await billPaymentRows(id)).toHaveLength(2);
    expect(await postingCount(ctx.companyId, BILL_MEMO)).toBe(2);
    expect(await balanceCents(ctx.companyId, '2000')).toBe(-22_000);
    expect(await balanceCents(ctx.companyId, '1000')).toBe(-10_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });

  it('leaves the unkeyed path exactly as it was — two calls, two payments', async () => {
    const ctx = await setup('idem-bill-nokey@test.com');
    const id = await makeBill(ctx, '320.00');

    expect((await payBill(ctx, id, { amount: '160.00' })).status).toBe(201);
    expect((await payBill(ctx, id, { amount: '160.00' })).status).toBe(201);

    const rows = await billPaymentRows(id);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.idempotencyKey).toBeNull();
    expect(await postingCount(ctx.companyId, BILL_MEMO)).toBe(2);
    expect(await balanceCents(ctx.companyId, '2000')).toBe(0);
    expect(await balanceCents(ctx.companyId, '1000')).toBe(-32_000);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });

  it('scopes keys to the account', async () => {
    const a = await setup('idem-bill-tenant-a@test.com');
    const b = await setup('idem-bill-tenant-b@test.com');
    const billA = await makeBill(a, '320.00');
    const billB = await makeBill(b, '320.00');

    expect((await payBill(a, billA, { amount: '160.00', idempotencyKey: KEY_A })).status).toBe(201);
    const second = await payBill(b, billB, { amount: '160.00', idempotencyKey: KEY_A });
    expect(second.status).toBe(201);
    expect(((await second.json()) as BillPayResponse).replayed).toBe(false);

    expect(await billPaymentRows(billA)).toHaveLength(1);
    expect(await billPaymentRows(billB)).toHaveLength(1);
    expect(await balanceCents(a.companyId, '2000')).toBe(-16_000);
    expect(await balanceCents(b.companyId, '2000')).toBe(-16_000);

    await a.handle.close();
    await b.handle.close();
  });

  it('refuses a key already spent on a different bill', async () => {
    const ctx = await setup('idem-bill-reuse@test.com');
    const first = await makeBill(ctx, '320.00');
    const other = await makeBill(ctx, '320.00');

    expect((await payBill(ctx, first, { amount: '160.00', idempotencyKey: KEY_A })).status).toBe(
      201,
    );
    const res = await payBill(ctx, other, { amount: '160.00', idempotencyKey: KEY_A });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('idempotency_key_reused');

    expect(await billPaymentRows(other)).toHaveLength(0);
    // Only the first bill's payment posted; the two bills' open postings are
    // separate entries and untouched.
    expect(await postingCount(ctx.companyId, BILL_MEMO)).toBe(1);
    expect(await trialBalanceCents(ctx.companyId)).toBe(0);

    await ctx.handle.close();
  });
});

describe('idempotencyKey validation', () => {
  beforeEach(resetDb);

  it('rejects a key too short to be a real one and accepts an absent one', async () => {
    const ctx = await setup('idem-validation@test.com');
    const id = await makeInvoice(ctx, 'INV-V01', '1200.00');

    // A key two unrelated forms could collide on is worse than no key: a
    // collision SILENTLY swallows a real payment.
    const short = await payInvoice(ctx, id, { amount: '10.00', idempotencyKey: 'abc' });
    expect(short.status).toBe(400);

    // '' is treated as absent rather than rejected — a form rendering an empty
    // hidden input must not have its payment refused over a field the user
    // never sees.
    const blank = await payInvoice(ctx, id, { amount: '10.00', idempotencyKey: '' });
    expect(blank.status).toBe(201);
    const rows = await invoicePaymentRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey).toBeNull();

    await ctx.handle.close();
  });
});
