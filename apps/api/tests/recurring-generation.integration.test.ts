import {
  auditEvents,
  authUser,
  companies,
  invoiceLineItems,
  invoices,
  journalEntries,
  memberships,
  recurringInvoices,
} from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import type { Mailer } from '../src/lib/mailer.js';
import { advanceDate, sweepRecurringInvoices } from '../src/lib/recurring.js';
import { getTestDb, resetDb } from './test-helper.js';

// --- advanceDate unit tests (no DB) ---------------------------------------

describe('advanceDate', () => {
  it('weekly steps by 7 * interval days', () => {
    expect(advanceDate('2026-06-01', 'weekly', 1)).toBe('2026-06-08');
    expect(advanceDate('2026-06-01', 'weekly', 2)).toBe('2026-06-15');
    expect(advanceDate('2026-12-29', 'weekly', 1)).toBe('2027-01-05');
  });

  it('monthly steps by interval months and rolls the year over', () => {
    expect(advanceDate('2026-06-01', 'monthly', 1)).toBe('2026-07-01');
    expect(advanceDate('2026-06-01', 'monthly', 3)).toBe('2026-09-01');
    expect(advanceDate('2026-12-15', 'monthly', 1)).toBe('2027-01-15');
  });

  it('monthly clamps the day to the last day of a shorter target month', () => {
    expect(advanceDate('2026-01-31', 'monthly', 1)).toBe('2026-02-28');
    expect(advanceDate('2026-03-31', 'monthly', 1)).toBe('2026-04-30');
    // Leap February.
    expect(advanceDate('2028-01-31', 'monthly', 1)).toBe('2028-02-29');
  });

  it('yearly steps by interval years and clamps Feb 29', () => {
    expect(advanceDate('2026-06-01', 'yearly', 1)).toBe('2027-06-01');
    expect(advanceDate('2024-02-29', 'yearly', 1)).toBe('2025-02-28');
    expect(advanceDate('2024-02-29', 'yearly', 4)).toBe('2028-02-29');
  });
});

// --- generation / sweep integration ---------------------------------------

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

type SentMail = { to: string; subject: string };
function stubMailer(): Mailer & { sent: SentMail[] } {
  const sent: SentMail[] = [];
  return {
    sent,
    async send(msg) {
      sent.push({ to: msg.to, subject: msg.subject });
    },
  };
}

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

async function userContext(email: string): Promise<{ accountId: string; companyId: string }> {
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

function buildApp(mailer?: Mailer) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(url);
  const auth = createApiAuth(handle.db, { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    publicAppUrl: testEnv.publicAppUrl,
    emailFrom: testEnv.emailFrom,
    mailer,
  });
  return { app, handle };
}

type Ctx = {
  app: ReturnType<typeof createApp>;
  handle: { db: ReturnType<typeof createApiDatabase>['db']; close: () => Promise<void> };
};

async function createCustomer(
  ctx: Ctx,
  cookie: string,
  accountId: string,
  companyId: string,
  email?: string,
): Promise<string> {
  const body: Record<string, string> = { companyId, name: 'Acme Corp' };
  if (email) body.email = email;
  const res = await ctx.app.request('/api/customers', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function createSchedule(
  ctx: Ctx,
  cookie: string,
  accountId: string,
  companyId: string,
  customerId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await ctx.app.request('/api/recurring-invoices', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify({
      companyId,
      customerId,
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
    }),
  });
  if (res.status !== 201)
    throw new Error(`schedule create failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

// Force a schedule due now by backdating next_run_date directly (the create
// path always seeds it from start_date, which is fixed in the fixture).
async function makeDue(id: string, dateIso = todayIso()) {
  await getTestDb()
    .update(recurringInvoices)
    .set({ nextRunDate: dateIso })
    .where(eq(recurringInvoices.id, id));
}

function sweep(ctx: Ctx, mailer?: Mailer) {
  return sweepRecurringInvoices({
    bootstrapDb: ctx.handle.db,
    tenantDb: ctx.handle.db,
    mail: { mailer, emailFrom: testEnv.emailFrom, publicAppUrl: testEnv.publicAppUrl },
  });
}

describe('sweepRecurringInvoices', () => {
  beforeEach(resetDb);

  it('generates a sent invoice from a due schedule: clones lines, posts ledger, emails, advances', async () => {
    const mailer = stubMailer();
    const ctx = buildApp(mailer);
    try {
      const cookie = await signUp(ctx.app, 'gen@example.com');
      const { accountId, companyId } = await userContext('gen@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId, 'pay@example.com');
      const id = await createSchedule(ctx, cookie, accountId, companyId, customerId);
      const dueOn = todayIso();
      await makeDue(id, dueOn);

      const result = await sweep(ctx, mailer);
      expect(result).toEqual({ due: 1, generated: 1, failed: 0 });

      const db = getTestDb();
      const [inv] = await db.select().from(invoices).where(eq(invoices.recurringInvoiceId, id));
      expect(inv?.status).toBe('sent');
      expect(inv?.number).toBe('INV-0001');
      expect(inv?.total).toBe('108.25');
      expect(inv?.issueDate).toBe(todayIso());
      expect(inv?.sentAt).toBeInstanceOf(Date);
      expect(inv?.publicToken).toBeTruthy();

      const lines = await db
        .select()
        .from(invoiceLineItems)
        // biome-ignore lint/style/noNonNullAssertion: invoice asserted above
        .where(eq(invoiceLineItems.invoiceId, inv!.id));
      expect(lines).toHaveLength(1);
      expect(lines[0]?.description).toBe('Monthly retainer');

      // Ledger entry posted for the draft→sent economic event.
      const entries = await db
        .select()
        .from(journalEntries)
        // biome-ignore lint/style/noNonNullAssertion: invoice asserted above
        .where(eq(journalEntries.sourceEntityId, inv!.id));
      expect(entries.length).toBeGreaterThan(0);

      // Schedule advanced: monthly from 2026-06-01 → 2026-07-01, count 1.
      const [sched] = await db.select().from(recurringInvoices).where(eq(recurringInvoices.id, id));
      expect(sched?.occurrenceCount).toBe(1);
      expect(sched?.status).toBe('active');
      // Advanced one month from the due date (one step, no collapse).
      expect(sched?.nextRunDate).toBe(advanceDate(dueOn, 'monthly', 1));

      // Emailed + audit rows by the system user.
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]?.to).toBe('pay@example.com');
      // biome-ignore lint/style/noNonNullAssertion: invoice asserted above
      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, inv!.id));
      const actions = audits.map((a) => a.action).sort();
      expect(actions).toEqual(['create', 'email-sent'].sort());
    } finally {
      await ctx.handle.close();
    }
  });

  it('skips a not-yet-due schedule (future next_run_date)', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'future@example.com');
      const { accountId, companyId } = await userContext('future@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);
      const id = await createSchedule(ctx, cookie, accountId, companyId, customerId);
      await makeDue(id, '2999-01-01');

      const result = await sweep(ctx);
      expect(result.due).toBe(0);
      const invs = await getTestDb()
        .select()
        .from(invoices)
        .where(eq(invoices.recurringInvoiceId, id));
      expect(invs).toEqual([]);
    } finally {
      await ctx.handle.close();
    }
  });

  it('skips a paused schedule even when due', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'paused@example.com');
      const { accountId, companyId } = await userContext('paused@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);
      const id = await createSchedule(ctx, cookie, accountId, companyId, customerId);
      await makeDue(id);
      await ctx.app.request(`/api/recurring-invoices/${id}/pause`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      });

      const result = await sweep(ctx);
      expect(result.due).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('ends the schedule when max_occurrences is reached', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'max@example.com');
      const { accountId, companyId } = await userContext('max@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);
      const id = await createSchedule(ctx, cookie, accountId, companyId, customerId, {
        maxOccurrences: 1,
      });
      await makeDue(id);

      await sweep(ctx);
      const [sched] = await getTestDb()
        .select()
        .from(recurringInvoices)
        .where(eq(recurringInvoices.id, id));
      expect(sched?.occurrenceCount).toBe(1);
      expect(sched?.status).toBe('ended');

      // A second sweep finds nothing (ended → not active).
      const second = await sweep(ctx);
      expect(second.due).toBe(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('ends the schedule when the next occurrence would pass end_date', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'enddate@example.com');
      const { accountId, companyId } = await userContext('enddate@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);
      // Monthly; end_date 10 days out, so the next run (one month later) is past it.
      const id = await createSchedule(ctx, cookie, accountId, companyId, customerId, {
        endDate: '2026-06-11',
      });
      await makeDue(id, '2026-06-01');

      await sweep(ctx);
      const [sched] = await getTestDb()
        .select()
        .from(recurringInvoices)
        .where(eq(recurringInvoices.id, id));
      expect(sched?.occurrenceCount).toBe(1);
      expect(sched?.status).toBe('ended');
    } finally {
      await ctx.handle.close();
    }
  });

  it('collapses a long-overdue schedule into one invoice and jumps next_run to the future', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'overdue@example.com');
      const { accountId, companyId } = await userContext('overdue@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);
      const id = await createSchedule(ctx, cookie, accountId, companyId, customerId);
      // Six months in the past.
      const sixAgo = new Date();
      sixAgo.setUTCMonth(sixAgo.getUTCMonth() - 6);
      await makeDue(id, sixAgo.toISOString().slice(0, 10));

      const result = await sweep(ctx);
      expect(result.generated).toBe(1);

      const db = getTestDb();
      const invs = await db.select().from(invoices).where(eq(invoices.recurringInvoiceId, id));
      expect(invs).toHaveLength(1); // exactly one, not six

      const [sched] = await db.select().from(recurringInvoices).where(eq(recurringInvoices.id, id));
      expect(sched?.occurrenceCount).toBe(1);
      // next_run pulled strictly into the future.
      expect((sched?.nextRunDate ?? '') > todayIso()).toBe(true);
    } finally {
      await ctx.handle.close();
    }
  });

  it('generates per-tenant under each account context (cross-account)', async () => {
    const ctx = buildApp();
    try {
      const aCookie = await signUp(ctx.app, 'sweep-a@example.com');
      const a = await userContext('sweep-a@example.com');
      const aCust = await createCustomer(ctx, aCookie, a.accountId, a.companyId);
      const aId = await createSchedule(ctx, aCookie, a.accountId, a.companyId, aCust);
      await makeDue(aId);

      const bCookie = await signUp(ctx.app, 'sweep-b@example.com');
      const b = await userContext('sweep-b@example.com');
      const bCust = await createCustomer(ctx, bCookie, b.accountId, b.companyId);
      const bId = await createSchedule(ctx, bCookie, b.accountId, b.companyId, bCust);
      await makeDue(bId);

      const result = await sweep(ctx);
      expect(result.generated).toBe(2);

      const db = getTestDb();
      const [aInv] = await db.select().from(invoices).where(eq(invoices.recurringInvoiceId, aId));
      const [bInv] = await db.select().from(invoices).where(eq(invoices.recurringInvoiceId, bId));
      expect(aInv?.accountId).toBe(a.accountId);
      expect(bInv?.accountId).toBe(b.accountId);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('POST /api/recurring-invoices/:id/run-now', () => {
  beforeEach(resetDb);

  it('generates immediately, attributed to the requesting user', async () => {
    const mailer = stubMailer();
    const ctx = buildApp(mailer);
    try {
      const cookie = await signUp(ctx.app, 'runnow@example.com');
      const { accountId, companyId } = await userContext('runnow@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId, 'pay@example.com');
      const id = await createSchedule(ctx, cookie, accountId, companyId, customerId);

      const res = await ctx.app.request(`/api/recurring-invoices/${id}/run-now`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { invoiceId: string; number: string; emailed: boolean };
      expect(body.number).toBe('INV-0001');
      expect(body.emailed).toBe(true);

      const db = getTestDb();
      const [inv] = await db.select().from(invoices).where(eq(invoices.id, body.invoiceId));
      expect(inv?.status).toBe('sent');

      // Audit actor is the requesting user, not the system user.
      const [user] = await db
        .select({ id: authUser.id, isSystem: authUser.isSystem })
        .from(authUser)
        .where(eq(authUser.email, 'runnow@example.com'));
      const [createAudit] = await db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.entityId, body.invoiceId), eq(auditEvents.action, 'create')));
      expect(createAudit?.actorUserId).toBe(user?.id);
    } finally {
      await ctx.handle.close();
    }
  });

  it('returns 409 when the schedule is not active', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'runnow-paused@example.com');
      const { accountId, companyId } = await userContext('runnow-paused@example.com');
      const customerId = await createCustomer(ctx, cookie, accountId, companyId);
      const id = await createSchedule(ctx, cookie, accountId, companyId, customerId);
      await ctx.app.request(`/api/recurring-invoices/${id}/pause`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      });

      const res = await ctx.app.request(`/api/recurring-invoices/${id}/run-now`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      });
      expect(res.status).toBe(409);
    } finally {
      await ctx.handle.close();
    }
  });
});
