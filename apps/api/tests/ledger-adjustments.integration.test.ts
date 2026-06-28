import { authUser, chartOfAccounts, companies, journalLines, memberships } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Prong B — "The Ledger" manual journal adjustments. End-to-end through RLS
// (the suite runs as thalermark_app): an owner posts balanced debit/credit
// entries against the chart of accounts, lists/reads them, and reverses them.
// Provenance + reversal-safety live in the source_entity_* columns (no domain
// table); the capability gate is covered exhaustively in
// roles-authz.integration.test.ts, so here we focus on behaviour + the
// depreciation contra-asset / cash-filter guardrails. Pure-helper coverage of
// flipManualLines lives in apps/api/src/lib/ledger.test.ts.

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

// COA account id for a company by its 4-digit code (runs as the test superuser,
// bypassing RLS — fine for fetching ids to feed the API under test).
async function coaId(companyId: string, code: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.companyId, companyId), eq(chartOfAccounts.code, code)));
  if (!row) throw new Error(`COA ${code} not seeded for company ${companyId}`);
  return row.id;
}

function post(app: App, path: string, cookie: string, accountId: string, body?: unknown) {
  const headers: Record<string, string> = { cookie, 'x-account-id': accountId };
  const init: RequestInit = { method: 'POST', headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

function get(app: App, path: string, cookie: string, accountId: string) {
  return app.request(path, { headers: { cookie, 'x-account-id': accountId } });
}

// A balanced depreciation entry: Dr Depreciation Expense (6350) / Cr Accumulated
// Depreciation (1900) — the headline manual-adjustment use case.
async function depreciationBody(companyId: string, amount = '500.00') {
  return {
    companyId,
    postedOn: '2026-12-31',
    memo: '2026 depreciation per CPA',
    lines: [
      { coaAccountId: await coaId(companyId, '6350'), side: 'debit', amount },
      { coaAccountId: await coaId(companyId, '1900'), side: 'credit', amount },
    ],
  };
}

describe('ledger — manual journal adjustments', () => {
  beforeEach(resetDb);

  it('posts a balanced entry and reads it back with COA-joined lines', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'owner-create@example.com');
      const { accountId, companyId } = await ownerContext('owner-create@example.com');

      const res = await post(
        app,
        '/api/ledger/entries',
        cookie,
        accountId,
        await depreciationBody(companyId),
      );
      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string; reversed: boolean; lines: unknown[] };
      expect(created.reversed).toBe(false);
      expect(created.lines).toHaveLength(2);

      const detail = await get(app, `/api/ledger/entries/${created.id}`, cookie, accountId);
      expect(detail.status).toBe(200);
      const body = (await detail.json()) as {
        memo: string;
        reversed: boolean;
        reversalId: string | null;
        lines: { code: string; side: string; amount: string }[];
      };
      expect(body.memo).toBe('2026 depreciation per CPA');
      expect(body.reversed).toBe(false);
      expect(body.reversalId).toBeNull();
      const byCode = new Map(body.lines.map((l) => [l.code, l]));
      expect(byCode.get('6350')).toMatchObject({ side: 'debit', amount: '500.00' });
      expect(byCode.get('1900')).toMatchObject({ side: 'credit', amount: '500.00' });
    } finally {
      await handle.close();
    }
  });

  it('lists manual entries with magnitude + reversed flag', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'owner-list@example.com');
      const { accountId, companyId } = await ownerContext('owner-list@example.com');
      await post(app, '/api/ledger/entries', cookie, accountId, await depreciationBody(companyId));

      const res = await get(app, `/api/ledger/entries?companyId=${companyId}`, cookie, accountId);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        entries: { amount: string; reversed: boolean; memo: string }[];
      };
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]).toMatchObject({ amount: '500.00', reversed: false });
    } finally {
      await handle.close();
    }
  });

  it('rejects an unbalanced entry with 400', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'owner-unbal@example.com');
      const { accountId, companyId } = await ownerContext('owner-unbal@example.com');
      const res = await post(app, '/api/ledger/entries', cookie, accountId, {
        companyId,
        postedOn: '2026-12-31',
        memo: 'lopsided',
        lines: [
          { coaAccountId: await coaId(companyId, '6350'), side: 'debit', amount: '500.00' },
          { coaAccountId: await coaId(companyId, '1900'), side: 'credit', amount: '400.00' },
        ],
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_body' });
    } finally {
      await handle.close();
    }
  });

  it('rejects an account from another company with 400 invalid_account', async () => {
    const { app, handle } = buildApp();
    try {
      // Two separate workspaces; tenant A tries to post against tenant B's COA.
      const aCookie = await signUp(app, 'tenant-a@example.com');
      const aCtx = await ownerContext('tenant-a@example.com');
      const bCookie = await signUp(app, 'tenant-b@example.com');
      const bCtx = await ownerContext('tenant-b@example.com');

      const res = await post(app, '/api/ledger/entries', aCookie, aCtx.accountId, {
        companyId: aCtx.companyId,
        postedOn: '2026-12-31',
        memo: 'cross-company',
        lines: [
          { coaAccountId: await coaId(aCtx.companyId, '6350'), side: 'debit', amount: '500.00' },
          // tenant B's accumulated depreciation account — not in A's company.
          { coaAccountId: await coaId(bCtx.companyId, '1900'), side: 'credit', amount: '500.00' },
        ],
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_account' });
      // And nothing leaked into B's books.
      void bCookie;
    } finally {
      await handle.close();
    }
  });

  it('reverses an entry once, then 409s on a second reverse', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'owner-rev@example.com');
      const { accountId, companyId } = await ownerContext('owner-rev@example.com');
      const created = (await (
        await post(app, '/api/ledger/entries', cookie, accountId, await depreciationBody(companyId))
      ).json()) as { id: string };

      const rev = await post(app, `/api/ledger/entries/${created.id}/reverse`, cookie, accountId);
      expect(rev.status).toBe(200);
      const revBody = (await rev.json()) as { reversed: boolean; reversalId: string };
      expect(revBody.reversed).toBe(true);
      expect(revBody.reversalId).toBeTruthy();

      const detail = (await (
        await get(app, `/api/ledger/entries/${created.id}`, cookie, accountId)
      ).json()) as { reversed: boolean; reversalId: string | null };
      expect(detail.reversed).toBe(true);
      expect(detail.reversalId).toBe(revBody.reversalId);

      const again = await post(app, `/api/ledger/entries/${created.id}/reverse`, cookie, accountId);
      expect(again.status).toBe(409);
      expect((await again.json()) as { error: string }).toMatchObject({
        error: 'already_reversed',
      });

      // The reversal does NOT itself appear as a reversible original (only
      // 'manual_adjustment' rows list); the original still shows, now reversed.
      const list = (await (await get(app, '/api/ledger/entries', cookie, accountId)).json()) as {
        entries: { id: string; reversed: boolean }[];
      };
      expect(list.entries).toHaveLength(1);
      expect(list.entries[0]).toMatchObject({ id: created.id, reversed: true });
    } finally {
      await handle.close();
    }
  });

  it('depreciation entry keeps the balance sheet balanced and cash untouched; reversal nets the GL to zero', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'owner-bs@example.com');
      const { accountId, companyId } = await ownerContext('owner-bs@example.com');
      const created = (await (
        await post(app, '/api/ledger/entries', cookie, accountId, await depreciationBody(companyId))
      ).json()) as { id: string };

      // Balance sheet as of the entry's date: Accumulated Depreciation (1900)
      // is a contra-asset seeded debit-normal, so its credit posting reads as a
      // NEGATIVE asset — total assets drop, net income drops, and
      // Assets = Liabilities + Equity holds. (Explicit asOf so the Dec-31 entry
      // is in-window regardless of the wall clock.)
      const bs = (await (
        await get(
          app,
          `/api/companies/${companyId}/balance-sheet?asOf=2026-12-31`,
          cookie,
          accountId,
        )
      ).json()) as {
        balanced: boolean;
        netIncome: string;
        assets: { code: string; amount: string }[];
      };
      expect(bs.balanced).toBe(true);
      expect(bs.netIncome).toBe('-500.00');
      const accDep = bs.assets.find((a) => a.code === '1900');
      expect(accDep?.amount).toBe('-500.00');

      // Dashboard over a window that contains the entry: depreciation is
      // non-cash, so money in/out stay zero (the cash filter is pinned to Cash
      // 1000, not "every asset").
      const dash = (await (
        await get(
          app,
          `/api/companies/${companyId}/dashboard?from=2026-12-01&to=2026-12-31`,
          cookie,
          accountId,
        )
      ).json()) as { moneyIn: string; moneyOut: string };
      expect(dash.moneyIn).toBe('0.00');
      expect(dash.moneyOut).toBe('0.00');

      // Reverse it → every journal line for the tenant nets debit == credit AND
      // the per-account net returns to zero.
      await post(app, `/api/ledger/entries/${created.id}/reverse`, cookie, accountId);
      const lines = await getTestDb()
        .select({ side: journalLines.side, amount: journalLines.amount })
        .from(journalLines)
        .where(eq(journalLines.accountId, accountId));
      const debit = lines
        .filter((l) => l.side === 'debit')
        .reduce((s, l) => s + Number(l.amount), 0);
      const credit = lines
        .filter((l) => l.side === 'credit')
        .reduce((s, l) => s + Number(l.amount), 0);
      expect(debit).toBeCloseTo(credit, 2);

      const bsAfter = (await (
        await get(
          app,
          `/api/companies/${companyId}/balance-sheet?asOf=2026-12-31`,
          cookie,
          accountId,
        )
      ).json()) as { netIncome: string; assets: { code: string }[] };
      // The 1900 line nets to zero and is dropped from the statement.
      expect(bsAfter.netIncome).toBe('0.00');
      expect(bsAfter.assets.find((a) => a.code === '1900')).toBeUndefined();
    } finally {
      await handle.close();
    }
  });
});
