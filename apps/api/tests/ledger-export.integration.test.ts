import { authUser, companies, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// L4 — GL / trial-balance export endpoint coverage. Uses the full
// signup → COA seeded → invoice → transition chain to populate the
// ledger, then asserts the export shape, date filtering, CSV, and
// cross-account isolation.

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

async function createCustomer(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  companyId: string,
): Promise<string> {
  const res = await app.request('/api/customers', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify({ companyId, name: 'Bob' }),
  });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

function invoiceBody(companyId: string, customerId: string, number: string) {
  return {
    companyId,
    customerId,
    number,
    issueDate: '2026-05-28',
    dueDate: '2026-06-27',
    subtotal: '100.00',
    tax: '8.25',
    total: '108.25',
    lineItems: [
      { position: 1, description: 'Service', quantity: '1', unitPrice: '100.00', amount: '100.00' },
    ],
  };
}

async function createInvoice(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  companyId: string,
  customerId: string,
  number: string,
): Promise<string> {
  const res = await app.request('/api/invoices', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify(invoiceBody(companyId, customerId, number)),
  });
  if (res.status !== 201) throw new Error(`invoice create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

type ExportJson = {
  companyId: string;
  companyName: string;
  from: string | null;
  to: string | null;
  entries: {
    id: string;
    postedAt: string;
    sourceEntityType: string;
    sourceEntityId: string;
    memo: string | null;
    lines: {
      code: string;
      accountName: string;
      accountType: string;
      side: 'debit' | 'credit';
      amount: string;
    }[];
  }[];
  trialBalance: {
    code: string;
    accountName: string;
    accountType: string;
    debit: string;
    credit: string;
    net: string;
  }[];
};

describe('GET /api/companies/:id/ledger/export — JSON', () => {
  beforeEach(resetDb);

  it('returns nested entries + balanced trial balance after a full life cycle', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'exporter@example.com');
      const { accountId, companyId } = await userContext('exporter@example.com');
      const customerId = await createCustomer(app, cookie, accountId, companyId);
      const a = await createInvoice(app, cookie, accountId, companyId, customerId, 'EXP-1');
      const b = await createInvoice(app, cookie, accountId, companyId, customerId, 'EXP-2');

      await app.request(`/api/invoices/${a}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      await app.request(`/api/invoices/${a}/mark-paid`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'cash' }),
      });
      await app.request(`/api/invoices/${b}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });

      const res = await app.request(`/api/companies/${companyId}/ledger/export`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ExportJson;
      expect(body.companyId).toBe(companyId);
      expect(body.entries).toHaveLength(3);
      const totalDebit = body.trialBalance.reduce((s, r) => s + Number(r.debit), 0);
      const totalCredit = body.trialBalance.reduce((s, r) => s + Number(r.credit), 0);
      expect(totalDebit).toBeCloseTo(totalCredit, 2);
      const cash = body.trialBalance.find((r) => r.code === '1000');
      const ar = body.trialBalance.find((r) => r.code === '1200');
      const rev = body.trialBalance.find((r) => r.code === '4000');
      const tax = body.trialBalance.find((r) => r.code === '2200');
      expect(cash?.debit).toBe('108.25');
      expect(ar?.net).toBe('108.25');
      expect(rev?.credit).toBe('200.00');
      expect(tax?.credit).toBe('16.50');
    } finally {
      await handle.close();
    }
  });

  it('filters by from/to date range (inclusive)', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'ranger@example.com');
      const { accountId, companyId } = await userContext('ranger@example.com');
      const customerId = await createCustomer(app, cookie, accountId, companyId);
      const inv = await createInvoice(app, cookie, accountId, companyId, customerId, 'RNG-1');
      await app.request(`/api/invoices/${inv}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });

      const today = new Date().toISOString().slice(0, 10);
      const withinRes = await app.request(
        `/api/companies/${companyId}/ledger/export?from=${today}&to=${today}`,
        { headers: { cookie, 'x-account-id': accountId } },
      );
      const within = (await withinRes.json()) as ExportJson;
      expect(within.entries).toHaveLength(1);

      const futureFrom = '2099-01-01';
      const futureTo = '2099-12-31';
      const outsideRes = await app.request(
        `/api/companies/${companyId}/ledger/export?from=${futureFrom}&to=${futureTo}`,
        { headers: { cookie, 'x-account-id': accountId } },
      );
      const outside = (await outsideRes.json()) as ExportJson;
      expect(outside.entries).toHaveLength(0);
      expect(outside.trialBalance).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });

  it('rejects an invalid date with 400', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'baddate@example.com');
      const { accountId, companyId } = await userContext('baddate@example.com');
      const res = await app.request(`/api/companies/${companyId}/ledger/export?from=not-a-date`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it('rejects flipped from > to with 400', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'flipped@example.com');
      const { accountId, companyId } = await userContext('flipped@example.com');
      const res = await app.request(
        `/api/companies/${companyId}/ledger/export?from=2026-06-01&to=2026-05-01`,
        { headers: { cookie, 'x-account-id': accountId } },
      );
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it('404s a company that belongs to a different account', async () => {
    const { app, handle } = buildApp();
    try {
      await signUp(app, 'aa@example.com');
      const a = await userContext('aa@example.com');
      const bCookie = await signUp(app, 'bb@example.com');
      const b = await userContext('bb@example.com');

      const res = await app.request(`/api/companies/${a.companyId}/ledger/export`, {
        headers: { cookie: bCookie, 'x-account-id': b.accountId },
      });
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it('returns an empty export for a company with no activity', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'quiet@example.com');
      const { accountId, companyId } = await userContext('quiet@example.com');
      const res = await app.request(`/api/companies/${companyId}/ledger/export`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ExportJson;
      expect(body.entries).toEqual([]);
      expect(body.trialBalance).toEqual([]);
    } finally {
      await handle.close();
    }
  });
});

describe('GET /api/companies/:id/ledger/export — CSV', () => {
  beforeEach(resetDb);

  it('returns text/csv with one row per journal line', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'csver@example.com');
      const { accountId, companyId } = await userContext('csver@example.com');
      const customerId = await createCustomer(app, cookie, accountId, companyId);
      const inv = await createInvoice(app, cookie, accountId, companyId, customerId, 'CSV-1');
      await app.request(`/api/invoices/${inv}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });

      const res = await app.request(`/api/companies/${companyId}/ledger/export?format=csv`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
      expect(res.headers.get('content-disposition')).toContain('attachment');
      const body = await res.text();
      const lines = body.trim().split('\n');
      expect(lines[0]).toBe(
        'posted_at,entry_id,code,account_name,side,amount,source_type,source_id,memo',
      );
      // mark-sent on a taxed invoice = 3 journal lines (AR, Revenue, Tax)
      expect(lines).toHaveLength(4);
      const arRow = lines.find((l) => l.includes(',1200,'));
      expect(arRow).toContain(',debit,108.25,');
    } finally {
      await handle.close();
    }
  });

  it('rejects an unknown format with 400', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'badfmt@example.com');
      const { accountId, companyId } = await userContext('badfmt@example.com');
      const res = await app.request(`/api/companies/${companyId}/ledger/export?format=xml`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });
});
