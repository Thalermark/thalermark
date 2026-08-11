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

// Correcting an invoice the customer already has (TMC-227).
//
// A landscaper types $450 instead of $4,500 and hits send. The flow is three
// separate actions in one order — pull back, edit, resend — and the order is
// the design: the ledger reversal runs while the row still holds the values it
// is reversing. Every reversal helper in this codebase RE-DERIVES its lines
// from the entity row rather than reading the original entry back, so a flow
// that edited first would cancel the new numbers against the old posting. That
// entry balances perfectly and is wrong, which is why a trial-balance check
// alone proves nothing here.
//
// The tests are ordered the way the feature was built: the reversal first, then
// the guards on the states that would corrupt it, then the round trip.

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

// Debits positive, credits negative, across the whole company. A correct set of
// books nets to exactly zero — necessary, nowhere near sufficient (see the
// header), which is why the per-account assertions sit beside it.
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

// Every entry filed under one invoice, oldest first — the source group
// cashFlowNet nets by, and the only way to see WHICH date a correction landed
// on rather than merely that it balanced.
async function entriesFor(invoiceId: string) {
  const db = getTestDb();
  return db
    .select({
      id: journalEntries.id,
      memo: journalEntries.memo,
      postedAt: journalEntries.postedAt,
    })
    .from(journalEntries)
    .where(eq(journalEntries.sourceEntityId, invoiceId))
    .orderBy(journalEntries.postedAt, journalEntries.id);
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

type InvoiceOpts = {
  issueDate?: string;
  dueDate?: string;
  send?: boolean;
  // A mixed product/service, taxed invoice exercises all four legs of the
  // reversal rather than the degenerate two-leg shape.
  mixed?: boolean;
};

async function makeInvoice(
  ctx: Ctx,
  number: string,
  total: string,
  opts: InvoiceOpts = {},
): Promise<{ id: string; contactId: string }> {
  const { issueDate = '2026-06-10', dueDate = '2026-07-10', send = true, mixed = false } = opts;
  const contactId = await makeContact(ctx, `Customer ${number}`);
  const body = mixed
    ? {
        subtotal: '100.00',
        tax: '8.25',
        total: '108.25',
        lineItems: [
          {
            position: 1,
            description: 'Mowing',
            quantity: '1',
            unitPrice: '60.00',
            amount: '60.00',
            type: 'service' as const,
            taxable: true,
            taxRatePct: '8.2500',
            taxAmount: '4.95',
          },
          {
            position: 2,
            description: 'Mulch',
            quantity: '1',
            unitPrice: '40.00',
            amount: '40.00',
            type: 'product' as const,
            taxable: true,
            taxRatePct: '8.2500',
            taxAmount: '3.30',
          },
        ],
      }
    : {
        subtotal: total,
        total,
        lineItems: [
          {
            position: 1,
            description: 'Work',
            quantity: '1',
            unitPrice: total,
            amount: total,
            type: 'service' as const,
          },
        ],
      };
  const res = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId,
      number,
      issueDate,
      dueDate,
      ...body,
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
  return { id, contactId };
}

function revise(ctx: Ctx, id: string) {
  return ctx.app.request(`/api/invoices/${id}/revise`, { method: 'POST', headers: ctx.headers });
}

function markSent(ctx: Ctx, id: string) {
  return ctx.app.request(`/api/invoices/${id}/mark-sent`, { method: 'POST', headers: ctx.headers });
}

function pay(ctx: Ctx, id: string, amount: string, receivedOn = '2026-06-15') {
  return ctx.app.request(`/api/invoices/${id}/payments`, {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({ amount, receivedOn, method: 'check' }),
  });
}

// The whole-invoice edit the draft editor performs. Line items are replaced
// wholesale, exactly as the form submits them.
function editTotal(
  ctx: Ctx,
  id: string,
  contactId: string,
  number: string,
  total: string,
  dates: { issueDate?: string; dueDate?: string } = {},
) {
  const { issueDate = '2026-06-10', dueDate = '2026-07-10' } = dates;
  return ctx.app.request(`/api/invoices/${id}`, {
    method: 'PATCH',
    headers: ctx.headers,
    body: JSON.stringify({
      contactId,
      number,
      issueDate,
      dueDate,
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
}

async function getInvoice(ctx: Ctx, id: string) {
  const res = await ctx.app.request(`/api/invoices/${id}`, { headers: ctx.headers });
  return (await res.json()) as {
    status: string;
    number: string;
    total: string;
    sentAt: string | null;
    publicToken: string | null;
    revisions: { revisedAt: string; previousTotal: string; previousIssueDate: string }[];
  };
}

describe('POST /api/invoices/:id/revise — the reversal', () => {
  beforeEach(resetDb);

  it('takes the receivable and both revenue legs back off the books', async () => {
    const ctx = await setup('reverse@test.com');
    try {
      const { id } = await makeInvoice(ctx, 'INV-001', '0', { mixed: true });

      // Issued: AR debited at gross, revenue split across service/product, the
      // collected tax sitting in the payable.
      expect(await balanceCents(ctx.companyId, '1200')).toBe(10_825);
      expect(await balanceCents(ctx.companyId, '4000')).toBe(-6_000);
      expect(await balanceCents(ctx.companyId, '4100')).toBe(-4_000);
      expect(await balanceCents(ctx.companyId, '2200')).toBe(-825);

      const res = await revise(ctx, id);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe('draft');

      // Every one of the four accounts back to nothing. This is the assertion a
      // trial-balance check cannot make: a reversal that flipped the wrong legs
      // still nets to zero overall.
      expect(await balanceCents(ctx.companyId, '1200')).toBe(0);
      expect(await balanceCents(ctx.companyId, '4000')).toBe(0);
      expect(await balanceCents(ctx.companyId, '4100')).toBe(0);
      expect(await balanceCents(ctx.companyId, '2200')).toBe(0);
      expect(await trialBalanceCents(ctx.companyId)).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('posts the reversal at the ORIGINAL issue date, not today', async () => {
    const ctx = await setup('reversedate@test.com');
    try {
      const { id } = await makeInvoice(ctx, 'INV-002', '450.00', { issueDate: '2026-02-03' });
      await revise(ctx, id);

      const entries = await entriesFor(id);
      expect(entries).toHaveLength(2);
      // Both legs in February — the pair nets inside the period it belonged to,
      // rather than leaving revenue in February and its reversal in August.
      for (const entry of entries) {
        expect(entry.postedAt.toISOString()).toBe('2026-02-03T00:00:00.000Z');
      }
      // The ledger viewer must say what happened, not what the row became.
      expect(entries[1]?.memo).toBe('Invoice INV-002 revised');
    } finally {
      await ctx.handle.close();
    }
  });

  it('keeps the number, the public link and the proof it was issued', async () => {
    const ctx = await setup('identity@test.com');
    try {
      const { id } = await makeInvoice(ctx, 'INV-003', '450.00');
      const before = await getInvoice(ctx, id);
      expect(before.publicToken).not.toBeNull();

      await revise(ctx, id);
      const after = await getInvoice(ctx, id);

      expect(after.status).toBe('draft');
      // Same document. The customer's link still resolves, and the next invoice
      // is still INV-004 rather than INV-003-2.
      expect(after.number).toBe('INV-003');
      expect(after.publicToken).toBe(before.publicToken);
      // sent_at survives deliberately: it is what makes 'draft' + sent_at the
      // unambiguous "being revised" state, and what keeps a later receipt
      // posting against a receivable rather than a counter sale.
      expect(after.sentAt).toBe(before.sentAt);
    } finally {
      await ctx.handle.close();
    }
  });

  it('records what the customer was told, before the edit lands', async () => {
    const ctx = await setup('snapshot@test.com');
    try {
      const { id, contactId } = await makeInvoice(ctx, 'INV-004', '450.00', {
        issueDate: '2026-06-10',
      });
      await revise(ctx, id);
      await editTotal(ctx, id, contactId, 'INV-004', '4500.00');

      const invoice = await getInvoice(ctx, id);
      expect(invoice.total).toBe('4500.00');
      expect(invoice.revisions).toHaveLength(1);
      expect(invoice.revisions[0]?.previousTotal).toBe('450.00');
      expect(invoice.revisions[0]?.previousIssueDate).toBe('2026-06-10');
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('POST /api/invoices/:id/revise — refusals', () => {
  beforeEach(resetDb);

  it('refuses a paid invoice and names the way out', async () => {
    const ctx = await setup('paid@test.com');
    try {
      const { id } = await makeInvoice(ctx, 'INV-010', '450.00');
      await pay(ctx, id, '450.00');

      const res = await revise(ctx, id);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('invoice_paid');
    } finally {
      await ctx.handle.close();
    }
  });

  it('refuses a voided invoice', async () => {
    const ctx = await setup('voided@test.com');
    try {
      const { id } = await makeInvoice(ctx, 'INV-011', '450.00');
      await ctx.app.request(`/api/invoices/${id}/void`, { method: 'POST', headers: ctx.headers });

      const res = await revise(ctx, id);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_transition');
    } finally {
      await ctx.handle.close();
    }
  });

  it('refuses a draft that was never issued', async () => {
    const ctx = await setup('neverissued@test.com');
    try {
      const { id } = await makeInvoice(ctx, 'INV-012', '450.00', { send: false });

      const res = await revise(ctx, id);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; from: string };
      expect(body.error).toBe('invalid_transition');
      expect(body.from).toBe('draft');
    } finally {
      await ctx.handle.close();
    }
  });

  it('refuses a second pull-back while one is already in progress', async () => {
    const ctx = await setup('doublepull@test.com');
    try {
      const { id } = await makeInvoice(ctx, 'INV-013', '450.00');
      expect((await revise(ctx, id)).status).toBe(200);

      const again = await revise(ctx, id);
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toBe('invalid_transition');
      // And nothing was reversed twice.
      expect(await balanceCents(ctx.companyId, '1200')).toBe(0);
      expect(await balanceCents(ctx.companyId, '4000')).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('refuses a closed year and leaves the invoice exactly as it was', async () => {
    const ctx = await setup('closedyear@test.com');
    try {
      const { id } = await makeInvoice(ctx, 'INV-014', '450.00', {
        issueDate: '2025-06-10',
        dueDate: '2025-07-10',
      });
      const closed = await ctx.app.request('/api/ledger/period-closes', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({ companyId: ctx.companyId, fiscalYear: 2025 }),
      });
      expect(closed.status).toBe(201);

      const res = await revise(ctx, id);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; closedThrough: string };
      expect(body.error).toBe('period_closed');
      expect(body.closedThrough).toBeTruthy();

      // Refused BEFORE any write — not rolled back after one. The row is
      // untouched and no correction entry exists.
      const invoice = await getInvoice(ctx, id);
      expect(invoice.status).toBe('sent');
      expect(invoice.revisions).toHaveLength(0);
      const memos = (await entriesFor(id)).map((e) => e.memo);
      expect(memos).not.toContain('Invoice INV-014 revised');
    } finally {
      await ctx.handle.close();
    }
  });

  it('lets exactly one of two concurrent pull-backs win', async () => {
    const ctx = await setup('race@test.com');
    try {
      const { id } = await makeInvoice(ctx, 'INV-015', '450.00');

      const [a, b] = await Promise.all([revise(ctx, id), revise(ctx, id)]);
      const codes = [a.status, b.status].sort();
      expect(codes).toEqual([200, 409]);

      // One reversal, not two. The compare-and-swap in the transition funnel is
      // what makes this true; without it the second would post a mirror entry
      // and drive revenue positive.
      expect(await balanceCents(ctx.companyId, '4000')).toBe(0);
      expect(await balanceCents(ctx.companyId, '1200')).toBe(0);
      expect(await trialBalanceCents(ctx.companyId)).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });
});

// The two paths that would flip a revising draft back to 'sent' with no revenue
// posting behind it — an invoice permanently off the books, uneditable and
// unsendable. Both are guarded on BOTH halves of the predicate, because a draft
// with payments and no sent_at is a legitimate refunded counter sale.
describe('revision-state guards', () => {
  beforeEach(resetDb);

  it('refuses to remove a payment mid-correction', async () => {
    const ctx = await setup('paymentdelete@test.com');
    try {
      const { id } = await makeInvoice(ctx, 'INV-020', '450.00');
      const paid = (await (await pay(ctx, id, '200.00')).json()) as { payment: { id: string } };
      await revise(ctx, id);

      const res = await ctx.app.request(`/api/invoices/${id}/payments/${paid.payment.id}`, {
        method: 'DELETE',
        headers: ctx.headers,
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('revision_in_progress');

      // The receipt is still there and the invoice is still a draft — the
      // corruption would have been a silent flip back to 'sent'.
      const invoice = await getInvoice(ctx, id);
      expect(invoice.status).toBe('draft');
    } finally {
      await ctx.handle.close();
    }
  });

  it('refuses to mark a revising draft paid', async () => {
    const ctx = await setup('markpaid@test.com');
    try {
      const { id } = await makeInvoice(ctx, 'INV-021', '450.00');
      await revise(ctx, id);

      const res = await ctx.app.request(`/api/invoices/${id}/mark-paid`, {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({ method: 'cash' }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('revision_in_progress');
      // No receipt posted against a receivable that is no longer on the books.
      expect(await balanceCents(ctx.companyId, '1000')).toBe(0);
      expect(await balanceCents(ctx.companyId, '1200')).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('still lets a never-issued cash sale have its receipt removed', async () => {
    const ctx = await setup('cashsale@test.com');
    try {
      // Never sent. mark-paid on a draft is the counter-sale path: revenue
      // credited directly, no receivable, sent_at still null.
      const { id } = await makeInvoice(ctx, 'INV-022', '80.00', { send: false });
      const marked = await ctx.app.request(`/api/invoices/${id}/mark-paid`, {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({ method: 'cash', paidOn: '2026-06-12' }),
      });
      expect(marked.status).toBe(200);

      const list = (await (
        await ctx.app.request(`/api/invoices/${id}/payments`, { headers: ctx.headers })
      ).json()) as { payments: { id: string }[] };
      const paymentId = list.payments[0]?.id as string;

      const res = await ctx.app.request(`/api/invoices/${id}/payments/${paymentId}`, {
        method: 'DELETE',
        headers: ctx.headers,
      });
      // Allowed — this is not a correction, and the invoice returns to the
      // draft it always was.
      expect(res.status).toBe(200);
      expect(((await res.json()) as { invoice: { status: string } }).invoice.status).toBe('draft');
      expect(await trialBalanceCents(ctx.companyId)).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('refuses a new payment against a revising draft, as it always has', async () => {
    const ctx = await setup('paydraft@test.com');
    try {
      const { id } = await makeInvoice(ctx, 'INV-023', '450.00');
      await revise(ctx, id);

      const res = await pay(ctx, id, '100.00');
      expect(res.status).toBe(409);
      // Pinned, not new: the eligibility check already refuses drafts because a
      // draft has no receivable to pay down.
      expect(((await res.json()) as { error: string }).error).toBe('not_issued');
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('the round trip — pull back, edit, resend', () => {
  beforeEach(resetDb);

  it('moves revenue by exactly the correction', async () => {
    const ctx = await setup('roundtrip@test.com');
    try {
      const { id, contactId } = await makeInvoice(ctx, 'INV-030', '450.00');
      await revise(ctx, id);
      expect((await editTotal(ctx, id, contactId, 'INV-030', '4500.00')).status).toBe(200);
      expect((await markSent(ctx, id)).status).toBe(200);

      // Not 450 + 4500, and not 4050. The books carry the corrected invoice and
      // nothing else.
      expect(await balanceCents(ctx.companyId, '1200')).toBe(450_000);
      expect(await balanceCents(ctx.companyId, '4000')).toBe(-450_000);
      expect(await trialBalanceCents(ctx.companyId)).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('follows a corrected issue date into its new period', async () => {
    const ctx = await setup('datemove@test.com');
    try {
      const { id, contactId } = await makeInvoice(ctx, 'INV-031', '450.00', {
        issueDate: '2026-02-03',
        dueDate: '2026-03-03',
      });
      await revise(ctx, id);
      await editTotal(ctx, id, contactId, 'INV-031', '450.00', {
        issueDate: '2026-03-09',
        dueDate: '2026-04-09',
      });
      await markSent(ctx, id);

      const dates = (await entriesFor(id)).map((e) => e.postedAt.toISOString().slice(0, 10));
      // Issue and its reversal both in February — that month nets to zero — and
      // the re-issue in March, where the invoice now says it belongs.
      expect(dates).toEqual(['2026-02-03', '2026-02-03', '2026-03-09']);
      expect(await balanceCents(ctx.companyId, '1200')).toBe(45_000);
      expect(await trialBalanceCents(ctx.companyId)).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('leaves every balance at baseline after a correction that changed nothing', async () => {
    const ctx = await setup('doublerevise@test.com');
    try {
      const { id, contactId } = await makeInvoice(ctx, 'INV-032', '450.00', { mixed: true });
      const baseline = {
        ar: await balanceCents(ctx.companyId, '1200'),
        service: await balanceCents(ctx.companyId, '4000'),
        product: await balanceCents(ctx.companyId, '4100'),
        tax: await balanceCents(ctx.companyId, '2200'),
      };

      for (let round = 0; round < 2; round++) {
        expect((await revise(ctx, id)).status).toBe(200);
        // Resent unchanged — the same numbers the customer already has.
        const patched = await ctx.app.request(`/api/invoices/${id}`, {
          method: 'PATCH',
          headers: ctx.headers,
          body: JSON.stringify({
            contactId,
            number: 'INV-032',
            issueDate: '2026-06-10',
            dueDate: '2026-07-10',
            subtotal: '100.00',
            tax: '8.25',
            total: '108.25',
            lineItems: [
              {
                position: 1,
                description: 'Mowing',
                quantity: '1',
                unitPrice: '60.00',
                amount: '60.00',
                type: 'service',
                taxable: true,
                taxRatePct: '8.2500',
                taxAmount: '4.95',
              },
              {
                position: 2,
                description: 'Mulch',
                quantity: '1',
                unitPrice: '40.00',
                amount: '40.00',
                type: 'product',
                taxable: true,
                taxRatePct: '8.2500',
                taxAmount: '3.30',
              },
            ],
          }),
        });
        expect(patched.status).toBe(200);
        expect((await markSent(ctx, id)).status).toBe(200);
      }

      // The reverse-re-derives trap, checked end to end: two full corrections
      // that changed nothing must leave the books precisely where they started.
      expect(await balanceCents(ctx.companyId, '1200')).toBe(baseline.ar);
      expect(await balanceCents(ctx.companyId, '4000')).toBe(baseline.service);
      expect(await balanceCents(ctx.companyId, '4100')).toBe(baseline.product);
      expect(await balanceCents(ctx.companyId, '2200')).toBe(baseline.tax);
      expect(await trialBalanceCents(ctx.companyId)).toBe(0);

      const invoice = await getInvoice(ctx, id);
      expect(invoice.revisions).toHaveLength(2);
    } finally {
      await ctx.handle.close();
    }
  });

  it('keeps a deposit attached and reports the corrected balance', async () => {
    const ctx = await setup('partialpaid@test.com');
    try {
      const { id, contactId } = await makeInvoice(ctx, 'INV-033', '450.00');
      await pay(ctx, id, '200.00');
      await revise(ctx, id);
      await editTotal(ctx, id, contactId, 'INV-033', '500.00');
      await markSent(ctx, id);

      const res = await ctx.app.request(`/api/invoices/${id}/payments`, { headers: ctx.headers });
      const body = (await res.json()) as {
        settlement: string;
        paid: string;
        outstanding: string;
        payments: unknown[];
      };
      // $300, not $450 and not $250. The receipt never moved — same row, same
      // invoice id — so nothing had to be re-pointed.
      expect(body.outstanding).toBe('300.00');
      expect(body.paid).toBe('200.00');
      expect(body.settlement).toBe('partial');
      expect(body.payments).toHaveLength(1);

      expect(await balanceCents(ctx.companyId, '1200')).toBe(30_000);
      expect(await balanceCents(ctx.companyId, '1000')).toBe(20_000);
      expect(await trialBalanceCents(ctx.companyId)).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('settles the invoice when the correction drops below what was already paid', async () => {
    const ctx = await setup('overpaid@test.com');
    try {
      const { id, contactId } = await makeInvoice(ctx, 'INV-034', '450.00');
      await pay(ctx, id, '200.00');
      await revise(ctx, id);
      await editTotal(ctx, id, contactId, 'INV-034', '150.00');

      const resent = await markSent(ctx, id);
      expect(resent.status).toBe(200);
      // The resend re-derives settlement from the receipts. Without that the
      // invoice would sit in 'sent', chased by reminders, for money it is owed
      // in the other direction.
      expect(((await resent.json()) as { status: string }).status).toBe('paid');

      const body = (await (
        await ctx.app.request(`/api/invoices/${id}/payments`, { headers: ctx.headers })
      ).json()) as { settlement: string; outstanding: string };
      expect(body.settlement).toBe('overpaid');
      expect(body.outstanding).toBe('-50.00');
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('finding a half-finished correction', () => {
  beforeEach(resetDb);

  it('counts and lists invoices that are being fixed', async () => {
    const ctx = await setup('revisinglist@test.com');
    try {
      const { id } = await makeInvoice(ctx, 'INV-040', '450.00');
      await makeInvoice(ctx, 'INV-041', '120.00', { send: false });
      await revise(ctx, id);

      const summary = (await (
        await ctx.app.request(`/api/invoices/summary?companyId=${ctx.companyId}`, {
          headers: ctx.headers,
        })
      ).json()) as { draft: { count: number }; revising: { count: number } };
      expect(summary.revising.count).toBe(1);
      // A subset of the drafts, not a partition of them — an abandoned
      // correction is still a draft.
      expect(summary.draft.count).toBe(2);

      const list = (await (
        await ctx.app.request(`/api/invoices?companyId=${ctx.companyId}&revising=true`, {
          headers: ctx.headers,
        })
      ).json()) as { invoices: { id: string }[] };
      expect(list.invoices.map((i) => i.id)).toEqual([id]);
    } finally {
      await ctx.handle.close();
    }
  });
});
