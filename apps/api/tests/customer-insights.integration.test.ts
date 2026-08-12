import { authUser, companies, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Customer insights — what one customer is worth and whether they pay.
//
// The assertions that matter here are CROSS-SYSTEM. A check that only compares
// this endpoint to itself proves the arithmetic is self-consistent and nothing
// else; the failure mode this ticket exists to prevent is two screens in the
// same product answering one question differently. So: owed ties to A/R aging,
// the median ties to the send-check, and reliability ties to the endpoint it
// was extracted from.

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
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`);
  return extractSessionCookie(res);
}

type Ctx = {
  app: ReturnType<typeof createApp>;
  cookie: string;
  accountId: string;
  companyId: string;
};

async function setup(email: string): Promise<{ ctx: Ctx; close: () => Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
    emailFrom: testEnv.emailFrom,
  });
  const cookie = await signUp(app, email);
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
  if (!m) throw new Error('membership not seeded');
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.accountId, m.accountId));
  if (!company) throw new Error('company not seeded');
  return {
    ctx: { app, cookie, accountId: m.accountId, companyId: company.id },
    close: handle.close,
  };
}

function headers(ctx: Ctx) {
  return { cookie: ctx.cookie, 'x-account-id': ctx.accountId, 'content-type': 'application/json' };
}

async function createContact(ctx: Ctx, name = 'Acme'): Promise<string> {
  const res = await ctx.app.request('/api/contacts', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({ companyId: ctx.companyId, name }),
  });
  if (res.status !== 201) throw new Error(`contact create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function invoice(
  ctx: Ctx,
  contactId: string,
  opts: { number: string; subtotal: string; tax?: string; issueDate: string; dueDate?: string },
): Promise<string> {
  const tax = opts.tax ?? '0.00';
  const total = (Number(opts.subtotal) + Number(tax)).toFixed(2);
  const res = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId,
      number: opts.number,
      issueDate: opts.issueDate,
      dueDate: opts.dueDate ?? opts.issueDate,
      subtotal: opts.subtotal,
      tax,
      total,
      lineItems: [
        {
          position: 1,
          description: 'Service',
          quantity: '1',
          unitPrice: opts.subtotal,
          amount: opts.subtotal,
        },
      ],
    }),
  });
  if (res.status !== 201) throw new Error(`invoice create failed: ${res.status}`);
  const id = ((await res.json()) as { id: string }).id;
  const sent = await ctx.app.request(`/api/invoices/${id}/mark-sent`, {
    method: 'POST',
    headers: headers(ctx),
  });
  if (sent.status !== 200) throw new Error(`mark-sent failed: ${sent.status}`);
  return id;
}

async function pay(
  ctx: Ctx,
  invoiceId: string,
  opts: { amount: string; receivedOn: string },
): Promise<void> {
  const res = await ctx.app.request(`/api/invoices/${invoiceId}/payments`, {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({ method: 'check', ...opts }),
  });
  if (res.status !== 201 && res.status !== 200)
    throw new Error(`payment failed: ${res.status} ${await res.text()}`);
}

async function estimate(
  ctx: Ctx,
  contactId: string,
  opts: { number: string; expiresOn?: string | null; outcome?: 'accepted' | 'declined' | 'sent' },
): Promise<string> {
  const res = await ctx.app.request('/api/estimates', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId,
      number: opts.number,
      issueDate: '2026-01-10',
      ...(opts.expiresOn === undefined ? { expiresOn: '2026-02-10' } : {}),
      ...(typeof opts.expiresOn === 'string' ? { expiresOn: opts.expiresOn } : {}),
      subtotal: '100.00',
      tax: '0.00',
      total: '100.00',
      lineItems: [
        {
          position: 1,
          description: 'Quote',
          quantity: '1',
          unitPrice: '100.00',
          amount: '100.00',
        },
      ],
    }),
  });
  if (res.status !== 201)
    throw new Error(`estimate create failed: ${res.status} ${await res.text()}`);
  const id = ((await res.json()) as { id: string }).id;
  const outcome = opts.outcome ?? 'sent';
  await ctx.app.request(`/api/estimates/${id}/mark-sent`, {
    method: 'POST',
    headers: headers(ctx),
  });
  if (outcome !== 'sent') {
    await ctx.app.request(`/api/estimates/${id}/mark-${outcome}`, {
      method: 'POST',
      headers: headers(ctx),
    });
  }
  return id;
}

type Insights = {
  billed: { last12: string; allTime: string; invoiceCount: number };
  owed: { amount: string; overdueCount: number; overdueAmount: string };
  typical: { median: string | null; recent: string[] };
  months: { month: string; billed: string }[];
  estimates: { accepted: number; declined: number; answered: number; open: number; lapsed: number };
  reliability: Record<string, unknown>;
  firstInvoiceOn: string | null;
  lastInvoiceOn: string | null;
};

async function insights(ctx: Ctx, contactId: string): Promise<Insights> {
  const res = await ctx.app.request(`/api/contacts/${contactId}/insights`, {
    headers: headers(ctx),
  });
  if (res.status !== 200) throw new Error(`insights failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as Insights;
}

const today = new Date().toISOString().slice(0, 10);
const monthsAgo = (n: number) => {
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
};

describe('GET /api/contacts/:id/insights', () => {
  beforeEach(resetDb);

  it('agrees with A/R aging about what this customer owes', async () => {
    const { ctx, close } = await setup('ins-aging@example.com');
    try {
      const cust = await createContact(ctx);
      const a = await invoice(ctx, cust, {
        number: 'INV-1',
        subtotal: '1000.00',
        issueDate: monthsAgo(2),
      });
      await pay(ctx, a, { amount: '400.00', receivedOn: monthsAgo(1) });
      await invoice(ctx, cust, { number: 'INV-2', subtotal: '250.00', issueDate: monthsAgo(1) });
      // Settled — contributes to neither number.
      const c = await invoice(ctx, cust, {
        number: 'INV-3',
        subtotal: '80.00',
        issueDate: monthsAgo(1),
      });
      await pay(ctx, c, { amount: '80.00', receivedOn: today });

      const body = await insights(ctx, cust);
      const agingRes = await ctx.app.request(`/api/companies/${ctx.companyId}/ar-aging`, {
        headers: headers(ctx),
      });
      const aging = (await agingRes.json()) as { invoices: { amount: string }[] };
      const agingTotal = aging.invoices
        .reduce((sum, r) => sum + Math.round(Number(r.amount) * 100), 0)
        .toString();

      // The deposit is honoured: 600 left on INV-1, plus 250 on INV-2.
      expect(body.owed.amount).toBe('850.00');
      expect(Math.round(Number(body.owed.amount) * 100).toString()).toBe(agingTotal);
    } finally {
      await close();
    }
  });

  it('states the same median the send-check will compare against', async () => {
    const { ctx, close } = await setup('ins-median@example.com');
    try {
      const cust = await createContact(ctx);
      for (const [i, amount] of ['200.00', '400.00', '300.00'].entries()) {
        await invoice(ctx, cust, {
          number: `INV-${i + 1}`,
          subtotal: amount,
          issueDate: monthsAgo(3 - i),
        });
      }
      // A draft: excluded from both, which is what makes them agree at the only
      // moment it matters.
      const draftRes = await ctx.app.request('/api/invoices', {
        method: 'POST',
        headers: headers(ctx),
        body: JSON.stringify({
          companyId: ctx.companyId,
          contactId: cust,
          number: 'INV-NEW',
          issueDate: today,
          dueDate: today,
          subtotal: '2000.00',
          tax: '0.00',
          total: '2000.00',
          lineItems: [
            {
              position: 1,
              description: 'Service',
              quantity: '1',
              unitPrice: '2000.00',
              amount: '2000.00',
            },
          ],
        }),
      });
      const draftId = ((await draftRes.json()) as { id: string }).id;

      const body = await insights(ctx, cust);
      expect(body.typical.median).toBe('300.00');

      const checkRes = await ctx.app.request(`/api/invoices/${draftId}/send-check`, {
        headers: headers(ctx),
      });
      const check = (await checkRes.json()) as { concern: string | null; signal: string | null };
      expect(check.signal).toBe('median');
      // The send-check states its median in a sentence rather than a field, so
      // the tie is that the sentence quotes the SAME figure this page shows.
      // Built from the response rather than hard-coded, so the two cannot pass
      // while disagreeing.
      const shown = `$${Number(body.typical.median).toLocaleString('en-US', {
        minimumFractionDigits: 2,
      })}`;
      expect(check.concern).toContain(shown);
    } finally {
      await close();
    }
  });

  it('returns the same reliability object as the endpoint it was extracted from', async () => {
    const { ctx, close } = await setup('ins-reliability@example.com');
    try {
      const cust = await createContact(ctx);
      const a = await invoice(ctx, cust, {
        number: 'INV-1',
        subtotal: '500.00',
        issueDate: monthsAgo(3),
        dueDate: monthsAgo(3),
      });
      await pay(ctx, a, { amount: '500.00', receivedOn: monthsAgo(1) });
      await invoice(ctx, cust, {
        number: 'INV-2',
        subtotal: '300.00',
        issueDate: monthsAgo(2),
        dueDate: monthsAgo(2),
      });

      const body = await insights(ctx, cust);
      const relRes = await ctx.app.request(`/api/contacts/${cust}/payment-reliability`, {
        headers: headers(ctx),
      });
      expect(body.reliability).toEqual(await relRes.json());
    } finally {
      await close();
    }
  });

  // The defect found while extracting: payment-reliability summed the full
  // invoice total, so a part-paid overdue invoice reported more owed than A/R
  // aging did for the same invoice. Fixing it in the shared function fixes both.
  it('reports overdue net of what has already been received', async () => {
    const { ctx, close } = await setup('ins-overdue@example.com');
    try {
      const cust = await createContact(ctx);
      const a = await invoice(ctx, cust, {
        number: 'INV-1',
        subtotal: '1000.00',
        issueDate: monthsAgo(3),
        dueDate: monthsAgo(2),
      });
      await pay(ctx, a, { amount: '600.00', receivedOn: monthsAgo(1) });

      const body = await insights(ctx, cust);
      expect(body.owed.overdueCount).toBe(1);
      expect(body.owed.overdueAmount).toBe('400.00');

      const relRes = await ctx.app.request(`/api/contacts/${cust}/payment-reliability`, {
        headers: headers(ctx),
      });
      expect(((await relRes.json()) as { overdueTotal: string }).overdueTotal).toBe('400.00');
    } finally {
      await close();
    }
  });

  // Owner decision, 2026-08-11. A quote that expired unanswered is not a "no" —
  // the customer said nothing, and the expiry date was the operator's choice.
  it('keeps a lapsed estimate out of the accept rate and counts it separately', async () => {
    const { ctx, close } = await setup('ins-estimates@example.com');
    try {
      const cust = await createContact(ctx);
      await estimate(ctx, cust, { number: 'EST-1', outcome: 'accepted' });
      await estimate(ctx, cust, { number: 'EST-2', outcome: 'accepted' });
      await estimate(ctx, cust, { number: 'EST-3', outcome: 'declined' });
      // Sent, expiry long past, never answered.
      await estimate(ctx, cust, { number: 'EST-4', expiresOn: '2026-02-01' });
      // Sent, still live.
      await estimate(ctx, cust, { number: 'EST-5', expiresOn: '2099-01-01' });

      const body = await insights(ctx, cust);
      expect(body.estimates).toEqual({
        accepted: 2,
        declined: 1,
        answered: 3,
        open: 1,
        lapsed: 1,
      });
    } finally {
      await close();
    }
  });

  it('bills pre-tax while owing gross, and reports a month series', async () => {
    const { ctx, close } = await setup('ins-billed@example.com');
    try {
      const cust = await createContact(ctx);
      await invoice(ctx, cust, {
        number: 'INV-1',
        subtotal: '1000.00',
        tax: '80.00',
        issueDate: monthsAgo(1),
      });

      const body = await insights(ctx, cust);
      // Billed is the work; owed is what the customer was actually asked for.
      expect(body.billed.allTime).toBe('1000.00');
      expect(body.billed.last12).toBe('1000.00');
      expect(body.owed.amount).toBe('1080.00');
      expect(body.billed.invoiceCount).toBe(1);
      expect(body.months).toEqual([{ month: monthsAgo(1).slice(0, 7), billed: '1000.00' }]);
      expect(body.firstInvoiceOn).toBe(monthsAgo(1));
    } finally {
      await close();
    }
  });

  it('gives a customer with no history zeros rather than a 404', async () => {
    const { ctx, close } = await setup('ins-empty@example.com');
    try {
      const cust = await createContact(ctx);
      const body = await insights(ctx, cust);
      expect(body.billed).toEqual({ last12: '0.00', allTime: '0.00', invoiceCount: 0 });
      expect(body.owed).toEqual({ amount: '0.00', overdueCount: 0, overdueAmount: '0.00' });
      expect(body.typical).toEqual({ median: null, recent: [] });
      expect(body.months).toEqual([]);
      expect(body.firstInvoiceOn).toBeNull();
    } finally {
      await close();
    }
  });

  it('404s a customer in another account', async () => {
    const { ctx, close } = await setup('ins-a@example.com');
    try {
      const cust = await createContact(ctx);
      const res = await ctx.app.request(`/api/contacts/${cust}/insights`, {
        headers: { cookie: ctx.cookie, 'x-account-id': crypto.randomUUID() },
      });
      expect(res.status).not.toBe(200);
    } finally {
      await close();
    }
  });
});
