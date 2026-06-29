import { authUser, companies, journalLines, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import type { Mailer } from '../src/lib/mailer.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// "Log a big purchase" — durable gear bought and used for years (a mower on
// payments). End-to-end through RLS: capitalize the cost, fund it (cash and/or a
// loan), the §179 write-off, record a payment that pays down the loan, and the
// books stay balanced with cash reflecting only the cash legs.

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
  const mailer: Mailer = { async send() {} };
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
    mailer,
    emailFrom: testEnv.emailFrom,
  });
  return { app, handle };
}

type App = ReturnType<typeof createApp>;

async function signUp(app: App, email: string): Promise<string> {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`);
  return extractSessionCookie(res);
}

async function ownerContext(email: string) {
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

function send(
  app: App,
  method: string,
  path: string,
  cookie: string,
  accountId: string,
  body?: unknown,
) {
  const headers: Record<string, string> = { cookie, 'x-account-id': accountId };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}
const get = (app: App, path: string, cookie: string, accountId: string) =>
  send(app, 'GET', path, cookie, accountId);

async function tenantBalanced(accountId: string): Promise<boolean> {
  const lines = await getTestDb()
    .select({ side: journalLines.side, amount: journalLines.amount })
    .from(journalLines)
    .where(eq(journalLines.accountId, accountId));
  const debit = lines.filter((l) => l.side === 'debit').reduce((s, l) => s + Number(l.amount), 0);
  const credit = lines.filter((l) => l.side === 'credit').reduce((s, l) => s + Number(l.amount), 0);
  return Math.abs(debit - credit) < 0.005;
}

describe('capital purchases — log a big purchase', () => {
  beforeEach(resetDb);

  it('paid in full, deduct now: capitalizes + writes off, balance sheet balanced, no loan', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'cp-full@example.com');
      const { accountId, companyId } = await ownerContext('cp-full@example.com');

      const res = await send(app, 'POST', '/api/purchases', cookie, accountId, {
        companyId,
        description: 'Mower',
        amount: '3600.00',
        purchaseDate: '2026-04-01',
        funding: 'paid_in_full',
        taxTreatment: 'deduct_now',
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string };

      // Nothing owed (paid in full), and the books balance.
      const detail = (await (
        await get(app, `/api/purchases/${created.id}`, cookie, accountId)
      ).json()) as { owing: string; schedule: unknown };
      expect(detail.owing).toBe('0.00');
      expect(detail.schedule).toBeNull(); // deduct-now has no spread schedule
      expect(await tenantBalanced(accountId)).toBe(true);

      // Balance sheet as of the purchase date: Equipment (1500) up, Accumulated
      // Depreciation (1900) the contra write-off, net book value zero.
      const bs = (await (
        await get(
          app,
          `/api/companies/${companyId}/balance-sheet?asOf=2026-04-01`,
          cookie,
          accountId,
        )
      ).json()) as { balanced: boolean; assets: { code: string; amount: string }[] };
      expect(bs.balanced).toBe(true);
      expect(bs.assets.find((a) => a.code === '1500')?.amount).toBe('3600.00');
      expect(bs.assets.find((a) => a.code === '1900')?.amount).toBe('-3600.00');

      // Cash out reflects the full price (the only cash leg).
      const dash = (await (
        await get(
          app,
          `/api/companies/${companyId}/dashboard?from=2026-04-01&to=2026-04-30`,
          cookie,
          accountId,
        )
      ).json()) as { moneyOut: string };
      expect(dash.moneyOut).toBe('3600.00');
    } finally {
      await handle.close();
    }
  });

  it('financed, spread: recognizes a loan, surfaces the schedule, balanced', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'cp-fin@example.com');
      const { accountId, companyId } = await ownerContext('cp-fin@example.com');
      const created = (await (
        await send(app, 'POST', '/api/purchases', cookie, accountId, {
          companyId,
          description: 'Trailer',
          amount: '3600.00',
          purchaseDate: '2026-04-01',
          funding: 'financed',
          downPayment: '600.00',
          taxTreatment: 'spread',
        })
      ).json()) as { id: string };

      const detail = (await (
        await get(app, `/api/purchases/${created.id}`, cookie, accountId)
      ).json()) as { owing: string; schedule: { perYear: string; years: number } | null };
      // 3600 − 600 down = 3000 financed
      expect(detail.owing).toBe('3000.00');
      expect(detail.schedule).toEqual({ perYear: '720.00', years: 5, total: '3600.00' });
      expect(await tenantBalanced(accountId)).toBe(true);

      // Only the $600 down payment is cash out; the financed remainder is not cash.
      const dash = (await (
        await get(
          app,
          `/api/companies/${companyId}/dashboard?from=2026-04-01&to=2026-04-30`,
          cookie,
          accountId,
        )
      ).json()) as { moneyOut: string };
      expect(dash.moneyOut).toBe('600.00');
    } finally {
      await handle.close();
    }
  });

  it('record a payment pays down the loan (with an interest split), balanced', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'cp-pay@example.com');
      const { accountId, companyId } = await ownerContext('cp-pay@example.com');
      const created = (await (
        await send(app, 'POST', '/api/purchases', cookie, accountId, {
          companyId,
          description: 'Mower',
          amount: '3600.00',
          purchaseDate: '2026-04-01',
          funding: 'financed',
          taxTreatment: 'deduct_now',
        })
      ).json()) as { id: string };

      const pay = await send(
        app,
        'POST',
        `/api/purchases/${created.id}/payments`,
        cookie,
        accountId,
        {
          amount: '300.00',
          interest: '20.00',
          paidOn: '2026-05-01',
        },
      );
      expect(pay.status).toBe(200);
      // 3600 owed − 280 principal = 3320
      expect((await pay.json()) as { owing: string }).toMatchObject({ owing: '3320.00' });
      expect(await tenantBalanced(accountId)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('rejects a payment on a paid-in-full purchase, and one that overpays the balance', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'cp-guard@example.com');
      const { accountId, companyId } = await ownerContext('cp-guard@example.com');

      const full = (await (
        await send(app, 'POST', '/api/purchases', cookie, accountId, {
          companyId,
          description: 'Truck',
          amount: '1000.00',
          purchaseDate: '2026-04-01',
          funding: 'paid_in_full',
          taxTreatment: 'deduct_now',
        })
      ).json()) as { id: string };
      const noPay = await send(
        app,
        'POST',
        `/api/purchases/${full.id}/payments`,
        cookie,
        accountId,
        {
          amount: '50.00',
          paidOn: '2026-05-01',
        },
      );
      expect(noPay.status).toBe(409);

      const fin = (await (
        await send(app, 'POST', '/api/purchases', cookie, accountId, {
          companyId,
          description: 'Mower',
          amount: '500.00',
          purchaseDate: '2026-04-01',
          funding: 'financed',
          taxTreatment: 'spread',
        })
      ).json()) as { id: string };
      const over = await send(app, 'POST', `/api/purchases/${fin.id}/payments`, cookie, accountId, {
        amount: '600.00',
        paidOn: '2026-05-01',
      });
      expect(over.status).toBe(409);
      expect((await over.json()) as { error: string }).toMatchObject({
        error: 'payment_exceeds_balance',
      });
    } finally {
      await handle.close();
    }
  });

  it('delete reverses an untouched purchase; blocks one with payments', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'cp-del@example.com');
      const { accountId, companyId } = await ownerContext('cp-del@example.com');

      // Untouched financed purchase deletes + nets to zero.
      const a = (await (
        await send(app, 'POST', '/api/purchases', cookie, accountId, {
          companyId,
          description: 'Mower',
          amount: '1000.00',
          purchaseDate: '2026-04-01',
          funding: 'financed',
          taxTreatment: 'spread',
        })
      ).json()) as { id: string };
      expect((await send(app, 'DELETE', `/api/purchases/${a.id}`, cookie, accountId)).status).toBe(
        200,
      );
      expect(await tenantBalanced(accountId)).toBe(true);
      // Gone from the list.
      const list = (await (await get(app, '/api/purchases', cookie, accountId)).json()) as {
        purchases: unknown[];
      };
      expect(list.purchases).toHaveLength(0);

      // One with a payment can't be deleted.
      const b = (await (
        await send(app, 'POST', '/api/purchases', cookie, accountId, {
          companyId,
          description: 'Trailer',
          amount: '1000.00',
          purchaseDate: '2026-04-01',
          funding: 'financed',
          taxTreatment: 'spread',
        })
      ).json()) as { id: string };
      await send(app, 'POST', `/api/purchases/${b.id}/payments`, cookie, accountId, {
        amount: '100.00',
        paidOn: '2026-05-01',
      });
      const blocked = await send(app, 'DELETE', `/api/purchases/${b.id}`, cookie, accountId);
      expect(blocked.status).toBe(409);
      expect((await blocked.json()) as { error: string }).toMatchObject({ error: 'has_payments' });
    } finally {
      await handle.close();
    }
  });

  it('a viewer is gated out of logging a purchase (403)', async () => {
    const { app, handle } = buildApp();
    try {
      const ownerCookie = await signUp(app, 'cp-owner@example.com');
      const { accountId, companyId } = await ownerContext('cp-owner@example.com');
      const inv = await send(app, 'POST', '/api/invitations', ownerCookie, accountId, {
        email: 'cp-viewer@example.com',
        role: 'viewer',
      });
      expect(inv.status).toBe(201);
      const viewerCookie = await signUp(app, 'cp-viewer@example.com');

      const res = await send(app, 'POST', '/api/purchases', viewerCookie, accountId, {
        companyId,
        description: 'Mower',
        amount: '100.00',
        purchaseDate: '2026-04-01',
        funding: 'paid_in_full',
        taxTreatment: 'deduct_now',
      });
      expect(res.status).toBe(403);
    } finally {
      await handle.close();
    }
  });
});
