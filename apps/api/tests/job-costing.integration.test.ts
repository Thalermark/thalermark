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
  jobId?: string,
): Promise<string> {
  const res = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId,
      jobId,
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
        unjobbedInvoices: {
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

      expect(body.unjobbedInvoices).toHaveLength(2);
      const jobA = body.unjobbedInvoices.find((j) => j.invoiceId === a);
      const jobB = body.unjobbedInvoices.find((j) => j.invoiceId === b);
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
      const body = (await res.json()) as { unjobbedInvoices: unknown[] };
      expect(body.unjobbedInvoices).toHaveLength(0);
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
        unjobbedInvoices: { invoiceId: string }[];
        totals: { billed: string; made: string };
      };

      expect(body.unjobbedInvoices).toHaveLength(1);
      expect(body.unjobbedInvoices[0]?.invoiceId).toBe(live);
      expect(body.totals.billed).toBe('600.00');
      expect(body.totals.made).toBe('600.00');
    } finally {
      await ctx.handle.close();
    }
  });
});

// --- Jobs and time tracking (TMC-181, TMC-180) -------------------------------

async function makeJob(ctx: Ctx, name: string, contactId?: string): Promise<string> {
  const res = await ctx.app.request('/api/jobs', {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({ companyId: ctx.companyId, name, contactId }),
  });
  if (res.status !== 201) throw new Error(`job create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function logTime(ctx: Ctx, jobId: string, minutes: number, rate?: string): Promise<string> {
  const res = await ctx.app.request(`/api/jobs/${jobId}/time`, {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({ entryDate: '2026-06-11', minutes, rate }),
  });
  if (res.status !== 201) throw new Error(`time entry create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

describe('jobs', () => {
  beforeEach(resetDb);

  it('refuses a contact from a sibling company in the same account', async () => {
    const ctx = await setup('job-contact-mismatch@test.com');
    try {
      const other = await ctx.app.request('/api/companies', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({ name: 'Second Co', businessType: 'sole_prop' }),
      });
      expect(other.status).toBe(201);
      const otherCompanyId = ((await other.json()) as { id: string }).id;

      const foreign = await ctx.app.request('/api/contacts', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({ companyId: otherCompanyId, name: 'Elsewhere' }),
      });
      const foreignContactId = ((await foreign.json()) as { id: string }).id;

      const res = await ctx.app.request('/api/jobs', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          companyId: ctx.companyId,
          name: 'Cross-company',
          contactId: foreignContactId,
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('contact_company_mismatch');
    } finally {
      await ctx.handle.close();
    }
  });

  // Deleting a used job would cascade its time entries away — the same loss the
  // billed_invoice_id SET NULL exists to prevent. Close it instead.
  it('refuses to delete a job that has tracked time', async () => {
    const ctx = await setup('job-delete-guard@test.com');
    try {
      const jobId = await makeJob(ctx, 'The Smith job');
      await logTime(ctx, jobId, 60);

      const res = await ctx.app.request(`/api/jobs/${jobId}`, {
        method: 'DELETE',
        headers: ctx.headers,
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('job_has_time_entries');

      const still = await ctx.app.request(`/api/jobs/${jobId}`, { headers: ctx.headers });
      expect(still.status).toBe(200);
    } finally {
      await ctx.handle.close();
    }
  });

  it('deletes an unused job', async () => {
    const ctx = await setup('job-delete-ok@test.com');
    try {
      const jobId = await makeJob(ctx, 'Typo job');
      const res = await ctx.app.request(`/api/jobs/${jobId}`, {
        method: 'DELETE',
        headers: ctx.headers,
      });
      expect(res.status).toBe(204);
      const gone = await ctx.app.request(`/api/jobs/${jobId}`, { headers: ctx.headers });
      expect(gone.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });

  // The effective-hourly number is what time tracking exists to produce.
  it('reports effective hourly on the job detail', async () => {
    const ctx = await setup('job-effective-hourly@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Tuesdays at the Chens', contactId);
      await makeInvoice(ctx, contactId, 'INV-1', '900.00', '2026-06-10', jobId);

      const materials = await makeExpense(ctx, '140.00');
      await allocate(ctx, materials, [{ jobId, share: '1' }]);
      // 12 hours across two days.
      await logTime(ctx, jobId, 480);
      await logTime(ctx, jobId, 240);

      const res = await ctx.app.request(`/api/jobs/${jobId}`, { headers: ctx.headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        margin: {
          billed: string;
          costs: string;
          made: string;
          minutes: number;
          hours: string;
          effectiveHourly: string | null;
        };
      };
      expect(body.margin.billed).toBe('900.00');
      expect(body.margin.costs).toBe('140.00');
      expect(body.margin.made).toBe('760.00');
      expect(body.margin.minutes).toBe(720);
      expect(body.margin.hours).toBe('12.00');
      // 760 over 12 hours. The whole point: $760 is not the answer, $63.33 is.
      expect(body.margin.effectiveHourly).toBe('63.33');
    } finally {
      await ctx.handle.close();
    }
  });

  // Null, not 0 — 0 would read as "this job paid nothing an hour".
  it('reports null effective hourly when no time is tracked', async () => {
    const ctx = await setup('job-no-hours@test.com');
    try {
      const jobId = await makeJob(ctx, 'Untracked');
      const res = await ctx.app.request(`/api/jobs/${jobId}`, { headers: ctx.headers });
      const body = (await res.json()) as { margin: { effectiveHourly: string | null } };
      expect(body.margin.effectiveHourly).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('billing tracked time onto an invoice', () => {
  beforeEach(resetDb);

  async function invoiceWithTime(ctx: Ctx, jobId: string, contactId: string, entryIds: string[]) {
    return ctx.app.request('/api/invoices', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({
        companyId: ctx.companyId,
        contactId,
        jobId,
        number: 'INV-TIME',
        issueDate: '2026-06-12',
        dueDate: '2026-07-12',
        subtotal: '71.50',
        total: '71.50',
        billedTimeEntryIds: entryIds,
        lineItems: [
          {
            position: 1,
            description: 'Sitting',
            quantity: '3.2500',
            unitPrice: '22.0000',
            amount: '71.50',
            unitLabel: 'hour',
            type: 'service',
          },
        ],
      }),
    });
  }

  it('stamps the entries as billed', async () => {
    const ctx = await setup('bill-time@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Tuesdays at the Chens', contactId);
      const entryId = await logTime(ctx, jobId, 195, '22.0000');

      const res = await invoiceWithTime(ctx, jobId, contactId, [entryId]);
      expect(res.status).toBe(201);

      const unbilled = await ctx.app.request(`/api/jobs/${jobId}/time?unbilled=true`, {
        headers: ctx.headers,
      });
      const body = (await unbilled.json()) as { timeEntries: unknown[] };
      expect(body.timeEntries).toHaveLength(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('refuses to bill the same entry onto a second invoice', async () => {
    const ctx = await setup('bill-time-twice@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Tuesdays at the Chens', contactId);
      const entryId = await logTime(ctx, jobId, 195, '22.0000');
      expect((await invoiceWithTime(ctx, jobId, contactId, [entryId])).status).toBe(201);

      const second = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          companyId: ctx.companyId,
          contactId,
          jobId,
          number: 'INV-TIME-2',
          issueDate: '2026-06-13',
          dueDate: '2026-07-13',
          subtotal: '71.50',
          total: '71.50',
          billedTimeEntryIds: [entryId],
          lineItems: [
            {
              position: 1,
              description: 'Sitting',
              quantity: '3.2500',
              unitPrice: '22.0000',
              amount: '71.50',
              type: 'service',
            },
          ],
        }),
      });
      expect(second.status).toBe(409);
      expect(((await second.json()) as { error: string }).error).toBe('time_entry_already_billed');
    } finally {
      await ctx.handle.close();
    }
  });

  it('refuses to bill time onto an invoice with no job', async () => {
    const ctx = await setup('bill-time-nojob@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Tuesdays at the Chens', contactId);
      const entryId = await logTime(ctx, jobId, 60, '22.0000');

      const res = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          companyId: ctx.companyId,
          contactId,
          number: 'INV-NOJOB',
          issueDate: '2026-06-12',
          dueDate: '2026-07-12',
          subtotal: '22.00',
          total: '22.00',
          billedTimeEntryIds: [entryId],
          lineItems: [
            {
              position: 1,
              description: 'Sitting',
              quantity: '1',
              unitPrice: '22.00',
              amount: '22.00',
              type: 'service',
            },
          ],
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invoice_has_no_job');
    } finally {
      await ctx.handle.close();
    }
  });

  // Replace semantics: taking the hour line back off a draft returns the hours
  // to unbilled so they can be billed again, rather than stranding them.
  // (The invoice-deleted path is the SET NULL cascade, covered at the schema
  // level in packages/db — there is no DELETE /api/invoices endpoint.)
  it('releases entries dropped from a re-submitted invoice', async () => {
    const ctx = await setup('bill-time-release@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Tuesdays at the Chens', contactId);
      const entryId = await logTime(ctx, jobId, 195, '22.0000');
      const created = await invoiceWithTime(ctx, jobId, contactId, [entryId]);
      const invoiceId = ((await created.json()) as { id: string }).id;

      const patched = await ctx.app.request(`/api/invoices/${invoiceId}`, {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({
          contactId,
          jobId,
          number: 'INV-TIME',
          issueDate: '2026-06-12',
          dueDate: '2026-07-12',
          subtotal: '10.00',
          total: '10.00',
          billedTimeEntryIds: [],
          lineItems: [
            {
              position: 1,
              description: 'Callout',
              quantity: '1',
              unitPrice: '10.00',
              amount: '10.00',
              type: 'service',
            },
          ],
        }),
      });
      expect(patched.status).toBe(200);

      const unbilled = await ctx.app.request(`/api/jobs/${jobId}/time?unbilled=true`, {
        headers: ctx.headers,
      });
      const body = (await unbilled.json()) as { timeEntries: { id: string; minutes: number }[] };
      expect(body.timeEntries).toHaveLength(1);
      expect(body.timeEntries[0]?.id).toBe(entryId);
      expect(body.timeEntries[0]?.minutes).toBe(195);
    } finally {
      await ctx.handle.close();
    }
  });

  it('refuses to edit an entry that is already billed', async () => {
    const ctx = await setup('bill-time-edit@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Tuesdays at the Chens', contactId);
      const entryId = await logTime(ctx, jobId, 195, '22.0000');
      await invoiceWithTime(ctx, jobId, contactId, [entryId]);

      const res = await ctx.app.request(`/api/time-entries/${entryId}`, {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({ minutes: 60 }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('time_entry_billed');
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('job-margin re-grain', () => {
  beforeEach(resetDb);

  // The acceptance test for the additive model: a company that never made a job
  // gets the same rows and the same totals it got before jobs existed.
  it('is unchanged for a company with no jobs', async () => {
    const ctx = await setup('margin-no-jobs@test.com');
    try {
      const contactId = await makeContact(ctx, 'Smith');
      const a = await makeInvoice(ctx, contactId, 'INV-1', '600.00');
      await makeInvoice(ctx, contactId, 'INV-2', '500.00');
      const direct = await makeExpense(ctx, '40.00');
      await allocate(ctx, direct, [{ invoiceId: a, share: '1' }]);

      const res = await ctx.app.request(
        `/api/companies/${ctx.companyId}/job-margin?from=2026-06-01&to=2026-06-30`,
        { headers: ctx.headers },
      );
      const body = (await res.json()) as {
        jobs: unknown[];
        unjobbedInvoices: { invoiceId: string; costs: string; made: string }[];
        totals: { billed: string; jobCosts: string; made: string };
      };

      expect(body.jobs).toHaveLength(0);
      expect(body.unjobbedInvoices).toHaveLength(2);
      expect(body.unjobbedInvoices.find((r) => r.invoiceId === a)?.made).toBe('560.00');
      expect(body.totals.billed).toBe('1100.00');
      expect(body.totals.jobCosts).toBe('40.00');
      expect(body.totals.made).toBe('1060.00');
    } finally {
      await ctx.handle.close();
    }
  });

  // A job owning two invoices is the case invoice-as-job could not express.
  // Costs tagged at EITHER grain have to land on the job, or margin lies.
  it('rolls a job’s invoices and both cost grains into one row', async () => {
    const ctx = await setup('margin-named-job@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Deck rebuild', contactId);
      const deposit = await makeInvoice(ctx, contactId, 'INV-1', '400.00', '2026-06-05', jobId);
      await makeInvoice(ctx, contactId, 'INV-2', '600.00', '2026-06-20', jobId);
      const loose = await makeInvoice(ctx, contactId, 'INV-3', '250.00');

      // One cost tagged straight to the job, one tagged to an invoice that
      // belongs to it — both must reach the job.
      const lumber = await makeExpense(ctx, '300.00');
      await allocate(ctx, lumber, [{ jobId, share: '1' }]);
      const nails = await makeExpense(ctx, '20.00');
      await allocate(ctx, nails, [{ invoiceId: deposit, share: '1' }]);
      const other = await makeExpense(ctx, '15.00');
      await allocate(ctx, other, [{ invoiceId: loose, share: '1' }]);

      await logTime(ctx, jobId, 600);

      const res = await ctx.app.request(
        `/api/companies/${ctx.companyId}/job-margin?from=2026-06-01&to=2026-06-30`,
        { headers: ctx.headers },
      );
      const body = (await res.json()) as {
        jobs: {
          jobId: string;
          name: string;
          billed: string;
          costs: string;
          made: string;
          hours: string;
          effectiveHourly: string | null;
        }[];
        unjobbedInvoices: { invoiceId: string }[];
        totals: { billed: string; jobCosts: string; made: string; hours: string };
      };

      expect(body.jobs).toHaveLength(1);
      const job = body.jobs[0];
      expect(job?.jobId).toBe(jobId);
      expect(job?.name).toBe('Deck rebuild');
      // Both invoices, one row.
      expect(job?.billed).toBe('1000.00');
      // 300 job-grain + 20 invoice-grain.
      expect(job?.costs).toBe('320.00');
      expect(job?.made).toBe('680.00');
      expect(job?.hours).toBe('10.00');
      expect(job?.effectiveHourly).toBe('68.00');

      // The un-jobbed invoice keeps behaving exactly as it always did.
      expect(body.unjobbedInvoices).toHaveLength(1);
      expect(body.unjobbedInvoices[0]?.invoiceId).toBe(loose);

      // Totals span both lists and still reconcile.
      expect(body.totals.billed).toBe('1250.00');
      expect(body.totals.jobCosts).toBe('335.00');
      expect(body.totals.made).toBe('915.00');
      expect(body.totals.hours).toBe('10.00');
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('a job remembers its customer', () => {
  beforeEach(resetDb);

  // The customer is asked for at job creation, so every read has to give it
  // back. Without the name the job screen can't show it and the invoice form
  // can't prefill it, which makes the create-time question look like it did
  // nothing.
  it('returns the contact name on the job detail and the list', async () => {
    const ctx = await setup('job-contact-name@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Tuesdays at the Chens', contactId);

      const detail = await ctx.app.request(`/api/jobs/${jobId}`, { headers: ctx.headers });
      const job = (await detail.json()) as { contactId: string; contactName: string | null };
      expect(job.contactId).toBe(contactId);
      expect(job.contactName).toBe('Chen');

      const list = await ctx.app.request(`/api/jobs?companyId=${ctx.companyId}`, {
        headers: ctx.headers,
      });
      const body = (await list.json()) as { jobs: { id: string; contactName: string | null }[] };
      expect(body.jobs.find((j) => j.id === jobId)?.contactName).toBe('Chen');
    } finally {
      await ctx.handle.close();
    }
  });

  // A job without a customer is still a perfectly good container, so the join
  // has to be a LEFT one — an inner join would drop the job entirely.
  it('still returns a job that has no customer', async () => {
    const ctx = await setup('job-no-contact@test.com');
    try {
      const jobId = await makeJob(ctx, 'Unnamed customer');

      const detail = await ctx.app.request(`/api/jobs/${jobId}`, { headers: ctx.headers });
      expect(detail.status).toBe(200);
      const job = (await detail.json()) as { contactName: string | null };
      expect(job.contactName).toBeNull();

      const list = await ctx.app.request(`/api/jobs?companyId=${ctx.companyId}`, {
        headers: ctx.headers,
      });
      const body = (await list.json()) as { jobs: { id: string }[] };
      expect(body.jobs.find((j) => j.id === jobId)).toBeDefined();
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('per-hour is null until there is something to divide', () => {
  beforeEach(resetDb);

  // Hours logged, nothing invoiced. "$0.00 per hour" would read as a verdict on
  // the work; the truth is the job simply hasn't been billed.
  it('is null when hours are logged but nothing is billed', async () => {
    const ctx = await setup('job-hourly-unbilled@test.com');
    try {
      const jobId = await makeJob(ctx, 'Not billed yet');
      await logTime(ctx, jobId, 60);

      const res = await ctx.app.request(`/api/jobs/${jobId}`, { headers: ctx.headers });
      const body = (await res.json()) as {
        margin: { billed: string; minutes: number; effectiveHourly: string | null };
      };
      expect(body.margin.minutes).toBe(60);
      expect(body.margin.billed).toBe('0.00');
      expect(body.margin.effectiveHourly).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  // Once billed, the number always shows — including a genuine zero. A job that
  // billed $100 and cost $100 really did pay $0/hr, and that is worth knowing.
  it('shows a real zero once the job has billed', async () => {
    const ctx = await setup('job-hourly-zero@test.com');
    try {
      const contactId = await makeContact(ctx, 'Smith');
      const jobId = await makeJob(ctx, 'Broke even', contactId);
      await makeInvoice(ctx, contactId, 'INV-1', '100.00', '2026-06-10', jobId);
      const cost = await makeExpense(ctx, '100.00');
      await allocate(ctx, cost, [{ jobId, share: '1' }]);
      await logTime(ctx, jobId, 120);

      const res = await ctx.app.request(`/api/jobs/${jobId}`, { headers: ctx.headers });
      const body = (await res.json()) as {
        margin: { made: string; effectiveHourly: string | null };
      };
      expect(body.margin.made).toBe('0.00');
      expect(body.margin.effectiveHourly).toBe('0.00');
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('a rejected billing leaves nothing behind', () => {
  beforeEach(resetDb);

  // The tenant transaction only rolls back on a THROWN error — a handler that
  // returns c.json({error}, 409) completes normally and COMMITS. So every check
  // that can fail has to run before the first write, or a rejected invoice ends
  // up on the books with hour lines while its entries stay unbilled, free to be
  // billed a second time.
  it('does not create the invoice when an entry is already billed', async () => {
    const ctx = await setup('bill-time-atomic@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Tuesdays at the Chens', contactId);
      const entryId = await logTime(ctx, jobId, 195, '22.0000');

      const first = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          companyId: ctx.companyId,
          contactId,
          jobId,
          number: 'INV-A',
          issueDate: '2026-06-12',
          dueDate: '2026-07-12',
          subtotal: '71.50',
          total: '71.50',
          billedTimeEntryIds: [entryId],
          lineItems: [
            {
              position: 1,
              description: 'Sitting',
              quantity: '3.2500',
              unitPrice: '22.0000',
              amount: '71.50',
              type: 'service',
            },
          ],
        }),
      });
      expect(first.status).toBe(201);

      // Second invoice tries to bill the same entry — must be refused AND must
      // not leave INV-B behind.
      const second = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          companyId: ctx.companyId,
          contactId,
          jobId,
          number: 'INV-B',
          issueDate: '2026-06-13',
          dueDate: '2026-07-13',
          subtotal: '71.50',
          total: '71.50',
          billedTimeEntryIds: [entryId],
          lineItems: [
            {
              position: 1,
              description: 'Sitting again',
              quantity: '3.2500',
              unitPrice: '22.0000',
              amount: '71.50',
              type: 'service',
            },
          ],
        }),
      });
      expect(second.status).toBe(409);
      expect(((await second.json()) as { error: string }).error).toBe('time_entry_already_billed');

      // INV-B must not exist. Before the read/write split it did — committed,
      // numbered, with its hour line, and the entry still attached to INV-A.
      const list = await ctx.app.request(`/api/invoices?companyId=${ctx.companyId}`, {
        headers: ctx.headers,
      });
      const body = (await list.json()) as { invoices: { number: string }[] };
      expect(body.invoices.map((i) => i.number)).not.toContain('INV-B');
      expect(body.invoices.filter((i) => i.number === 'INV-A')).toHaveLength(1);
    } finally {
      await ctx.handle.close();
    }
  });
});
