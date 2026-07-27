import { authUser, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Business type → chart of accounts, end to end (TMC-124). Creating a company
// with a type seeds that type's chart; changing the type re-maps the chart in
// place; and the Schedule C worksheet refuses for the entities that don't file
// one. Chart shapes themselves are unit-tested in packages/db.

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

async function accountIdFor(email: string) {
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
  return m.accountId;
}

type Company = { id: string; name: string; businessType: string | null };
type Account = { code: string; name: string; accountType: string };

async function setUp(email: string) {
  const ctx = buildApp();
  const cookie = await signUp(ctx.app, email);
  const accountId = await accountIdFor(email);
  const headers = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };

  const list = await ctx.app.request('/api/companies', { headers });
  const { companies } = (await list.json()) as { companies: Company[] };
  const company = companies[0];
  if (!company) throw new Error('signup seeded no company');

  const chart = async (): Promise<Map<string, Account>> => {
    const res = await ctx.app.request(`/api/companies/${company.id}/accounts`, { headers });
    const { accounts } = (await res.json()) as { accounts: Account[] };
    return new Map(accounts.map((a) => [a.code, a]));
  };

  const setType = (businessType: string) =>
    ctx.app.request(`/api/companies/${company.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ businessType }),
    });

  return { ...ctx, headers, company, chart, setType };
}

describe('company create seeds the chart for its business type', () => {
  beforeEach(resetDb);

  it('seeds a partnership chart, not the sole-prop one', async () => {
    const ctx = await setUp('chart-create@example.com');
    try {
      const res = await ctx.app.request('/api/companies', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({ name: 'Two Guys Landscaping', businessType: 'partnership' }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as Company;

      const accountsRes = await ctx.app.request(`/api/companies/${created.id}/accounts`, {
        headers: ctx.headers,
      });
      const { accounts } = (await accountsRes.json()) as { accounts: Account[] };
      const byCode = new Map(accounts.map((a) => [a.code, a]));

      expect(byCode.get('3000')?.name).toBe("Partners' Capital");
      expect(byCode.get('7550')?.name).toBe('Guaranteed Payments to Partners');
      // A corporation's accounts have no business on a partnership's chart.
      expect(byCode.has('3400')).toBe(false);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('PATCH business type re-maps the chart', () => {
  beforeEach(resetDb);

  // Signup seeds a provisional sole-prop chart because it has no answer yet;
  // the welcome wizard's PATCH is where the real answer arrives.
  it('converts the signup-seeded chart when onboarding answers S-corp', async () => {
    const ctx = await setUp('chart-wizard@example.com');
    try {
      expect((await ctx.chart()).get('3100')?.name).toBe("Owner's Draw");

      const res = await ctx.setType('s_corp');
      expect(res.status).toBe(200);
      expect(((await res.json()) as Company).businessType).toBe('s_corp');

      const byCode = await ctx.chart();
      expect(byCode.get('3000')?.name).toBe('Capital Stock');
      expect(byCode.get('3100')?.name).toBe('Shareholder Distributions');
      expect(byCode.get('3400')?.name).toBe('Retained Earnings');
      expect(byCode.get('7450')?.name).toBe('Officer Compensation');
    } finally {
      await ctx.handle.close();
    }
  });

  it('switches a company between two non-default types', async () => {
    const ctx = await setUp('chart-switch@example.com');
    try {
      await ctx.setType('c_corp');
      expect((await ctx.chart()).get('7800')?.name).toBe('Income Tax Expense');

      await ctx.setType('partnership');
      const byCode = await ctx.chart();
      // A partnership is a pass-through — it never carries its own income tax,
      // so those accounts drop out of the active chart.
      expect(byCode.has('7800')).toBe(false);
      expect(byCode.has('2400')).toBe(false);
      expect(byCode.get('3000')?.name).toBe("Partners' Capital");
    } finally {
      await ctx.handle.close();
    }
  });

  it('leaves the chart alone when the PATCH does not change the type', async () => {
    const ctx = await setUp('chart-noop@example.com');
    try {
      await ctx.setType('s_corp');
      const before = await ctx.chart();

      const res = await ctx.app.request(`/api/companies/${ctx.company.id}`, {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({ name: 'Renamed Co' }),
      });
      expect(res.status).toBe(200);
      expect(await ctx.chart()).toEqual(before);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('GET /api/companies/:id/schedule-c gates on the entity type', () => {
  beforeEach(resetDb);

  it('serves the worksheet for the two Schedule C types', async () => {
    const ctx = await setUp('sched-c-ok@example.com');
    try {
      for (const bt of ['sole_prop', 'llc_single_member']) {
        await ctx.setType(bt);
        const res = await ctx.app.request(`/api/companies/${ctx.company.id}/schedule-c?year=2026`, {
          headers: ctx.headers,
        });
        expect(res.status, bt).toBe(200);
      }
    } finally {
      await ctx.handle.close();
    }
  });

  // Their chart is mapped to their own return, so this worksheet would render
  // every line at zero. Refusing and naming the real form beats a blank that
  // reads as "you had no expenses".
  it('409s for the entities that file their own return, naming the form', async () => {
    const ctx = await setUp('sched-c-no@example.com');
    try {
      const cases = [
        ['partnership', 'Form 1065'],
        ['s_corp', 'Form 1120-S'],
        ['c_corp', 'Form 1120'],
      ];
      for (const [bt, form] of cases) {
        await ctx.setType(bt as string);
        const res = await ctx.app.request(`/api/companies/${ctx.company.id}/schedule-c?year=2026`, {
          headers: ctx.headers,
        });
        expect(res.status, bt).toBe(409);
        expect(await res.json()).toEqual({ error: 'wrong_tax_form', taxForm: form });
      }
    } finally {
      await ctx.handle.close();
    }
  });
});
