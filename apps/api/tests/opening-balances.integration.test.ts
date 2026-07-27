import { authUser, chartOfAccounts, companies, memberships, openingBalances } from '@thalermark/db';
import { and, eq, isNull } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import type { Mailer } from '../src/lib/mailer.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Opening balances ("Starting balances" in My Money) — what the business already
// had at the start, posted as one combined balanced entry against the standard
// accounts. End-to-end through RLS: set / read / edit / clear, plus the position
// dashboard + balance sheet read the right figures, and the gate (expenses:write).

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

describe('opening balances — starting position', () => {
  beforeEach(resetDb);

  it('returns null until set, then round-trips a cash-only opening balance', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'ob-cash@example.com');
      const { accountId, companyId } = await ownerContext('ob-cash@example.com');

      const empty = await get(
        app,
        `/api/owner-money/opening-balance?companyId=${companyId}`,
        cookie,
        accountId,
      );
      expect(empty.status).toBe(200);
      expect((await empty.json()) as { openingBalance: unknown }).toEqual({
        openingBalance: null,
        lines: [],
      });

      const put = await send(app, 'PUT', '/api/owner-money/opening-balance', cookie, accountId, {
        companyId,
        asOfDate: '2026-01-01',
        cash: '5000.00',
      });
      expect(put.status).toBe(201);

      const read = await get(
        app,
        `/api/owner-money/opening-balance?companyId=${companyId}`,
        cookie,
        accountId,
      );
      const body = (await read.json()) as { openingBalance: { cash: string; payables: string } };
      expect(body.openingBalance).toMatchObject({ cash: '5000.00', payables: '0.00' });

      // The cash lands in the position dashboard (cash in over the window) and on
      // the balance sheet (Cash asset + Owner's Equity), and it balances.
      const dash = (await (
        await get(
          app,
          `/api/companies/${companyId}/dashboard?from=2026-01-01&to=2026-01-31`,
          cookie,
          accountId,
        )
      ).json()) as { moneyIn: string };
      expect(dash.moneyIn).toBe('5000.00');

      const bs = (await (
        await get(
          app,
          `/api/companies/${companyId}/balance-sheet?asOf=2026-12-31`,
          cookie,
          accountId,
        )
      ).json()) as {
        balanced: boolean;
        assets: { code: string; amount: string }[];
        equity: { code: string; amount: string }[];
      };
      expect(bs.balanced).toBe(true);
      expect(bs.assets.find((a) => a.code === '1000')?.amount).toBe('5000.00');
      expect(bs.equity.find((e) => e.code === '3000')?.amount).toBe('5000.00');
    } finally {
      await handle.close();
    }
  });

  it('records receivables + payables → dashboard owed/owing', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'ob-arap@example.com');
      const { accountId, companyId } = await ownerContext('ob-arap@example.com');
      await send(app, 'PUT', '/api/owner-money/opening-balance', cookie, accountId, {
        companyId,
        asOfDate: '2026-01-01',
        cash: '500.00',
        receivables: '200.00',
        payables: '100.00',
      });

      const dash = (await (
        await get(
          app,
          `/api/companies/${companyId}/dashboard?from=2026-01-01&to=2026-01-31`,
          cookie,
          accountId,
        )
      ).json()) as { owed: string; owing: string };
      expect(dash.owed).toBe('200.00');
      expect(dash.owing).toBe('100.00');
    } finally {
      await handle.close();
    }
  });

  it('editing reverses + reposts (no doubling)', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'ob-edit@example.com');
      const { accountId, companyId } = await ownerContext('ob-edit@example.com');
      await send(app, 'PUT', '/api/owner-money/opening-balance', cookie, accountId, {
        companyId,
        asOfDate: '2026-01-01',
        cash: '1000.00',
      });
      const put2 = await send(app, 'PUT', '/api/owner-money/opening-balance', cookie, accountId, {
        companyId,
        asOfDate: '2026-01-01',
        cash: '2000.00',
      });
      expect(put2.status).toBe(200); // update, not create

      // Still exactly one active row, and the balance sheet shows 2000 (not 3000).
      const rows = await getTestDb()
        .select()
        .from(openingBalances)
        .where(and(eq(openingBalances.companyId, companyId), isNull(openingBalances.deletedAt)));
      expect(rows).toHaveLength(1);
      const bs = (await (
        await get(
          app,
          `/api/companies/${companyId}/balance-sheet?asOf=2026-12-31`,
          cookie,
          accountId,
        )
      ).json()) as { balanced: boolean; assets: { code: string; amount: string }[] };
      expect(bs.balanced).toBe(true);
      expect(bs.assets.find((a) => a.code === '1000')?.amount).toBe('2000.00');
    } finally {
      await handle.close();
    }
  });

  it('clearing soft-deletes and nets the GL to zero', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'ob-clear@example.com');
      const { accountId, companyId } = await ownerContext('ob-clear@example.com');
      await send(app, 'PUT', '/api/owner-money/opening-balance', cookie, accountId, {
        companyId,
        asOfDate: '2026-01-01',
        cash: '1000.00',
      });
      const del = await send(
        app,
        'DELETE',
        `/api/owner-money/opening-balance?companyId=${companyId}`,
        cookie,
        accountId,
      );
      expect(del.status).toBe(200);

      const read = await get(
        app,
        `/api/owner-money/opening-balance?companyId=${companyId}`,
        cookie,
        accountId,
      );
      expect((await read.json()) as { openingBalance: unknown }).toEqual({
        openingBalance: null,
        lines: [],
      });

      // Cash netted away — no 1000 asset line remains on the balance sheet.
      const bs = (await (
        await get(
          app,
          `/api/companies/${companyId}/balance-sheet?asOf=2026-12-31`,
          cookie,
          accountId,
        )
      ).json()) as { assets: { code: string }[] };
      expect(bs.assets.find((a) => a.code === '1000')).toBeUndefined();

      // And a fresh one can be set again (the unique index only covers active rows).
      const again = await send(app, 'PUT', '/api/owner-money/opening-balance', cookie, accountId, {
        companyId,
        asOfDate: '2026-02-01',
        cash: '750.00',
      });
      expect(again.status).toBe(201);
    } finally {
      await handle.close();
    }
  });

  it('rejects an all-zero opening balance', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'ob-zero@example.com');
      const { accountId, companyId } = await ownerContext('ob-zero@example.com');
      const res = await send(app, 'PUT', '/api/owner-money/opening-balance', cookie, accountId, {
        companyId,
        asOfDate: '2026-01-01',
        cash: '0',
        receivables: '0',
        payables: '0',
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_body' });
    } finally {
      await handle.close();
    }
  });

  it('a viewer is gated out of writing (403) but may read', async () => {
    const { app, handle } = buildApp();
    try {
      const ownerCookie = await signUp(app, 'ob-owner@example.com');
      const { accountId, companyId } = await ownerContext('ob-owner@example.com');
      // Invite a viewer who joins via the signup hook carrying the invite role.
      const inv = await send(app, 'POST', '/api/invitations', ownerCookie, accountId, {
        email: 'ob-viewer@example.com',
        role: 'viewer',
      });
      expect(inv.status).toBe(201);
      const viewerCookie = await signUp(app, 'ob-viewer@example.com');

      const write = await send(
        app,
        'PUT',
        '/api/owner-money/opening-balance',
        viewerCookie,
        accountId,
        {
          companyId,
          asOfDate: '2026-01-01',
          cash: '100.00',
        },
      );
      expect(write.status).toBe(403);

      const read = await get(
        app,
        `/api/owner-money/opening-balance?companyId=${companyId}`,
        viewerCookie,
        accountId,
      );
      expect(read.status).toBe(200);
    } finally {
      await handle.close();
    }
  });
});

// The full shape — an opening trial balance entered account by account. What a
// business arriving from QuickBooks or Xero actually has, and what the three
// plain questions structurally cannot express.
describe('opening balances — full trial balance', () => {
  beforeEach(resetDb);

  async function coaId(companyId: string, code: string): Promise<string> {
    const [row] = await getTestDb()
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.companyId, companyId), eq(chartOfAccounts.code, code)));
    if (!row) throw new Error(`COA ${code} not seeded for ${companyId}`);
    return row.id;
  }

  it('opens the books with a part-depreciated asset and a loan', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'ob-full@example.com');
      const { accountId, companyId } = await ownerContext('ob-full@example.com');

      // A real starting position: cash, a mower that cost 6,000 and has already
      // been written down by 2,400, and 3,000 still owed on it. None of this can
      // be said with three numbers.
      const lines = [
        { coaAccountId: await coaId(companyId, '1000'), side: 'debit', amount: '4000.00' },
        { coaAccountId: await coaId(companyId, '1500'), side: 'debit', amount: '6000.00' },
        { coaAccountId: await coaId(companyId, '1900'), side: 'credit', amount: '2400.00' },
        { coaAccountId: await coaId(companyId, '2700'), side: 'credit', amount: '3000.00' },
        { coaAccountId: await coaId(companyId, '3000'), side: 'credit', amount: '4600.00' },
      ];

      const put = await send(app, 'PUT', '/api/owner-money/opening-balance', cookie, accountId, {
        companyId,
        asOfDate: '2026-01-01',
        lines,
      });
      expect(put.status).toBe(201);
      expect(((await put.json()) as { shape: string }).shape).toBe('full');

      const bs = (await (
        await get(
          app,
          `/api/companies/${companyId}/balance-sheet?asOf=2026-01-01`,
          cookie,
          accountId,
        )
      ).json()) as {
        assets: { code: string; amount: string }[];
        liabilities: { code: string; amount: string }[];
        equity: { code: string; amount: string }[];
        totalAssets: string;
        balanced: boolean;
      };

      expect(bs.balanced).toBe(true);
      const assets = new Map(bs.assets.map((a) => [a.code, a.amount]));
      expect(assets.get('1000')).toBe('4000.00');
      expect(assets.get('1500')).toBe('6000.00');
      // 1900 is a contra-asset seeded debit-normal, so its credit balance nets
      // negative and reduces total assets — no special-casing anywhere.
      expect(assets.get('1900')).toBe('-2400.00');
      expect(bs.totalAssets).toBe('7600.00');
      expect(new Map(bs.liabilities.map((l) => [l.code, l.amount])).get('2700')).toBe('3000.00');
      expect(new Map(bs.equity.map((e) => [e.code, e.amount])).get('3000')).toBe('4600.00');
    } finally {
      await handle.close();
    }
  });

  it('refuses an entry that does not balance', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'ob-unbalanced@example.com');
      const { accountId, companyId } = await ownerContext('ob-unbalanced@example.com');

      const res = await send(app, 'PUT', '/api/owner-money/opening-balance', cookie, accountId, {
        companyId,
        asOfDate: '2026-01-01',
        lines: [
          { coaAccountId: await coaId(companyId, '1000'), side: 'debit', amount: '100.00' },
          { coaAccountId: await coaId(companyId, '3000'), side: 'credit', amount: '90.00' },
        ],
      });
      // A clean 400 the form can show inline, not a deferred trigger abort.
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it('switching from simple to full reverses the old posting exactly', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'ob-switch@example.com');
      const { accountId, companyId } = await ownerContext('ob-switch@example.com');

      await send(app, 'PUT', '/api/owner-money/opening-balance', cookie, accountId, {
        companyId,
        asOfDate: '2026-01-01',
        cash: '1000.00',
      });

      // Re-enter the same position as a full trial balance touching DIFFERENT
      // accounts. The reversal has to be built from what was stored, not from
      // what's replacing it, or the old cash line would be stranded.
      await send(app, 'PUT', '/api/owner-money/opening-balance', cookie, accountId, {
        companyId,
        asOfDate: '2026-01-01',
        lines: [
          { coaAccountId: await coaId(companyId, '1500'), side: 'debit', amount: '2500.00' },
          { coaAccountId: await coaId(companyId, '3000'), side: 'credit', amount: '2500.00' },
        ],
      });

      const bs = (await (
        await get(
          app,
          `/api/companies/${companyId}/balance-sheet?asOf=2026-01-01`,
          cookie,
          accountId,
        )
      ).json()) as {
        assets: { code: string; amount: string }[];
        totalAssets: string;
        balanced: boolean;
      };
      expect(bs.balanced).toBe(true);
      expect(bs.totalAssets).toBe('2500.00');
      // The original cash must be gone, not merely outweighed.
      expect(bs.assets.some((a) => a.code === '1000')).toBe(false);
    } finally {
      await handle.close();
    }
  });
});
