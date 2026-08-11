import { authUser, chartOfAccounts, companies, memberships } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// GET /api/invoices/:id/send-check (TMC-227, PR 2).
//
// The thresholds are pinned by the unit suite beside the pure core. What is
// tested HERE is the half the core cannot see: which invoices the baseline is
// built from. Every one of these is a query decision that would leave the
// arithmetic perfectly correct and the answer wrong.

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

async function coaId(companyId: string, code: string): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.companyId, companyId), eq(chartOfAccounts.code, code)));
  if (!row) throw new Error(`COA ${code} missing`);
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

type InvoiceOpts = {
  jobId?: string;
  issueDate?: string;
  // 'sent' is the default; 'draft' leaves it unissued and 'voided' issues then
  // cancels it. Both of those are baseline-exclusion cases.
  state?: 'sent' | 'draft' | 'voided';
};

let seq = 0;

async function makeInvoice(
  ctx: Ctx,
  contactId: string,
  total: string,
  opts: InvoiceOpts = {},
): Promise<string> {
  const { jobId, issueDate = '2026-06-10', state = 'sent' } = opts;
  seq += 1;
  const res = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId,
      jobId,
      number: `INV-${String(seq).padStart(4, '0')}`,
      issueDate,
      dueDate: '2026-07-10',
      subtotal: total,
      total,
      lineItems: [
        {
          position: 1,
          description: 'Mowing',
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
  if (state !== 'draft') {
    await ctx.app.request(`/api/invoices/${id}/mark-sent`, {
      method: 'POST',
      headers: ctx.headers,
    });
  }
  if (state === 'voided') {
    await ctx.app.request(`/api/invoices/${id}/void`, { method: 'POST', headers: ctx.headers });
  }
  return id;
}

async function sendCheck(ctx: Ctx, id: string) {
  const res = await ctx.app.request(`/api/invoices/${id}/send-check`, { headers: ctx.headers });
  return {
    status: res.status,
    body: (await res.json()) as { concern: string | null; signal: string | null },
  };
}

describe('GET /api/invoices/:id/send-check', () => {
  beforeEach(resetDb);

  it('says nothing about an ordinary invoice', async () => {
    const ctx = await setup('quiet@test.com');
    try {
      const contactId = await makeContact(ctx, 'Mrs Patel');
      for (const t of ['200.00', '180.00', '220.00']) await makeInvoice(ctx, contactId, t);
      const subject = await makeInvoice(ctx, contactId, '230.00', { state: 'draft' });

      const { status, body } = await sendCheck(ctx, subject);
      expect(status).toBe(200);
      // 200 with nulls, never a 404-shaped "nothing to say" — silence is the
      // ordinary answer and a client must tell it from a failed request.
      expect(body.concern).toBeNull();
      expect(body.signal).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('catches the dropped zero against the customer’s own history', async () => {
    const ctx = await setup('droppedzero@test.com');
    try {
      const contactId = await makeContact(ctx, 'Mrs Patel');
      for (const t of ['450.00', '420.00', '480.00']) await makeInvoice(ctx, contactId, t);
      // The whole motivating case, in reverse: $4,500 typed where $450 was meant
      // reads the same to this check as $450 typed where $4,500 was meant.
      const subject = await makeInvoice(ctx, contactId, '4500.00', { state: 'draft' });

      const { body } = await sendCheck(ctx, subject);
      expect(body.signal).toBe('power_of_ten');
      expect(body.concern).toContain('ten times');
      expect(body.concern).toContain('Mrs Patel');
    } finally {
      await ctx.handle.close();
    }
  });

  // THE load-bearing query decision. A wrong draft in the list is exactly the
  // mistake being hunted; if it counted toward the baseline, the second wrong
  // invoice would look normal — the check would learn the typo.
  it('ignores drafts when working out what is usual', async () => {
    const ctx = await setup('draftsout@test.com');
    try {
      const contactId = await makeContact(ctx, 'Mrs Patel');
      for (const t of ['200.00', '210.00', '190.00']) await makeInvoice(ctx, contactId, t);
      // Three wrong drafts at the ten-times figure. If these polluted the
      // median, the fourth would sail through.
      for (const _ of [1, 2, 3]) await makeInvoice(ctx, contactId, '2000.00', { state: 'draft' });

      const subject = await makeInvoice(ctx, contactId, '2000.00', { state: 'draft' });
      const { body } = await sendCheck(ctx, subject);
      expect(body.signal).toBe('power_of_ten');
    } finally {
      await ctx.handle.close();
    }
  });

  it('ignores voided invoices — a cancelled one is not evidence of anything', async () => {
    const ctx = await setup('voidedout@test.com');
    try {
      const contactId = await makeContact(ctx, 'Mrs Patel');
      for (const t of ['200.00', '210.00', '190.00']) await makeInvoice(ctx, contactId, t);
      for (const _ of [1, 2, 3]) await makeInvoice(ctx, contactId, '2000.00', { state: 'voided' });

      const subject = await makeInvoice(ctx, contactId, '2000.00', { state: 'draft' });
      expect((await sendCheck(ctx, subject)).body.signal).toBe('power_of_ten');
    } finally {
      await ctx.handle.close();
    }
  });

  it('does not count another customer’s invoices', async () => {
    const ctx = await setup('percustomer@test.com');
    try {
      const patel = await makeContact(ctx, 'Mrs Patel');
      const chen = await makeContact(ctx, 'The Chens');
      // Patel is a $200 customer; Chen is a $2,000 customer. Chen's history
      // must not make a $2,000 invoice to Patel look ordinary.
      for (const t of ['200.00', '210.00', '190.00']) await makeInvoice(ctx, patel, t);
      for (const t of ['2000.00', '2100.00', '1900.00']) await makeInvoice(ctx, chen, t);

      const wrong = await makeInvoice(ctx, patel, '2000.00', { state: 'draft' });
      expect((await sendCheck(ctx, wrong)).body.signal).toBe('power_of_ten');

      // And the same figure billed to Chen is just Tuesday.
      const fine = await makeInvoice(ctx, chen, '2000.00', { state: 'draft' });
      expect((await sendCheck(ctx, fine)).body.signal).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('does not count the invoice being checked', async () => {
    const ctx = await setup('selfexclude@test.com');
    try {
      const contactId = await makeContact(ctx, 'Mrs Patel');
      for (const t of ['200.00', '210.00', '190.00']) await makeInvoice(ctx, contactId, t);
      // Already issued, and being re-checked before a resend. If it counted
      // toward its own baseline it would drag the median toward itself and
      // quietly excuse the very number under suspicion.
      const subject = await makeInvoice(ctx, contactId, '2000.00');
      expect((await sendCheck(ctx, subject)).body.signal).toBe('power_of_ten');
    } finally {
      await ctx.handle.close();
    }
  });

  it('says nothing to a customer with no history at all', async () => {
    const ctx = await setup('newcustomer@test.com');
    try {
      const contactId = await makeContact(ctx, 'Brand New');
      const subject = await makeInvoice(ctx, contactId, '4500.00', { state: 'draft' });
      expect((await sendCheck(ctx, subject)).body.signal).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('flags an invoice for less than the job has already cost', async () => {
    const ctx = await setup('jobcost@test.com');
    try {
      const contactId = await makeContact(ctx, 'Mrs Patel');
      const job = (await (
        await ctx.app.request('/api/jobs', {
          method: 'POST',
          headers: ctx.headers,
          body: JSON.stringify({ companyId: ctx.companyId, name: 'Back garden rebuild' }),
        })
      ).json()) as { id: string };

      const expense = (await (
        await ctx.app.request('/api/expenses', {
          method: 'POST',
          headers: ctx.headers,
          body: JSON.stringify({
            companyId: ctx.companyId,
            categoryAccountId: await coaId(ctx.companyId, '7000'),
            paymentAccountId: await coaId(ctx.companyId, '1000'),
            amount: '800.00',
            expenseDate: '2026-06-05',
            merchant: 'Nursery',
          }),
        })
      ).json()) as { id: string };
      await ctx.app.request(`/api/expenses/${expense.id}/allocations`, {
        method: 'PUT',
        headers: ctx.headers,
        body: JSON.stringify({ allocations: [{ jobId: job.id, share: '1' }] }),
      });

      const subject = await makeInvoice(ctx, contactId, '300.00', {
        jobId: job.id,
        state: 'draft',
      });
      const { body } = await sendCheck(ctx, subject);
      // Wins over any ratio signal, and states both figures — it is a fact
      // about this invoice, not a pattern across others.
      expect(body.signal).toBe('job_cost');
      expect(body.concern).toContain('$300.00');
      expect(body.concern).toContain('$800.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('404s an invoice that is not there, and 400s a malformed id', async () => {
    const ctx = await setup('missing@test.com');
    try {
      const { v7: uuidv7 } = await import('uuid');
      expect((await sendCheck(ctx, uuidv7())).status).toBe(404);
      const bad = await ctx.app.request('/api/invoices/not-a-uuid/send-check', {
        headers: ctx.headers,
      });
      expect(bad.status).toBe(400);
    } finally {
      await ctx.handle.close();
    }
  });
});
