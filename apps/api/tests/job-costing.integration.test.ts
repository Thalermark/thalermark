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
        lineItems: [
          {
            position: 1,
            description: 'Sitting',
            timeEntryId: entryIds[0],
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
          lineItems: [
            {
              position: 1,
              description: 'Sitting',
              timeEntryId: entryId,
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
          lineItems: [
            {
              position: 1,
              description: 'Sitting',
              timeEntryId: entryId,
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

// TMC-203. The report's window was built from sent/paid invoices, and that list
// also decided which JOBS appeared — so a job whose only invoice was a draft
// fell out of the report entirely, taking its costs with it. Those costs were
// then in no bucket at all: not jobCosts, not shared, not unattributed.
// TMC-204. The per-invoice block on GET /api/invoices/:id had no notion of
// status: one $900 invoice with $340 of receipts reported "made $560" whether it
// was sent, drafted, or voided.
describe('the invoice job-costing block reads its own status', () => {
  beforeEach(resetDb);

  type JobCosting = { billed: string; drafted: string; costs: string; made: string | null };
  async function costingFor(ctx: Ctx, status: 'draft' | 'sent' | 'voided'): Promise<JobCosting> {
    const contactId = await makeContact(ctx, `Chen ${status}`);
    const res = await ctx.app.request('/api/invoices', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({
        companyId: ctx.companyId,
        contactId,
        number: `INV-${status}`,
        issueDate: '2026-06-10',
        dueDate: '2026-07-10',
        subtotal: '900.00',
        total: '900.00',
        lineItems: [
          {
            position: 1,
            description: 'Work',
            quantity: '1',
            unitPrice: '900.00',
            amount: '900.00',
            type: 'service',
          },
        ],
      }),
    });
    const invoiceId = ((await res.json()) as { id: string }).id;
    const cost = await makeExpense(ctx, '340.00');
    await allocate(ctx, cost, [{ invoiceId, share: '1' }]);
    if (status !== 'draft') {
      await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: ctx.headers,
      });
    }
    if (status === 'voided') {
      await ctx.app.request(`/api/invoices/${invoiceId}/void`, {
        method: 'POST',
        headers: ctx.headers,
      });
    }
    const detail = await ctx.app.request(`/api/invoices/${invoiceId}`, { headers: ctx.headers });
    return ((await detail.json()) as { jobCosting: JobCosting }).jobCosting;
  }

  it('states the margin on a sent invoice', async () => {
    const ctx = await setup('inv-costing-sent@test.com');
    try {
      const c = await costingFor(ctx, 'sent');
      expect(c.billed).toBe('900.00');
      expect(c.made).toBe('560.00');
      expect(c.drafted).toBe('0.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('states no margin on a draft, and reports the amount as drafted', async () => {
    const ctx = await setup('inv-costing-draft@test.com');
    try {
      const c = await costingFor(ctx, 'draft');
      // Was '900.00' — the subtotal counted as billed regardless of status.
      expect(c.billed).toBe('0.00');
      expect(c.drafted).toBe('900.00');
      expect(c.costs).toBe('340.00');
      expect(c.made).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('reports a voided invoice as the loss it is, never a profit', async () => {
    const ctx = await setup('inv-costing-voided@test.com');
    try {
      const c = await costingFor(ctx, 'voided');
      expect(c.billed).toBe('0.00');
      // Not pending — cancelled. Nothing is coming.
      expect(c.drafted).toBe('0.00');
      // Was '560.00': a profit reported on revenue that had been cancelled.
      expect(c.made).toBe('-340.00');
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('job-margin and work in progress', () => {
  beforeEach(resetDb);

  async function draftInvoice(ctx: Ctx, contactId: string, jobId: string, subtotal: string) {
    const res = await ctx.app.request('/api/invoices', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({
        companyId: ctx.companyId,
        contactId,
        jobId,
        number: `INV-D${Math.floor(Number(subtotal))}`,
        issueDate: '2026-06-10',
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
    if (res.status !== 201) throw new Error(`draft create failed: ${res.status}`);
    return ((await res.json()) as { id: string }).id;
  }

  type MarginReport = {
    jobs: { jobId: string; billed: string; drafted: string; costs: string; made: string | null }[];
    totals: {
      billed: string;
      drafted: string;
      jobCosts: string;
      workInProgress: string;
      made: string;
    };
  };
  async function report(ctx: Ctx): Promise<MarginReport> {
    const res = await ctx.app.request(
      `/api/companies/${ctx.companyId}/job-margin?from=2026-06-01&to=2026-06-30`,
      { headers: ctx.headers },
    );
    return (await res.json()) as MarginReport;
  }

  it('keeps a drafted-only job and its costs on the report', async () => {
    const ctx = await setup('margin-wip@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Drafted only', contactId);
      const cost = await makeExpense(ctx, '340.00');
      await allocate(ctx, cost, [{ jobId, share: '1' }]);
      await draftInvoice(ctx, contactId, jobId, '900.00');

      const body = await report(ctx);
      // The whole row used to be absent.
      const row = body.jobs.find((j) => j.jobId === jobId);
      expect(row).toBeDefined();
      expect(row?.billed).toBe('0.00');
      expect(row?.drafted).toBe('900.00');
      expect(row?.costs).toBe('340.00');
      // NOT '-340.00'. Nothing is recognised, so there is no margin to state.
      expect(row?.made).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('holds work-in-progress costs out of the bottom line, and says so', async () => {
    const ctx = await setup('margin-wip-totals@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      // A finished job: billed and costed, margin real.
      const doneJob = await makeJob(ctx, 'Finished', contactId);
      await makeInvoice(ctx, contactId, 'INV-S', '900.00', '2026-06-10', doneJob);
      const doneCost = await makeExpense(ctx, '340.00');
      await allocate(ctx, doneCost, [{ jobId: doneJob, share: '1' }]);

      // An in-progress job: costs spent, invoice written but not sent.
      const wipJob = await makeJob(ctx, 'In progress', contactId);
      const wipCost = await makeExpense(ctx, '200.00');
      await allocate(ctx, wipCost, [{ jobId: wipJob, share: '1' }]);
      await draftInvoice(ctx, contactId, wipJob, '700.00');

      const t = (await report(ctx)).totals;
      expect(t.billed).toBe('900.00');
      expect(t.drafted).toBe('700.00');
      // Every cost still shows in jobCosts — nothing is hidden.
      expect(t.jobCosts).toBe('540.00');
      expect(t.workInProgress).toBe('200.00');
      // …but only the finished job's costs reduce the bottom line. Before, the
      // total quietly subtracted the WIP $200 while its row showed no margin at
      // all, so the total contradicted the rows above it.
      expect(t.made).toBe('560.00');
      // The reconciliation the totals promise.
      expect(Number(t.billed) - (Number(t.jobCosts) - Number(t.workInProgress))).toBe(
        Number(t.made),
      );
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

// TMC-202. Hours on a DRAFT invoice were counted nowhere: stamped, so gone from
// readyToBill; unsent, so absent from billed. A job holding a real invoice for
// real work reported $0.00 across every tile.
//
// These assert the three-row table on the ticket — money waiting, money drafted,
// money billed — and that it moves between them without ever being counted
// twice or vanishing.
describe('money on an unsent invoice is reported, not lost', () => {
  beforeEach(resetDb);

  // Same as makeInvoice but stops before mark-sent, which is the whole point.
  async function makeDraftInvoice(
    ctx: Ctx,
    contactId: string,
    number: string,
    subtotal: string,
    jobId: string,
    timeEntryId?: string,
  ): Promise<string> {
    const res = await ctx.app.request('/api/invoices', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({
        companyId: ctx.companyId,
        contactId,
        jobId,
        number,
        issueDate: '2026-06-10',
        dueDate: '2026-07-10',
        subtotal,
        total: subtotal,
        lineItems: [
          {
            position: 1,
            description: 'Work',
            timeEntryId,
            quantity: '1',
            unitPrice: subtotal,
            amount: subtotal,
            type: 'service',
          },
        ],
      }),
    });
    if (res.status !== 201) throw new Error(`draft create failed: ${res.status}`);
    return ((await res.json()) as { id: string }).id;
  }

  type Margin = { billed: string; drafted: string; costs: string; made: string | null };
  async function margin(ctx: Ctx, jobId: string): Promise<Margin> {
    const res = await ctx.app.request(`/api/jobs/${jobId}`, { headers: ctx.headers });
    return ((await res.json()) as { margin: Margin }).margin;
  }
  async function readyToBill(ctx: Ctx, jobId: string): Promise<string> {
    // No `status` filter — the route accepts only 'open'/'closed' and 400s on
    // anything else, so "every job" is expressed by omitting it.
    const res = await ctx.app.request(`/api/jobs?companyId=${ctx.companyId}`, {
      headers: ctx.headers,
    });
    const body = (await res.json()) as { jobs: { id: string; readyToBill: string }[] };
    return body.jobs.find((j) => j.id === jobId)?.readyToBill ?? 'missing';
  }

  it('reports drafted money the moment it leaves ready-to-bill', async () => {
    const ctx = await setup('job-drafted@test.com');
    try {
      const contactId = await makeContact(ctx, 'Smith');
      const jobId = await makeJob(ctx, 'Drafted not sent', contactId);
      const entryId = await logTime(ctx, jobId, 120, '50.00');

      // Before: the hours are waiting, nothing is drafted or billed.
      expect(await readyToBill(ctx, jobId)).toBe('100.00');
      expect((await margin(ctx, jobId)).drafted).toBe('0.00');

      await makeDraftInvoice(ctx, contactId, 'INV-DRAFT', '100.00', jobId, entryId);

      // After: the money moved sideways into `drafted` rather than disappearing.
      // Every one of these was 0.00 before the fix, with a real $100 invoice on
      // the job — that is the bug, in one assertion block.
      const m = await margin(ctx, jobId);
      expect(m.drafted).toBe('100.00');
      expect(m.billed).toBe('0.00');
      // Null, not '0.00' — no revenue is recognised yet, so there is no margin
      // to state (TMC-203). With costs on the job this same expression used to
      // print their negative as a loss.
      expect(m.made).toBeNull();
      expect(await readyToBill(ctx, jobId)).toBe('0.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('moves the money to billed on send, counting it once at every step', async () => {
    const ctx = await setup('job-drafted-sent@test.com');
    try {
      const contactId = await makeContact(ctx, 'Smith');
      const jobId = await makeJob(ctx, 'Then sent', contactId);
      const entryId = await logTime(ctx, jobId, 120, '50.00');
      const invoiceId = await makeDraftInvoice(
        ctx,
        contactId,
        'INV-SEND',
        '100.00',
        jobId,
        entryId,
      );

      await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: ctx.headers,
      });

      const m = await margin(ctx, jobId);
      expect(m.billed).toBe('100.00');
      // The load-bearing half: drafted must EMPTY. If it kept the money the job
      // would read $200 of income from one $100 invoice.
      expect(m.drafted).toBe('0.00');
      expect(m.made).toBe('100.00');
      expect(await readyToBill(ctx, jobId)).toBe('0.00');
    } finally {
      await ctx.handle.close();
    }
  });

  // The allowlist that lets `drafted` exist can be widened by accident the same
  // way BILLED_INVOICE_STATUSES once was (TMC-183, 'void' vs 'voided'). A voided
  // invoice is not drafted money and must not reappear as any kind of income.
  it('does not count a voided invoice as drafted', async () => {
    const ctx = await setup('job-drafted-void@test.com');
    try {
      const contactId = await makeContact(ctx, 'Smith');
      const jobId = await makeJob(ctx, 'Voided', contactId);
      const invoiceId = await makeDraftInvoice(ctx, contactId, 'INV-VOID', '100.00', jobId);

      await ctx.app.request(`/api/invoices/${invoiceId}/void`, {
        method: 'POST',
        headers: ctx.headers,
      });

      const m = await margin(ctx, jobId);
      expect(m.drafted).toBe('0.00');
      expect(m.billed).toBe('0.00');
    } finally {
      await ctx.handle.close();
    }
  });

  // TMC-203. The costs of a job whose revenue is not yet recognised are WORK IN
  // PROGRESS, not a loss. Reporting them against $0.00 of revenue breaks the
  // matching principle and manufactures a loss that never happened.
  //
  // `effectiveHourly` already refuses to state a rate with nothing billed
  // (job-costing.ts: `billedCents <= 0` → null). `made` did not follow the same
  // rule, so it printed the negative of the costs.
  it('states no margin on a job whose revenue is not recognised yet', async () => {
    const ctx = await setup('job-drafted-wip@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Costs but no recognised revenue', contactId);
      const entryId = await logTime(ctx, jobId, 120, '50.00');
      const cost = await makeExpense(ctx, '340.00');
      await allocate(ctx, cost, [{ jobId, share: '1' }]);
      await makeDraftInvoice(ctx, contactId, 'INV-WIP', '900.00', jobId, entryId);

      const m = await margin(ctx, jobId);
      expect(m.costs).toBe('340.00');
      expect(m.drafted).toBe('900.00');
      // NOT '-340.00'. The job has not lost $340 — it has spent $340 on work it
      // has not billed for yet.
      expect(m.made).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  // TMC-204. Pending revenue and cancelled revenue both read billedCents === 0,
  // so a guard on that number alone cannot tell them apart. TMC-203 shipped
  // exactly such a guard and suppressed a loss that was real.
  it('states the loss once the revenue is cancelled, not withheld', async () => {
    const ctx = await setup('job-voided-loss@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Cancelled', contactId);
      const cost = await makeExpense(ctx, '340.00');
      await allocate(ctx, cost, [{ jobId, share: '1' }]);
      const invoiceId = await makeInvoice(ctx, contactId, 'INV-V', '900.00', '2026-06-10', jobId);

      expect((await margin(ctx, jobId)).made).toBe('560.00');

      await ctx.app.request(`/api/invoices/${invoiceId}/void`, {
        method: 'POST',
        headers: ctx.headers,
      });

      const m = await margin(ctx, jobId);
      expect(m.billed).toBe('0.00');
      expect(m.costs).toBe('340.00');
      // The money was spent and nobody will ever be billed for it. jobCostCents
      // says so directly: "voiding cancels the revenue, not the money already
      // spent... showing a loss is the correct answer, not a glitch."
      expect(m.made).toBe('-340.00');
    } finally {
      await ctx.handle.close();
    }
  });

  // The other side of the same coin: unbilled priced hours are revenue on the
  // way, so a job carrying them states no margin even with no invoice at all.
  it('withholds the margin while priced hours are still unbilled', async () => {
    const ctx = await setup('job-unbilled-pending@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Hours not billed', contactId);
      const cost = await makeExpense(ctx, '340.00');
      await allocate(ctx, cost, [{ jobId, share: '1' }]);
      await logTime(ctx, jobId, 120, '50.00');

      const m = await margin(ctx, jobId);
      expect(m.costs).toBe('340.00');
      expect(m.made).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('rolls drafted money up to the jobs summary', async () => {
    const ctx = await setup('job-drafted-summary@test.com');
    try {
      const contactId = await makeContact(ctx, 'Smith');
      const jobId = await makeJob(ctx, 'Summary', contactId);
      const entryId = await logTime(ctx, jobId, 120, '50.00');
      await makeDraftInvoice(ctx, contactId, 'INV-SUM', '100.00', jobId, entryId);

      const res = await ctx.app.request(`/api/jobs/summary?companyId=${ctx.companyId}`, {
        headers: ctx.headers,
      });
      const body = (await res.json()) as { readyToBill: string; drafted: string };
      // The headline read "$0.00 nothing waiting" with $100 drafted and unsent.
      expect(body.readyToBill).toBe('0.00');
      expect(body.drafted).toBe('100.00');
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
          lineItems: [
            {
              position: 1,
              description: 'Sitting',
              timeEntryId: entryId,
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
          lineItems: [
            {
              position: 1,
              description: 'Sitting again',
              timeEntryId: entryId,
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

describe('voiding an invoice releases its hours', () => {
  beforeEach(resetDb);

  // There is no invoice DELETE endpoint, so void is the ONLY way out of a wrong
  // invoice. Without releasing, the hours stay stamped to a voided invoice
  // forever: never listed as unbilled, never billable to a new one. The work
  // silently becomes unchargeable, and the only recovery path is the one that
  // strands it.
  it('returns the hours to unbilled so they can be billed again', async () => {
    const ctx = await setup('void-releases-hours@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Tuesdays at the Chens', contactId);
      const entryId = await logTime(ctx, jobId, 195, '22.0000');

      const created = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          companyId: ctx.companyId,
          contactId,
          jobId,
          number: 'INV-VOID',
          issueDate: '2026-06-12',
          dueDate: '2026-07-12',
          subtotal: '71.50',
          total: '71.50',
          lineItems: [
            {
              position: 1,
              description: 'Sitting',
              timeEntryId: entryId,
              quantity: '3.2500',
              unitPrice: '22.0000',
              amount: '71.50',
              type: 'service',
            },
          ],
        }),
      });
      expect(created.status).toBe(201);
      const invoiceId = ((await created.json()) as { id: string }).id;

      const unbilledBefore = await ctx.app.request(`/api/jobs/${jobId}/time?unbilled=true`, {
        headers: ctx.headers,
      });
      expect(
        ((await unbilledBefore.json()) as { timeEntries: unknown[] }).timeEntries,
      ).toHaveLength(0);

      const voided = await ctx.app.request(`/api/invoices/${invoiceId}/void`, {
        method: 'POST',
        headers: ctx.headers,
      });
      expect(voided.status).toBe(200);

      const unbilledAfter = await ctx.app.request(`/api/jobs/${jobId}/time?unbilled=true`, {
        headers: ctx.headers,
      });
      const body = (await unbilledAfter.json()) as {
        timeEntries: { id: string; minutes: number }[];
      };
      expect(body.timeEntries).toHaveLength(1);
      expect(body.timeEntries[0]?.id).toBe(entryId);
      // The work itself is untouched — only the claim on it was cancelled.
      expect(body.timeEntries[0]?.minutes).toBe(195);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('a draft can absorb hours logged after it was started', () => {
  beforeEach(resetDb);

  async function draftWithOneHour(ctx: Ctx, jobId: string, contactId: string, entryId: string) {
    const res = await ctx.app.request('/api/invoices', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({
        companyId: ctx.companyId,
        contactId,
        jobId,
        number: 'INV-DRAFT',
        issueDate: '2026-06-12',
        dueDate: '2026-07-12',
        subtotal: '15.00',
        total: '15.00',
        lineItems: [
          {
            position: 1,
            description: 'Sitting',
            timeEntryId: entryId,
            quantity: '1.0000',
            unitPrice: '15.0000',
            amount: '15.00',
            type: 'service',
          },
        ],
      }),
    });
    return ((await res.json()) as { id: string }).id;
  }

  it('adds hours logged after the draft existed, keeping the ones it had', async () => {
    const ctx = await setup('draft-absorbs-hours@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Tuesdays at the Chens', contactId);
      const first = await logTime(ctx, jobId, 60, '15.0000');
      const invoiceId = await draftWithOneHour(ctx, jobId, contactId, first);

      // More work happens after the draft exists.
      const second = await logTime(ctx, jobId, 180, '15.0000');

      const patched = await ctx.app.request(`/api/invoices/${invoiceId}`, {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({
          contactId,
          jobId,
          number: 'INV-DRAFT',
          issueDate: '2026-06-12',
          dueDate: '2026-07-12',
          subtotal: '60.00',
          total: '60.00',
          lineItems: [
            {
              position: 1,
              description: 'Sitting',
              timeEntryId: first,
              quantity: '1.0000',
              unitPrice: '15.0000',
              amount: '15.00',
              type: 'service',
            },
            {
              position: 2,
              description: 'More sitting',
              timeEntryId: second,
              quantity: '3.0000',
              unitPrice: '15.0000',
              amount: '45.00',
              type: 'service',
            },
          ],
        }),
      });
      expect(patched.status).toBe(200);

      const unbilled = await ctx.app.request(`/api/jobs/${jobId}/time?unbilled=true`, {
        headers: ctx.headers,
      });
      expect(((await unbilled.json()) as { timeEntries: unknown[] }).timeEntries).toHaveLength(0);
    } finally {
      await ctx.handle.close();
    }
  });

  // The bug the line-level link exists to fix. Before invoice_line_items
  // .time_entry_id there was no way back from a saved hour line to its entry, so
  // removing the line stranded the entry as billed forever: never listed as
  // unbilled, never billable again, the work silently unchargeable.
  it('returns the hours to unbilled when their line is removed', async () => {
    const ctx = await setup('draft-remove-line@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Tuesdays at the Chens', contactId);
      const entryId = await logTime(ctx, jobId, 60, '15.0000');
      const invoiceId = await draftWithOneHour(ctx, jobId, contactId, entryId);

      const before = await ctx.app.request(`/api/jobs/${jobId}/time?unbilled=true`, {
        headers: ctx.headers,
      });
      expect(((await before.json()) as { timeEntries: unknown[] }).timeEntries).toHaveLength(0);

      // Replace the hour line with an ordinary one — the hours are no longer
      // being charged for, so they must become billable again.
      const patched = await ctx.app.request(`/api/invoices/${invoiceId}`, {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({
          contactId,
          jobId,
          number: 'INV-DRAFT',
          issueDate: '2026-06-12',
          dueDate: '2026-07-12',
          subtotal: '20.00',
          total: '20.00',
          lineItems: [
            {
              position: 1,
              description: 'Callout fee',
              quantity: '1',
              unitPrice: '20.00',
              amount: '20.00',
              type: 'service',
            },
          ],
        }),
      });
      expect(patched.status).toBe(200);

      const after = await ctx.app.request(`/api/jobs/${jobId}/time?unbilled=true`, {
        headers: ctx.headers,
      });
      const body = (await after.json()) as { timeEntries: { id: string; minutes: number }[] };
      expect(body.timeEntries).toHaveLength(1);
      expect(body.timeEntries[0]?.id).toBe(entryId);
      // The work itself is untouched — only the claim on it was dropped.
      expect(body.timeEntries[0]?.minutes).toBe(60);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('ready to bill on the list and the report', () => {
  beforeEach(resetDb);

  it('reports what each job could invoice, and keeps it out of made', async () => {
    const ctx = await setup('ready-list-report@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Deck rebuild', contactId);
      await makeInvoice(ctx, contactId, 'INV-1', '400.00', '2026-06-05', jobId);

      // 3h at $25 = $75 waiting, plus 2h with no rate that bills nothing.
      await logTime(ctx, jobId, 180, '25.0000');
      await logTime(ctx, jobId, 120);

      const list = await ctx.app.request(`/api/jobs?companyId=${ctx.companyId}`, {
        headers: ctx.headers,
      });
      const listBody = (await list.json()) as {
        jobs: { id: string; readyToBill: string; unratedMinutes: number }[];
      };
      const row = listBody.jobs.find((j) => j.id === jobId);
      expect(row?.readyToBill).toBe('75.00');
      // Surfaced separately so $0.00 never reads as "nothing to bill" when the
      // truth is "nothing priced".
      expect(row?.unratedMinutes).toBe(120);

      const res = await ctx.app.request(
        `/api/companies/${ctx.companyId}/job-margin?from=2026-06-01&to=2026-06-30`,
        { headers: ctx.headers },
      );
      const body = (await res.json()) as {
        jobs: { jobId: string; readyToBill: string; made: string; unratedMinutes: number }[];
        totals: { made: string; readyToBill: string };
      };
      const job = body.jobs.find((j) => j.jobId === jobId);
      expect(job?.readyToBill).toBe('75.00');
      expect(job?.unratedMinutes).toBe(120);
      // Ready to bill is NOT profit. Made stays what the job has actually
      // earned; folding unbilled work in would inflate the bottom line with
      // money nobody has been invoiced for.
      expect(job?.made).toBe('400.00');
      expect(body.totals.made).toBe('400.00');
      expect(body.totals.readyToBill).toBe('75.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('drops to zero once the hours are billed', async () => {
    const ctx = await setup('ready-after-billing@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const jobId = await makeJob(ctx, 'Deck rebuild', contactId);
      const entryId = await logTime(ctx, jobId, 180, '25.0000');

      await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          companyId: ctx.companyId,
          contactId,
          jobId,
          number: 'INV-READY',
          issueDate: '2026-06-12',
          dueDate: '2026-07-12',
          subtotal: '75.00',
          total: '75.00',
          lineItems: [
            {
              position: 1,
              description: 'Work',
              timeEntryId: entryId,
              quantity: '3.0000',
              unitPrice: '25.0000',
              amount: '75.00',
              type: 'service',
            },
          ],
        }),
      });

      const list = await ctx.app.request(`/api/jobs?companyId=${ctx.companyId}`, {
        headers: ctx.headers,
      });
      const body = (await list.json()) as { jobs: { id: string; readyToBill: string }[] };
      expect(body.jobs.find((j) => j.id === jobId)?.readyToBill).toBe('0.00');
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('the running stopwatch', () => {
  beforeEach(resetDb);

  it('starts, reports itself, and hands back minutes on stop without logging', async () => {
    const ctx = await setup('timer-basic@test.com');
    try {
      const jobId = await makeJob(ctx, 'House 1');

      const started = await ctx.app.request(`/api/jobs/${jobId}/timer`, {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({ note: 'framing' }),
      });
      expect(started.status).toBe(201);

      const running = await ctx.app.request('/api/timer', { headers: ctx.headers });
      const body = (await running.json()) as {
        timer: { jobId: string; jobName: string; note: string | null } | null;
      };
      expect(body.timer?.jobId).toBe(jobId);
      expect(body.timer?.jobName).toBe('House 1');
      expect(body.timer?.note).toBe('framing');

      const stopped = await ctx.app.request(`/api/jobs/${jobId}/timer`, {
        method: 'DELETE',
        headers: ctx.headers,
      });
      expect(stopped.status).toBe(200);
      const result = (await stopped.json()) as { minutes: number; note: string | null };
      // Rounded up: a 30-second visit is a minute of work, and rounding to zero
      // would lose the entry entirely.
      expect(result.minutes).toBeGreaterThanOrEqual(1);
      expect(result.note).toBe('framing');

      // Stopping records NOTHING. The user still owes a note and a rate, and a
      // stopwatch that silently became a billable entry is the easiest way to
      // invoice someone for a drive home.
      const entries = await ctx.app.request(`/api/jobs/${jobId}/time`, { headers: ctx.headers });
      expect(((await entries.json()) as { timeEntries: unknown[] }).timeEntries).toHaveLength(0);

      const after = await ctx.app.request('/api/timer', { headers: ctx.headers });
      expect(((await after.json()) as { timer: unknown }).timer).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  // The rule that keeps the same minute from being billed to two customers.
  // Refused rather than auto-stopped: forgetting to stop at house 1, driving 25
  // minutes and starting at house 2 would otherwise log house 1 with the drive
  // inside it, silently.
  it('refuses a second timer and names the job holding it', async () => {
    const ctx = await setup('timer-one-at-a-time@test.com');
    try {
      const houseOne = await makeJob(ctx, 'House 1');
      const houseTwo = await makeJob(ctx, 'House 2');

      expect(
        (
          await ctx.app.request(`/api/jobs/${houseOne}/timer`, {
            method: 'POST',
            headers: ctx.headers,
          })
        ).status,
      ).toBe(201);

      const second = await ctx.app.request(`/api/jobs/${houseTwo}/timer`, {
        method: 'POST',
        headers: ctx.headers,
      });
      expect(second.status).toBe(409);
      const body = (await second.json()) as { error: string; jobId: string; jobName: string };
      expect(body.error).toBe('timer_already_running');
      // The name and id are the point — the user is at house 2 and the thing
      // blocking them is somewhere else.
      expect(body.jobName).toBe('House 1');
      expect(body.jobId).toBe(houseOne);

      // House 1 keeps running; the refusal changed nothing.
      const running = await ctx.app.request('/api/timer', { headers: ctx.headers });
      expect(((await running.json()) as { timer: { jobId: string } }).timer.jobId).toBe(houseOne);
    } finally {
      await ctx.handle.close();
    }
  });

  it('frees the person once the first timer stops', async () => {
    const ctx = await setup('timer-sequential@test.com');
    try {
      const houseOne = await makeJob(ctx, 'House 1');
      const houseTwo = await makeJob(ctx, 'House 2');

      await ctx.app.request(`/api/jobs/${houseOne}/timer`, {
        method: 'POST',
        headers: ctx.headers,
      });
      await ctx.app.request(`/api/jobs/${houseOne}/timer`, {
        method: 'DELETE',
        headers: ctx.headers,
      });

      const second = await ctx.app.request(`/api/jobs/${houseTwo}/timer`, {
        method: 'POST',
        headers: ctx.headers,
      });
      expect(second.status).toBe(201);
    } finally {
      await ctx.handle.close();
    }
  });

  it('404s stopping a timer that is not running', async () => {
    const ctx = await setup('timer-stop-none@test.com');
    try {
      const jobId = await makeJob(ctx, 'House 1');
      const res = await ctx.app.request(`/api/jobs/${jobId}/timer`, {
        method: 'DELETE',
        headers: ctx.headers,
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe('timer_not_running');
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('GET /api/jobs/summary', () => {
  beforeEach(resetDb);

  // Declared before /api/jobs/:id — Hono is first-match, so a regression in
  // route order would make this 404 as an invalid id rather than answering.
  it('is not captured as an id by the detail route', async () => {
    const ctx = await setup('jobs-summary-route@test.com');
    try {
      const res = await ctx.app.request(`/api/jobs/summary?companyId=${ctx.companyId}`, {
        headers: ctx.headers,
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as { total: number }).toHaveProperty('total');
    } finally {
      await ctx.handle.close();
    }
  });

  it('counts open and closed, and totals what is waiting', async () => {
    const ctx = await setup('jobs-summary@test.com');
    try {
      const contactId = await makeContact(ctx, 'Chen');
      const withMoney = await makeJob(ctx, 'Deck rebuild', contactId);
      const unpriced = await makeJob(ctx, 'Favour job');
      const closed = await makeJob(ctx, 'Done and dusted');

      await logTime(ctx, withMoney, 180, '25.0000'); // $75 waiting
      await logTime(ctx, unpriced, 120); // 2 h that cannot be billed
      await ctx.app.request(`/api/jobs/${closed}`, {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({ status: 'closed' }),
      });

      const res = await ctx.app.request(`/api/jobs/summary?companyId=${ctx.companyId}`, {
        headers: ctx.headers,
      });
      const body = (await res.json()) as {
        total: number;
        open: number;
        closed: number;
        readyToBill: string;
        jobsWithMoneyWaiting: number;
        unratedMinutes: number;
        unratedHours: string;
      };

      expect(body.total).toBe(3);
      expect(body.open).toBe(2);
      expect(body.closed).toBe(1);
      expect(body.readyToBill).toBe('75.00');
      // Only the job with priced hours counts as waiting.
      expect(body.jobsWithMoneyWaiting).toBe(1);
      // The blocked hours are surfaced separately — a job full of unpriced work
      // looks identical to one with nothing to bill unless it is called out.
      expect(body.unratedMinutes).toBe(120);
      expect(body.unratedHours).toBe('2.00');
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('closing a job with money still on it', () => {
  beforeEach(resetDb);

  // Closing drops a job out of the default list and takes its unbilled work with
  // it. Refused once, with the amount named, rather than done silently — losing
  // track of billable money is the failure worth an extra click.
  it('refuses the first attempt and says how much is waiting', async () => {
    const ctx = await setup('close-with-money@test.com');
    try {
      const jobId = await makeJob(ctx, 'Deck rebuild');
      await logTime(ctx, jobId, 180, '25.0000');

      const res = await ctx.app.request(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({ status: 'closed' }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; readyToBill: string };
      expect(body.error).toBe('job_has_unbilled_time');
      expect(body.readyToBill).toBe('75.00');

      // Still open — the refusal changed nothing.
      const detail = await ctx.app.request(`/api/jobs/${jobId}`, { headers: ctx.headers });
      expect(((await detail.json()) as { status: string }).status).toBe('open');
    } finally {
      await ctx.handle.close();
    }
  });

  it('closes when the caller confirms', async () => {
    const ctx = await setup('close-confirmed@test.com');
    try {
      const jobId = await makeJob(ctx, 'Deck rebuild');
      await logTime(ctx, jobId, 180, '25.0000');

      const res = await ctx.app.request(`/api/jobs/${jobId}?confirm=true`, {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({ status: 'closed' }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe('closed');
    } finally {
      await ctx.handle.close();
    }
  });

  // Nothing waiting, nothing to warn about — the guard must not become a nag.
  it('closes without ceremony when nothing is waiting', async () => {
    const ctx = await setup('close-clean@test.com');
    try {
      const jobId = await makeJob(ctx, 'Nothing owed');
      const res = await ctx.app.request(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({ status: 'closed' }),
      });
      expect(res.status).toBe(200);
    } finally {
      await ctx.handle.close();
    }
  });

  // Unrated hours cannot be billed, so they are not money waiting and must not
  // trigger the warning — otherwise every favour job nags on close.
  it('does not warn for hours that have no rate', async () => {
    const ctx = await setup('close-unrated@test.com');
    try {
      const jobId = await makeJob(ctx, 'Favour job');
      await logTime(ctx, jobId, 120);
      const res = await ctx.app.request(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({ status: 'closed' }),
      });
      expect(res.status).toBe(200);
    } finally {
      await ctx.handle.close();
    }
  });

  it('breaks out money parked on closed jobs in the summary', async () => {
    const ctx = await setup('summary-closed-money@test.com');
    try {
      const openJob = await makeJob(ctx, 'Still going');
      const closedJob = await makeJob(ctx, 'Filed away');
      await logTime(ctx, openJob, 60, '20.0000'); // $20 reachable
      await logTime(ctx, closedJob, 60, '30.0000'); // $30 parked
      await ctx.app.request(`/api/jobs/${closedJob}?confirm=true`, {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({ status: 'closed' }),
      });

      const res = await ctx.app.request(`/api/jobs/summary?companyId=${ctx.companyId}`, {
        headers: ctx.headers,
      });
      const body = (await res.json()) as { readyToBill: string; readyToBillOnClosed: string };
      expect(body.readyToBill).toBe('50.00');
      // Without this split the headline reads $50 while the default list adds to
      // $20, and the difference looks like a bug rather than money parked.
      expect(body.readyToBillOnClosed).toBe('30.00');
    } finally {
      await ctx.handle.close();
    }
  });
});

// TMC-264 / TMC-265. The job says how it bills, and an entry can be typed as a
// clock span. Both land on the same three columns, so they are exercised
// together.
describe('a job bills in its own unit', () => {
  beforeEach(resetDb);

  async function createJobWithUnit(ctx: Ctx, name: string, billingUnit: string): Promise<string> {
    const res = await ctx.app.request('/api/jobs', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({ companyId: ctx.companyId, name, billingUnit }),
    });
    if (res.status !== 201) throw new Error(`job create failed: ${res.status}`);
    return ((await res.json()) as { id: string }).id;
  }

  async function postTime(ctx: Ctx, jobId: string, json: Record<string, unknown>) {
    return ctx.app.request(`/api/jobs/${jobId}/time`, {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({ entryDate: '2026-06-11', ...json }),
    });
  }

  it('defaults to hours, so every job written before this is untouched', async () => {
    const ctx = await setup('unit-default@test.com');
    try {
      const jobId = await makeJob(ctx, 'Fence repair');
      const res = await ctx.app.request(`/api/jobs/${jobId}/time`, { headers: ctx.headers });
      expect(((await res.json()) as { billingUnit: string }).billingUnit).toBe('hour');
    } finally {
      await ctx.handle.close();
    }
  });

  // The defect the whole ticket exists to prevent. Three 30-minute visits are
  // minutes=90; a quantity derived from minutes would bill "1.5 visits".
  it('bills the count, not the derived hours, on a per-visit job', async () => {
    const ctx = await setup('unit-visit@test.com');
    try {
      const jobId = await createJobWithUnit(ctx, 'Sadie walks', 'visit');
      const res = await postTime(ctx, jobId, { minutes: 90, quantity: '3.0000', rate: '20.0000' });
      expect(res.status).toBe(201);

      const listed = await ctx.app.request(`/api/jobs/${jobId}/time`, { headers: ctx.headers });
      const body = (await listed.json()) as {
        billingUnit: string;
        timeEntries: { minutes: number | null; quantity: string | null }[];
      };
      expect(body.billingUnit).toBe('visit');
      // BOTH are stored. The unit decides which one reaches the invoice, so
      // changing the job's unit later must not need the work re-entered.
      expect(body.timeEntries[0]?.quantity).toBe('3.0000');
      expect(body.timeEntries[0]?.minutes).toBe(90);
    } finally {
      await ctx.handle.close();
    }
  });

  it('takes a per-visit entry with no duration at all', async () => {
    const ctx = await setup('unit-no-duration@test.com');
    try {
      const jobId = await createJobWithUnit(ctx, 'Overnight stays', 'night');
      const res = await postTime(ctx, jobId, { quantity: '1.0000', rate: '75.0000' });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { minutes: number | null }).minutes).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('names the unit when the count is missing on a non-hourly job', async () => {
    const ctx = await setup('unit-missing-count@test.com');
    try {
      const jobId = await createJobWithUnit(ctx, 'Sadie walks', 'visit');
      const res = await postTime(ctx, jobId, { minutes: 90 });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { issues: { message: string }[] };
      // Plain English, not a raw code — TMC-219 / TMC-220.
      expect(body.issues[0]?.message).toBe('Enter how many visits you did.');
    } finally {
      await ctx.handle.close();
    }
  });

  it('still requires a duration on an hourly job', async () => {
    const ctx = await setup('unit-missing-hours@test.com');
    try {
      const jobId = await makeJob(ctx, 'Fence repair');
      const res = await postTime(ctx, jobId, { quantity: '3.0000' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { issues: { message: string }[] };
      expect(body.issues[0]?.message).toBe('Enter how long it took.');
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects an entry recording neither, whatever the unit', async () => {
    const ctx = await setup('unit-empty@test.com');
    try {
      const jobId = await makeJob(ctx, 'Fence repair');
      expect((await postTime(ctx, jobId, {})).status).toBe(400);
    } finally {
      await ctx.handle.close();
    }
  });

  // "Ready to bill" has to be priced the way the invoice will be priced, or the
  // two disagree at the moment money is involved.
  it('prices ready-to-bill in the job’s unit', async () => {
    const ctx = await setup('unit-ready@test.com');
    try {
      const jobId = await createJobWithUnit(ctx, 'Sadie walks', 'visit');
      await postTime(ctx, jobId, { minutes: 90, quantity: '3.0000', rate: '20.0000' });
      const res = await ctx.app.request(`/api/jobs?companyId=${ctx.companyId}`, {
        headers: ctx.headers,
      });
      const body = (await res.json()) as { jobs: { id: string; readyToBill: string }[] };
      // 3 visits x $20, NOT 1.5 hours x $20.
      expect(body.jobs.find((j) => j.id === jobId)?.readyToBill).toBe('60.00');
    } finally {
      await ctx.handle.close();
    }
  });

  // The revision that matters most: one job, two units. A sitter charges a flat
  // rate for a drop-in visit AND an hourly rate when she stays the afternoon,
  // for the same customer on the same job.
  it('bills two lines of one job in different units', async () => {
    const ctx = await setup('unit-mixed@test.com');
    try {
      const jobId = await createJobWithUnit(ctx, 'Sadie', 'visit');
      // Inherits the job: a drop-in, half an hour of it, billed as one visit.
      await postTime(ctx, jobId, { minutes: 30, quantity: '1.0000', rate: '25.0000' });
      // Overrides it: an afternoon, billed by the hour.
      await postTime(ctx, jobId, { minutes: 195, unit: 'hour', rate: '20.0000' });

      const res = await ctx.app.request(`/api/jobs?companyId=${ctx.companyId}`, {
        headers: ctx.headers,
      });
      const body = (await res.json()) as { jobs: { id: string; readyToBill: string }[] };
      // 1 visit x $25 = 25.00, plus 3.25 hours x $20 = 65.00. Pricing the second
      // line as a visit, or the first as hours, gives neither figure.
      expect(body.jobs.find((j) => j.id === jobId)?.readyToBill).toBe('90.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('stores an override but leaves an inherited unit null', async () => {
    const ctx = await setup('unit-inherit@test.com');
    try {
      const jobId = await createJobWithUnit(ctx, 'Sadie', 'visit');
      await postTime(ctx, jobId, { quantity: '1.0000', rate: '25.0000' });
      await postTime(ctx, jobId, { minutes: 60, unit: 'hour', rate: '20.0000' });

      const listed = await ctx.app.request(`/api/jobs/${jobId}/time`, { headers: ctx.headers });
      const rows = (await listed.json()) as { timeEntries: { unit: string | null }[] };
      const units = rows.timeEntries.map((r) => r.unit).sort();
      // Null for the line that agreed with the job, so changing the job's
      // default later still moves it; explicit only for the exception.
      expect(units).toEqual(['hour', null]);
    } finally {
      await ctx.handle.close();
    }
  });

  it('names the LINE\u2019s unit when its count is missing', async () => {
    const ctx = await setup('unit-line-missing@test.com');
    try {
      // Hourly job, but this line claims to be per-night and brings no count.
      const jobId = await makeJob(ctx, 'Fence repair');
      const res = await postTime(ctx, jobId, { minutes: 60, unit: 'night' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { issues: { message: string }[] };
      expect(body.issues[0]?.message).toBe('Enter how many nights you did.');
    } finally {
      await ctx.handle.close();
    }
  });

  // TMC-265. The clock times are kept, not discarded after computing minutes,
  // because when the work happened matters on the customer's invoice.
  it('stores the clock times a time card was typed as', async () => {
    const ctx = await setup('unit-timecard@test.com');
    try {
      const jobId = await makeJob(ctx, 'Overnight care');
      const res = await postTime(ctx, jobId, {
        minutes: 480,
        startTime: '22:00',
        endTime: '06:00',
        rate: '18.0000',
      });
      expect(res.status).toBe(201);
      const entry = (await res.json()) as { startTime: string; endTime: string; minutes: number };
      // The create response echoes what was sent; the stored `time` column reads
      // back with seconds. Both are asserted because the clients see both, and
      // formatClockTime accepts either shape for exactly this reason.
      expect(entry.startTime).toBe('22:00');
      // ONE entry for an overnight shift, dated by its start (owner decision).
      expect(entry.minutes).toBe(480);

      const listed = await ctx.app.request(`/api/jobs/${jobId}/time`, { headers: ctx.headers });
      const rows = (await listed.json()) as {
        timeEntries: { startTime: string; endTime: string }[];
      };
      expect(rows.timeEntries[0]?.startTime).toBe('22:00:00');
      expect(rows.timeEntries[0]?.endTime).toBe('06:00:00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('refuses a start with no end', async () => {
    const ctx = await setup('unit-halfcard@test.com');
    try {
      const jobId = await makeJob(ctx, 'Overnight care');
      const res = await postTime(ctx, jobId, { minutes: 60, startTime: '22:00' });
      expect(res.status).toBe(400);
    } finally {
      await ctx.handle.close();
    }
  });
});
