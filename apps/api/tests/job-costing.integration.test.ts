import { authUser, chartOfAccounts, companies, memberships } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Job costing (TMC-174) — "what was this for?" on a receipt, and the numbers it
// feeds. The seed case (one purchase, three jobs, priced flat) is the ICP
// mainline and drives most of what is asserted here.

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

type Ctx = Awaited<ReturnType<typeof setup>>;

async function setup(email: string) {
  const { app, handle } = buildApp();
  const cookie = await signUp(app, email);
  const { accountId, companyId } = await userContext(email);
  const headers = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };
  return { app, handle, cookie, accountId, companyId, headers };
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

// An issued invoice — job costing ignores drafts, and revenue only exists once
// the invoice is sent.
async function makeInvoice(
  ctx: Ctx,
  contactId: string,
  number: string,
  subtotal: string,
  issueDate = '2026-06-10',
): Promise<string> {
  const res = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId,
      number,
      issueDate,
      dueDate: '2026-07-10',
      subtotal,
      total: subtotal,
      lineItems: [
        {
          position: 1,
          description: 'Work',
          quantity: '1',
          unitPrice: subtotal,
          amount: subtotal,
          type: 'service',
        },
      ],
    }),
  });
  if (res.status !== 201) throw new Error(`invoice create failed: ${res.status}`);
  const id = ((await res.json()) as { id: string }).id;
  const sent = await ctx.app.request(`/api/invoices/${id}/mark-sent`, {
    method: 'POST',
    headers: ctx.headers,
  });
  if (sent.status !== 200) throw new Error(`invoice send failed: ${sent.status}`);
  return id;
}

async function makeExpense(ctx: Ctx, amount: string, expenseDate = '2026-06-12'): Promise<string> {
  const res = await ctx.app.request('/api/expenses', {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({
      companyId: ctx.companyId,
      categoryAccountId: await coaId(ctx.companyId, '7000'),
      paymentAccountId: await coaId(ctx.companyId, '1000'),
      amount,
      expenseDate,
      merchant: 'Nursery',
    }),
  });
  if (res.status !== 201) throw new Error(`expense create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

function allocate(ctx: Ctx, expenseId: string, allocations: unknown[]) {
  return ctx.app.request(`/api/expenses/${expenseId}/allocations`, {
    method: 'PUT',
    headers: ctx.headers,
    body: JSON.stringify({ allocations }),
  });
}

describe('PUT /api/expenses/:id/allocations', () => {
  beforeEach(resetDb);

  it('attaches a cost to one job', async () => {
    const ctx = await setup('alloc-one@test.com');
    try {
      const contactId = await makeContact(ctx, 'Smith');
      const invoiceId = await makeInvoice(ctx, contactId, 'INV-1', '600.00');
      const expenseId = await makeExpense(ctx, '40.00');

      const res = await allocate(ctx, expenseId, [{ invoiceId, share: '1' }]);
      expect(res.status).toBe(200);

      const detail = await ctx.app.request(`/api/expenses/${expenseId}`, { headers: ctx.headers });
      const body = (await detail.json()) as {
        allocations: { invoiceId: string | null; share: string }[];
      };
      expect(body.allocations).toHaveLength(1);
      expect(body.allocations[0]?.invoiceId).toBe(invoiceId);
    } finally {
      await ctx.handle.close();
    }
  });

  // The seed case: 100lb of seed, three lawns, priced flat.
  it('splits one cost across three jobs', async () => {
    const ctx = await setup('alloc-split@test.com');
    try {
      const contactId = await makeContact(ctx, 'Smith');
      const a = await makeInvoice(ctx, contactId, 'INV-1', '600.00');
      const b = await makeInvoice(ctx, contactId, 'INV-2', '500.00');
      const cInv = await makeInvoice(ctx, contactId, 'INV-3', '700.00');
      const expenseId = await makeExpense(ctx, '180.00');

      const res = await allocate(ctx, expenseId, [
        { invoiceId: a, share: '0.333333' },
        { invoiceId: b, share: '0.333333' },
        { invoiceId: cInv, share: '0.333334' },
      ]);
      expect(res.status).toBe(200);
    } finally {
      await ctx.handle.close();
    }
  });

  // "Shared" is a real answer, and it has to be distinguishable from never
  // having answered — that distinction is the whole design.
  it('records shared as a null-invoice row, distinct from no answer', async () => {
    const ctx = await setup('alloc-shared@test.com');
    try {
      const expenseId = await makeExpense(ctx, '180.00');

      const before = await ctx.app.request(`/api/expenses/${expenseId}`, { headers: ctx.headers });
      expect(((await before.json()) as { allocations: unknown[] }).allocations).toHaveLength(0);

      expect((await allocate(ctx, expenseId, [{ invoiceId: null, share: '1' }])).status).toBe(200);

      const after = await ctx.app.request(`/api/expenses/${expenseId}`, { headers: ctx.headers });
      const body = (await after.json()) as { allocations: { invoiceId: string | null }[] };
      expect(body.allocations).toHaveLength(1);
      expect(body.allocations[0]?.invoiceId).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('replaces the whole set rather than appending', async () => {
    const ctx = await setup('alloc-replace@test.com');
    try {
      const contactId = await makeContact(ctx, 'Smith');
      const invoiceId = await makeInvoice(ctx, contactId, 'INV-1', '600.00');
      const expenseId = await makeExpense(ctx, '40.00');

      await allocate(ctx, expenseId, [{ invoiceId, share: '1' }]);
      await allocate(ctx, expenseId, [{ invoiceId: null, share: '1' }]);

      const detail = await ctx.app.request(`/api/expenses/${expenseId}`, { headers: ctx.headers });
      const body = (await detail.json()) as { allocations: { invoiceId: string | null }[] };
      expect(body.allocations).toHaveLength(1);
      expect(body.allocations[0]?.invoiceId).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('clears the answer on an empty list', async () => {
    const ctx = await setup('alloc-clear@test.com');
    try {
      const expenseId = await makeExpense(ctx, '40.00');
      await allocate(ctx, expenseId, [{ invoiceId: null, share: '1' }]);
      expect((await allocate(ctx, expenseId, [])).status).toBe(200);

      const detail = await ctx.app.request(`/api/expenses/${expenseId}`, { headers: ctx.headers });
      expect(((await detail.json()) as { allocations: unknown[] }).allocations).toHaveLength(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects shares that do not sum to one', async () => {
    const ctx = await setup('alloc-sum@test.com');
    try {
      const contactId = await makeContact(ctx, 'Smith');
      const a = await makeInvoice(ctx, contactId, 'INV-1', '600.00');
      const b = await makeInvoice(ctx, contactId, 'INV-2', '500.00');
      const expenseId = await makeExpense(ctx, '180.00');

      const res = await allocate(ctx, expenseId, [
        { invoiceId: a, share: '0.5' },
        { invoiceId: b, share: '0.2' },
      ]);
      expect(res.status).toBe(400);
    } finally {
      await ctx.handle.close();
    }
  });

  it('404s an invoice from another account', async () => {
    const mine = await setup('alloc-mine@test.com');
    const theirs = await setup('alloc-theirs@test.com');
    try {
      const theirContact = await makeContact(theirs, 'Someone Else');
      const theirInvoice = await makeInvoice(theirs, theirContact, 'INV-X', '900.00');
      const expenseId = await makeExpense(mine, '40.00');

      const res = await allocate(mine, expenseId, [{ invoiceId: theirInvoice, share: '1' }]);
      expect(res.status).toBe(404);
    } finally {
      await mine.handle.close();
      await theirs.handle.close();
    }
  });
});

describe('invoice detail — job costing figures', () => {
  beforeEach(resetDb);

  it('reports billed, costs and made', async () => {
    const ctx = await setup('margin-detail@test.com');
    try {
      const contactId = await makeContact(ctx, 'Smith');
      const invoiceId = await makeInvoice(ctx, contactId, 'INV-1', '600.00');
      const expenseId = await makeExpense(ctx, '40.00');
      await allocate(ctx, expenseId, [{ invoiceId, share: '1' }]);

      const res = await ctx.app.request(`/api/invoices/${invoiceId}`, { headers: ctx.headers });
      const body = (await res.json()) as {
        jobCosting: { billed: string; costs: string; made: string; costCount: number };
      };
      expect(body.jobCosting.billed).toBe('600.00');
      expect(body.jobCosting.costs).toBe('40.00');
      expect(body.jobCosting.made).toBe('560.00');
      expect(body.jobCosting.costCount).toBe(1);
    } finally {
      await ctx.handle.close();
    }
  });

  it('counts only this job’s share of a split cost', async () => {
    const ctx = await setup('margin-share@test.com');
    try {
      const contactId = await makeContact(ctx, 'Smith');
      const a = await makeInvoice(ctx, contactId, 'INV-1', '600.00');
      const b = await makeInvoice(ctx, contactId, 'INV-2', '500.00');
      const expenseId = await makeExpense(ctx, '180.00');
      await allocate(ctx, expenseId, [
        { invoiceId: a, share: '0.5' },
        { invoiceId: b, share: '0.5' },
      ]);

      const res = await ctx.app.request(`/api/invoices/${a}`, { headers: ctx.headers });
      const body = (await res.json()) as { jobCosting: { costs: string; made: string } };
      expect(body.jobCosting.costs).toBe('90.00');
      expect(body.jobCosting.made).toBe('510.00');
    } finally {
      await ctx.handle.close();
    }
  });

  // THE HARD RULE. His markup is his business; leaking it onto the page the
  // customer opens damages a real relationship, and it is the one way this
  // otherwise-harmless feature can hurt someone.
  it('never leaks cost or margin to the public invoice view', async () => {
    const ctx = await setup('margin-leak@test.com');
    try {
      const contactId = await makeContact(ctx, 'Smith');
      const invoiceId = await makeInvoice(ctx, contactId, 'INV-1', '1000.00');
      const expenseId = await makeExpense(ctx, '900.00');
      await allocate(ctx, expenseId, [{ invoiceId, share: '1' }]);

      const db = getTestDb();
      const { invoices } = await import('@thalermark/db');
      const [row] = await db
        .select({ publicToken: invoices.publicToken })
        .from(invoices)
        .where(eq(invoices.id, invoiceId));
      const res = await ctx.app.request(`/api/public/invoices/${row?.publicToken}`);
      expect(res.status).toBe(200);
      const raw = await res.text();

      expect(raw).not.toContain('jobCosting');
      expect(raw).not.toContain('900.00');
      expect(raw).not.toContain('made');
      expect(raw).not.toContain('costs');
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('GET /api/companies/:id/job-margin', () => {
  beforeEach(resetDb);

  it('lists jobs with their own costs and keeps shared in its own bucket', async () => {
    const ctx = await setup('margin-report@test.com');
    try {
      const contactId = await makeContact(ctx, 'Smith');
      const a = await makeInvoice(ctx, contactId, 'INV-1', '600.00');
      const b = await makeInvoice(ctx, contactId, 'INV-2', '500.00');

      const direct = await makeExpense(ctx, '40.00');
      await allocate(ctx, direct, [{ invoiceId: a, share: '1' }]);
      const seed = await makeExpense(ctx, '180.00');
      await allocate(ctx, seed, [{ invoiceId: null, share: '1' }]);
      // Never answered for — a third bucket, deliberately not the same as shared.
      await makeExpense(ctx, '25.00');

      const res = await ctx.app.request(
        `/api/companies/${ctx.companyId}/job-margin?from=2026-06-01&to=2026-06-30`,
        { headers: ctx.headers },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        jobs: {
          invoiceId: string;
          customerName: string;
          billed: string;
          costs: string;
          made: string;
        }[];
        totals: {
          billed: string;
          jobCosts: string;
          shared: string;
          unattributed: string;
          made: string;
        };
      };

      expect(body.jobs).toHaveLength(2);
      const jobA = body.jobs.find((j) => j.invoiceId === a);
      const jobB = body.jobs.find((j) => j.invoiceId === b);
      expect(jobA?.customerName).toBe('Smith');
      expect(jobA?.costs).toBe('40.00');
      expect(jobA?.made).toBe('560.00');
      // Shared never lands on a job.
      expect(jobB?.costs).toBe('0.00');
      expect(jobB?.made).toBe('500.00');

      expect(body.totals.billed).toBe('1100.00');
      expect(body.totals.jobCosts).toBe('40.00');
      expect(body.totals.shared).toBe('180.00');
      expect(body.totals.unattributed).toBe('25.00');
      expect(body.totals.made).toBe('880.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('excludes drafts — an unsent invoice is not a job yet', async () => {
    const ctx = await setup('margin-draft@test.com');
    try {
      const contactId = await makeContact(ctx, 'Smith');
      await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          companyId: ctx.companyId,
          contactId,
          number: 'INV-DRAFT',
          issueDate: '2026-06-10',
          dueDate: '2026-07-10',
          subtotal: '400.00',
          total: '400.00',
          lineItems: [
            {
              position: 1,
              description: 'Work',
              quantity: '1',
              unitPrice: '400.00',
              amount: '400.00',
              type: 'service',
            },
          ],
        }),
      });

      const res = await ctx.app.request(
        `/api/companies/${ctx.companyId}/job-margin?from=2026-06-01&to=2026-06-30`,
        { headers: ctx.headers },
      );
      const body = (await res.json()) as { jobs: unknown[] };
      expect(body.jobs).toHaveLength(0);
    } finally {
      await ctx.handle.close();
    }
  });

  // Regression: the filter excluded the literal 'void', but the transition
  // stores 'voided' (INVOICE_TRANSITIONS, routes/invoices.ts), so a voided
  // invoice kept its full subtotal in billed and overstated the job's margin —
  // and its total. Cancelled work is not revenue.
  it('excludes voided invoices — cancelled work is not revenue', async () => {
    const ctx = await setup('margin-voided@test.com');
    try {
      const contactId = await makeContact(ctx, 'Smith');
      const live = await makeInvoice(ctx, contactId, 'INV-1', '600.00');
      const cancelled = await makeInvoice(ctx, contactId, 'INV-2', '500.00');

      const voided = await ctx.app.request(`/api/invoices/${cancelled}/void`, {
        method: 'POST',
        headers: ctx.headers,
      });
      expect(voided.status).toBe(200);

      const res = await ctx.app.request(
        `/api/companies/${ctx.companyId}/job-margin?from=2026-06-01&to=2026-06-30`,
        { headers: ctx.headers },
      );
      const body = (await res.json()) as {
        jobs: { invoiceId: string }[];
        totals: { billed: string; made: string };
      };

      expect(body.jobs).toHaveLength(1);
      expect(body.jobs[0]?.invoiceId).toBe(live);
      expect(body.totals.billed).toBe('600.00');
      expect(body.totals.made).toBe('600.00');
    } finally {
      await ctx.handle.close();
    }
  });
});
