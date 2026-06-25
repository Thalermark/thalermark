import {
  auditEvents,
  authUser,
  companies,
  memberships,
  recurringInvoiceLineItems,
  recurringInvoices,
} from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

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

async function signUp(app: ReturnType<typeof createApp>, email: string) {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return extractSessionCookie(res);
}

async function userContext(email: string): Promise<{
  userId: string;
  accountId: string;
  companyId: string;
}> {
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
  if (!company) throw new Error(`default company for ${email} not seeded`);
  return { userId: user.id, accountId: m.accountId, companyId: company.id };
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
    emailFrom: 'Thalermark <test@thalermark.test>',
  });
  return { app, handle };
}

type CtxApp = { app: ReturnType<typeof createApp>; handle: { close: () => Promise<void> } };

async function createContact(
  { app }: CtxApp,
  cookie: string,
  accountId: string,
  companyId: string,
  name = 'Acme Corp',
): Promise<string> {
  const res = await app.request('/api/contacts', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify({ companyId, name }),
  });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

function recurringBody(
  companyId: string,
  contactId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    companyId,
    contactId,
    frequency: 'monthly',
    intervalCount: 1,
    startDate: '2026-06-01',
    netTermsDays: 30,
    subtotal: '100.00',
    tax: '8.25',
    total: '108.25',
    lineItems: [
      {
        position: 1,
        description: 'Monthly retainer',
        quantity: '1',
        unitPrice: '100.00',
        amount: '100.00',
      },
    ],
    ...overrides,
  };
}

function headers(cookie: string, accountId: string) {
  return { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };
}

async function createSchedule(
  ctx: CtxApp,
  cookie: string,
  accountId: string,
  companyId: string,
  contactId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await ctx.app.request('/api/recurring-invoices', {
    method: 'POST',
    headers: headers(cookie, accountId),
    body: JSON.stringify(recurringBody(companyId, contactId, overrides)),
  });
  if (res.status !== 201) throw new Error(`schedule create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

describe('POST /api/recurring-invoices', () => {
  beforeEach(resetDb);

  it('creates a schedule + line items, seeds next_run_date, writes audit', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'rec-create@example.com');
      const { accountId, companyId } = await userContext('rec-create@example.com');
      const contactId = await createContact(ctx, cookie, accountId, companyId);

      const res = await ctx.app.request('/api/recurring-invoices', {
        method: 'POST',
        headers: headers(cookie, accountId),
        body: JSON.stringify(
          recurringBody(companyId, contactId, { endDate: '2026-12-01', maxOccurrences: 6 }),
        ),
      });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };

      const db = getTestDb();
      const [row] = await db.select().from(recurringInvoices).where(eq(recurringInvoices.id, id));
      expect(row?.frequency).toBe('monthly');
      expect(row?.intervalCount).toBe(1);
      expect(row?.status).toBe('active');
      expect(row?.startDate).toBe('2026-06-01');
      expect(row?.nextRunDate).toBe('2026-06-01');
      expect(row?.endDate).toBe('2026-12-01');
      expect(row?.maxOccurrences).toBe(6);
      expect(row?.occurrenceCount).toBe(0);
      expect(row?.total).toBe('108.25');

      const lines = await db
        .select()
        .from(recurringInvoiceLineItems)
        .where(eq(recurringInvoiceLineItems.recurringInvoiceId, id));
      expect(lines).toHaveLength(1);
      expect(lines[0]?.amount).toBe('100.00');

      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.entityType).toBe('recurring_invoice');
      expect(audits[0]?.action).toBe('create');
    } finally {
      await ctx.handle.close();
    }
  });

  it('defaults net terms (30), currency (USD), and end conditions when omitted', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'rec-defaults@example.com');
      const { accountId, companyId } = await userContext('rec-defaults@example.com');
      const contactId = await createContact(ctx, cookie, accountId, companyId);
      const id = await createSchedule(ctx, cookie, accountId, companyId, contactId);

      const [row] = await getTestDb()
        .select()
        .from(recurringInvoices)
        .where(eq(recurringInvoices.id, id));
      expect(row?.netTermsDays).toBe(30);
      expect(row?.currency).toBe('USD');
      expect(row?.endDate).toBeNull();
      expect(row?.maxOccurrences).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects an out-of-enum frequency with 400', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'rec-badfreq@example.com');
      const { accountId, companyId } = await userContext('rec-badfreq@example.com');
      const contactId = await createContact(ctx, cookie, accountId, companyId);

      const res = await ctx.app.request('/api/recurring-invoices', {
        method: 'POST',
        headers: headers(cookie, accountId),
        body: JSON.stringify(recurringBody(companyId, contactId, { frequency: 'fortnightly' })),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a contactId from a different account with 404', async () => {
    const ctx = buildApp();
    try {
      const aCookie = await signUp(ctx.app, 'rec-a@example.com');
      const aCtx = await userContext('rec-a@example.com');
      const aCustId = await createContact(ctx, aCookie, aCtx.accountId, aCtx.companyId);

      const bCookie = await signUp(ctx.app, 'rec-b@example.com');
      const bCtx = await userContext('rec-b@example.com');

      const res = await ctx.app.request('/api/recurring-invoices', {
        method: 'POST',
        headers: headers(bCookie, bCtx.accountId),
        body: JSON.stringify(recurringBody(bCtx.companyId, aCustId)),
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe('contact_not_found');
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('GET /api/recurring-invoices', () => {
  beforeEach(resetDb);

  it('lists own schedules and filters by status; does not leak across accounts', async () => {
    const ctx = buildApp();
    try {
      const aCookie = await signUp(ctx.app, 'rec-list-a@example.com');
      const aCtx = await userContext('rec-list-a@example.com');
      const aCust = await createContact(ctx, aCookie, aCtx.accountId, aCtx.companyId);
      const active = await createSchedule(ctx, aCookie, aCtx.accountId, aCtx.companyId, aCust);
      const paused = await createSchedule(ctx, aCookie, aCtx.accountId, aCtx.companyId, aCust);
      await ctx.app.request(`/api/recurring-invoices/${paused}/pause`, {
        method: 'POST',
        headers: headers(aCookie, aCtx.accountId),
      });

      const bCookie = await signUp(ctx.app, 'rec-list-b@example.com');
      const bCtx = await userContext('rec-list-b@example.com');
      const bCust = await createContact(ctx, bCookie, bCtx.accountId, bCtx.companyId);
      await createSchedule(ctx, bCookie, bCtx.accountId, bCtx.companyId, bCust);

      const all = await ctx.app.request('/api/recurring-invoices', {
        headers: headers(aCookie, aCtx.accountId),
      });
      const allBody = (await all.json()) as { recurringInvoices: { id: string }[] };
      expect(allBody.recurringInvoices.map((r) => r.id).sort()).toEqual([active, paused].sort());

      const activeOnly = await ctx.app.request('/api/recurring-invoices?status=active', {
        headers: headers(aCookie, aCtx.accountId),
      });
      const activeBody = (await activeOnly.json()) as { recurringInvoices: { id: string }[] };
      expect(activeBody.recurringInvoices.map((r) => r.id)).toEqual([active]);
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns header + line items + generatedInvoices (empty before any run)', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'rec-get@example.com');
      const { accountId, companyId } = await userContext('rec-get@example.com');
      const contactId = await createContact(ctx, cookie, accountId, companyId);
      const id = await createSchedule(ctx, cookie, accountId, companyId, contactId);

      const res = await ctx.app.request(`/api/recurring-invoices/${id}`, {
        headers: headers(cookie, accountId),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        id: string;
        lineItems: unknown[];
        generatedInvoices: unknown[];
      };
      expect(body.id).toBe(id);
      expect(body.lineItems).toHaveLength(1);
      expect(body.generatedInvoices).toEqual([]);
    } finally {
      await ctx.handle.close();
    }
  });

  it('does not leak a foreign-account schedule (404)', async () => {
    const ctx = buildApp();
    try {
      const aCookie = await signUp(ctx.app, 'rec-leak-a@example.com');
      const aCtx = await userContext('rec-leak-a@example.com');
      const aCust = await createContact(ctx, aCookie, aCtx.accountId, aCtx.companyId);
      const id = await createSchedule(ctx, aCookie, aCtx.accountId, aCtx.companyId, aCust);

      const bCookie = await signUp(ctx.app, 'rec-leak-b@example.com');
      const bCtx = await userContext('rec-leak-b@example.com');

      const res = await ctx.app.request(`/api/recurring-invoices/${id}`, {
        headers: headers(bCookie, bCtx.accountId),
      });
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('PATCH /api/recurring-invoices/:id', () => {
  beforeEach(resetDb);

  it('replaces line items + cadence and re-pins next_run_date before first run', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'rec-patch@example.com');
      const { accountId, companyId } = await userContext('rec-patch@example.com');
      const contactId = await createContact(ctx, cookie, accountId, companyId);
      const id = await createSchedule(ctx, cookie, accountId, companyId, contactId);

      const update = recurringBody(companyId, contactId, {
        frequency: 'weekly',
        intervalCount: 2,
        startDate: '2026-07-01',
        subtotal: '200.00',
        tax: '0',
        total: '200.00',
        lineItems: [
          {
            position: 1,
            description: 'Biweekly service',
            quantity: '2',
            unitPrice: '100.00',
            amount: '200.00',
          },
        ],
      });
      const { companyId: _omit, ...patchBody } = update;
      const res = await ctx.app.request(`/api/recurring-invoices/${id}`, {
        method: 'PATCH',
        headers: headers(cookie, accountId),
        body: JSON.stringify(patchBody),
      });
      expect(res.status).toBe(200);

      const db = getTestDb();
      const [row] = await db.select().from(recurringInvoices).where(eq(recurringInvoices.id, id));
      expect(row?.frequency).toBe('weekly');
      expect(row?.intervalCount).toBe(2);
      expect(row?.startDate).toBe('2026-07-01');
      // occurrence_count is 0 → next_run_date follows the new start date.
      expect(row?.nextRunDate).toBe('2026-07-01');
      expect(row?.total).toBe('200.00');

      const lines = await db
        .select()
        .from(recurringInvoiceLineItems)
        .where(eq(recurringInvoiceLineItems.recurringInvoiceId, id));
      expect(lines).toHaveLength(1);
      expect(lines[0]?.description).toBe('Biweekly service');
    } finally {
      await ctx.handle.close();
    }
  });

  it('refuses to edit an ended schedule (409 not_editable)', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'rec-patch-ended@example.com');
      const { accountId, companyId } = await userContext('rec-patch-ended@example.com');
      const contactId = await createContact(ctx, cookie, accountId, companyId);
      const id = await createSchedule(ctx, cookie, accountId, companyId, contactId);
      await ctx.app.request(`/api/recurring-invoices/${id}/end`, {
        method: 'POST',
        headers: headers(cookie, accountId),
      });

      const { companyId: _omit, ...patchBody } = recurringBody(companyId, contactId);
      const res = await ctx.app.request(`/api/recurring-invoices/${id}`, {
        method: 'PATCH',
        headers: headers(cookie, accountId),
        body: JSON.stringify(patchBody),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('not_editable');
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('recurring schedule transitions (pause / resume / end)', () => {
  beforeEach(resetDb);

  it('pauses then resumes, writing audit rows for each', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'rec-trans@example.com');
      const { accountId, companyId } = await userContext('rec-trans@example.com');
      const contactId = await createContact(ctx, cookie, accountId, companyId);
      const id = await createSchedule(ctx, cookie, accountId, companyId, contactId);

      const pause = await ctx.app.request(`/api/recurring-invoices/${id}/pause`, {
        method: 'POST',
        headers: headers(cookie, accountId),
      });
      expect(pause.status).toBe(200);
      expect(((await pause.json()) as { status: string }).status).toBe('paused');

      const resume = await ctx.app.request(`/api/recurring-invoices/${id}/resume`, {
        method: 'POST',
        headers: headers(cookie, accountId),
      });
      expect(resume.status).toBe(200);
      expect(((await resume.json()) as { status: string }).status).toBe('active');

      const audits = await getTestDb()
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, id));
      const actions = audits.map((a) => a.action).sort();
      expect(actions).toEqual(['create', 'pause', 'resume'].sort());
    } finally {
      await ctx.handle.close();
    }
  });

  it('resume pulls a past next_run_date forward to today', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'rec-resume-bump@example.com');
      const { accountId, companyId } = await userContext('rec-resume-bump@example.com');
      const contactId = await createContact(ctx, cookie, accountId, companyId);
      // A long-past start date → next_run_date is in the past.
      const id = await createSchedule(ctx, cookie, accountId, companyId, contactId, {
        startDate: '2020-01-01',
      });
      await ctx.app.request(`/api/recurring-invoices/${id}/pause`, {
        method: 'POST',
        headers: headers(cookie, accountId),
      });
      await ctx.app.request(`/api/recurring-invoices/${id}/resume`, {
        method: 'POST',
        headers: headers(cookie, accountId),
      });

      const [row] = await getTestDb()
        .select()
        .from(recurringInvoices)
        .where(eq(recurringInvoices.id, id));
      expect(row?.nextRunDate).toBe(new Date().toISOString().slice(0, 10));
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects an invalid transition (resume while active) with 409', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'rec-badtrans@example.com');
      const { accountId, companyId } = await userContext('rec-badtrans@example.com');
      const contactId = await createContact(ctx, cookie, accountId, companyId);
      const id = await createSchedule(ctx, cookie, accountId, companyId, contactId);

      const res = await ctx.app.request(`/api/recurring-invoices/${id}/resume`, {
        method: 'POST',
        headers: headers(cookie, accountId),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_transition');
    } finally {
      await ctx.handle.close();
    }
  });

  it('end is terminal — a second end returns 409', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'rec-end@example.com');
      const { accountId, companyId } = await userContext('rec-end@example.com');
      const contactId = await createContact(ctx, cookie, accountId, companyId);
      const id = await createSchedule(ctx, cookie, accountId, companyId, contactId);

      const first = await ctx.app.request(`/api/recurring-invoices/${id}/end`, {
        method: 'POST',
        headers: headers(cookie, accountId),
      });
      expect(first.status).toBe(200);
      expect(((await first.json()) as { status: string }).status).toBe('ended');

      const second = await ctx.app.request(`/api/recurring-invoices/${id}/end`, {
        method: 'POST',
        headers: headers(cookie, accountId),
      });
      expect(second.status).toBe(409);
    } finally {
      await ctx.handle.close();
    }
  });

  it('does not transition a foreign-account schedule (404)', async () => {
    const ctx = buildApp();
    try {
      const aCookie = await signUp(ctx.app, 'rec-trans-a@example.com');
      const aCtx = await userContext('rec-trans-a@example.com');
      const aCust = await createContact(ctx, aCookie, aCtx.accountId, aCtx.companyId);
      const id = await createSchedule(ctx, aCookie, aCtx.accountId, aCtx.companyId, aCust);

      const bCookie = await signUp(ctx.app, 'rec-trans-b@example.com');
      const bCtx = await userContext('rec-trans-b@example.com');

      const res = await ctx.app.request(`/api/recurring-invoices/${id}/pause`, {
        method: 'POST',
        headers: headers(bCookie, bCtx.accountId),
      });
      expect(res.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});
