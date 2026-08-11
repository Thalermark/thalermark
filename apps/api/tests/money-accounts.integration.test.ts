import { authUser, chartOfAccounts, companies, journalLines, memberships } from '@thalermark/db';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { cashOnHand } from '../src/lib/ledger.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Money accounts (TMC-207) — a business with more than one place its money sits.
//
// The checks that matter here are the ones that LEAVE the system: a wrong answer
// in this feature is balanced, so a trial-balance check cannot see it. Each test
// below reconciles against something outside the posting it is testing — the
// dashboard total, the category the expense was filed under, or the account the
// money actually moved through on the way back out.

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

type Ctx = { app: App; cookie: string; accountId: string; companyId: string };

async function setup(app: App, email: string): Promise<Omit<Ctx, 'app'>> {
  const cookie = await signUp(app, email);
  const { accountId, companyId } = await ownerContext(email);
  return { cookie, accountId, companyId };
}

async function addAccount(
  ctx: Ctx,
  name: string,
  kind: string,
): Promise<{ id: string; code: string }> {
  const res = await send(ctx.app, 'POST', '/api/money-accounts', ctx.cookie, ctx.accountId, {
    companyId: ctx.companyId,
    name,
    kind,
  });
  if (res.status !== 201) throw new Error(`add account failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; code: string };
}

// Straight to the chart: there is no list endpoint, and these ids are fixtures
// rather than anything under test.
async function coaId(ctx: Ctx, code: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.companyId, ctx.companyId), eq(chartOfAccounts.code, code)));
  if (!row) throw new Error(`COA ${code} not found`);
  return row.id;
}

describe('money accounts — more than one place the money sits', () => {
  beforeEach(resetDb);

  it('seeds a primary money account and allocates new ones inside their bands', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx: Ctx = { app, ...(await setup(app, 'bands@example.com')) };

      const listed = await send(
        app,
        'GET',
        `/api/money-accounts?companyId=${ctx.companyId}`,
        ctx.cookie,
        ctx.accountId,
      );
      expect(listed.status).toBe(200);
      const initial = (await listed.json()) as { moneyAccounts: { code: string; kind: string }[] };
      // The seed ships exactly one, and it must be marked — a company created
      // after the migration would otherwise have no money account at all and
      // cash on hand would read zero for a business with money in the bank.
      expect(initial.moneyAccounts).toHaveLength(1);
      expect(initial.moneyAccounts[0]?.code).toBe('1000');
      expect(initial.moneyAccounts[0]?.kind).toBe('cash');

      const checking = await addAccount(ctx, 'Chase Business Checking', 'checking');
      const savings = await addAccount(ctx, 'Rainy Day', 'savings');
      const card = await addAccount(ctx, 'Fuel Card', 'credit_card');

      // Asset kinds sort directly under Cash; a card lives in the liability band.
      expect(checking.code).toBe('1001');
      expect(savings.code).toBe('1002');
      expect(card.code).toBe('2100');
    } finally {
      await handle.close();
    }
  });

  it('counts every bank account toward cash on hand, and no credit card', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx: Ctx = { app, ...(await setup(app, 'onhand@example.com')) };
      const checking = await addAccount(ctx, 'Checking', 'checking');
      const card = await addAccount(ctx, 'Card', 'credit_card');

      // Money in, into the second bank account.
      await send(app, 'POST', '/api/owner-money', ctx.cookie, ctx.accountId, {
        companyId: ctx.companyId,
        kind: 'contribution',
        amount: '1000.00',
        occurredOn: '2026-03-01',
        moneyAccountId: checking.id,
      });

      const fuel = await coaId(ctx, '6100');
      // Spent on the CARD. This is a real cost, but no cash has moved: the
      // business owes the card issuer instead.
      await send(app, 'POST', '/api/expenses', ctx.cookie, ctx.accountId, {
        companyId: ctx.companyId,
        categoryAccountId: fuel,
        paymentAccountId: card.id,
        amount: '250.00',
        expenseDate: '2026-03-02',
        merchant: 'Fuel',
      });

      const onHand = await cashOnHand(getTestDb(), {
        accountId: ctx.accountId,
        companyId: ctx.companyId,
      });
      // 1000 in checking, untouched by the card spend. If the card counted, this
      // would read 750 — the business would look poorer for borrowing; if cash
      // on hand only ever looked at account 1000, it would read 0.00 and the
      // dashboard would report a business with money in the bank as broke.
      expect(onHand).toBe('1000.00');
    } finally {
      await handle.close();
    }
  });

  // The double-count guard, and the reason the statement goes through Bills.
  it('expenses a card purchase exactly once across the whole statement cycle', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx: Ctx = { app, ...(await setup(app, 'cardloop@example.com')) };
      const checking = await addAccount(ctx, 'Checking', 'checking');
      const card = await addAccount(ctx, 'Chase Card', 'credit_card');
      const fuel = await coaId(ctx, '6100');

      await send(app, 'POST', '/api/expenses', ctx.cookie, ctx.accountId, {
        companyId: ctx.companyId,
        categoryAccountId: fuel,
        paymentAccountId: card.id,
        amount: '150.00',
        expenseDate: '2026-03-02',
        merchant: 'Fuel',
      });

      // The statement arrives. Recorded as a bill owed to Chase, categorised as
      // the CARD — not as an expense, which is the mistake this shape prevents.
      const vendor = await send(app, 'POST', '/api/contacts', ctx.cookie, ctx.accountId, {
        companyId: ctx.companyId,
        name: 'Chase',
        isVendor: true,
      });
      const vendorId = ((await vendor.json()) as { id: string }).id;

      const billRes = await send(app, 'POST', '/api/bills', ctx.cookie, ctx.accountId, {
        companyId: ctx.companyId,
        contactId: vendorId,
        categoryAccountId: card.id,
        amount: '150.00',
        billDate: '2026-03-31',
        dueDate: '2026-04-15',
      });
      expect(billRes.status).toBe(201);
      const billId = ((await billRes.json()) as { id: string }).id;

      const paid = await send(
        app,
        'POST',
        `/api/bills/${billId}/mark-paid`,
        ctx.cookie,
        ctx.accountId,
        { method: 'other', paidOn: '2026-04-10', paymentAccountId: checking.id },
      );
      expect(paid.status).toBe(200);

      // Signed balance on one account, straight off the ledger.
      const balanceOf = async (code: string): Promise<number> => {
        const [row] = await getTestDb()
          .select({
            balance: sql<string>`coalesce(sum(case when ${journalLines.side} = 'debit' then ${journalLines.amount} else -${journalLines.amount} end), 0)::numeric(15,2)`,
          })
          .from(journalLines)
          .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalLines.coaAccountId))
          .where(and(eq(chartOfAccounts.companyId, ctx.companyId), eq(chartOfAccounts.code, code)));
        return Number(row?.balance ?? '0');
      };

      // Fuel expensed ONCE. If the statement had been categorised as an expense
      // it would read 300 — the classic double-count.
      expect(await balanceOf('6100')).toBe(150);
      // The card is back to zero: spent 150, statement cleared it.
      expect(await balanceOf('2100')).toBe(0);
      // The cash actually left checking, and only once.
      expect(await balanceOf('1001')).toBe(-150);
    } finally {
      await handle.close();
    }
  });

  // The failure the persisted columns exist to prevent.
  it('reverses a deleted card expense against the card, not against cash', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx: Ctx = { app, ...(await setup(app, 'reversal@example.com')) };
      const card = await addAccount(ctx, 'Card', 'credit_card');
      const fuel = await coaId(ctx, '6100');

      const created = await send(app, 'POST', '/api/expenses', ctx.cookie, ctx.accountId, {
        companyId: ctx.companyId,
        categoryAccountId: fuel,
        paymentAccountId: card.id,
        amount: '80.00',
        expenseDate: '2026-05-02',
        merchant: 'Fuel',
      });
      const expenseId = ((await created.json()) as { id: string }).id;

      await send(app, 'DELETE', `/api/expenses/${expenseId}`, ctx.cookie, ctx.accountId);

      const onHand = await cashOnHand(getTestDb(), {
        accountId: ctx.accountId,
        companyId: ctx.companyId,
      });
      // If the reversal had defaulted to cash, the card would stay credited and
      // cash would be DEBITED 80 — a perfectly balanced entry that invents money
      // the business never received. Cash never moved, so it is still zero.
      expect(onHand).toBe('0.00');
    } finally {
      await handle.close();
    }
  });

  it('refuses an account money cannot move through, and refuses archiving the primary', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx: Ctx = { app, ...(await setup(app, 'guards@example.com')) };
      const fuel = await coaId(ctx, '6100');
      const accumDep = await coaId(ctx, '1900');

      // Accumulated Depreciation is an ASSET, so the old account_type test would
      // have accepted it. "Paid for fuel out of Accumulated Depreciation" posts a
      // balanced entry that is nonsense.
      const bad = await send(app, 'POST', '/api/expenses', ctx.cookie, ctx.accountId, {
        companyId: ctx.companyId,
        categoryAccountId: fuel,
        paymentAccountId: accumDep,
        amount: '10.00',
        expenseDate: '2026-05-02',
        merchant: 'Fuel',
      });
      expect(bad.status).toBe(400);

      // The primary is the fallback every unset money column resolves to.
      const primaryId = await coaId(ctx, '1000');
      const refused = await send(
        app,
        'POST',
        `/api/money-accounts/${primaryId}/archive`,
        ctx.cookie,
        ctx.accountId,
      );
      expect(refused.status).toBe(409);
    } finally {
      await handle.close();
    }
  });

  it('keeps an archived account out of the pickers but still on the books', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx: Ctx = { app, ...(await setup(app, 'archive@example.com')) };
      const savings = await addAccount(ctx, 'Old Savings', 'savings');

      await send(app, 'POST', '/api/owner-money', ctx.cookie, ctx.accountId, {
        companyId: ctx.companyId,
        kind: 'contribution',
        amount: '500.00',
        occurredOn: '2026-03-01',
        moneyAccountId: savings.id,
      });

      const archived = await send(
        app,
        'POST',
        `/api/money-accounts/${savings.id}/archive`,
        ctx.cookie,
        ctx.accountId,
      );
      expect(archived.status).toBe(200);

      const listed = await send(
        app,
        'GET',
        `/api/money-accounts?companyId=${ctx.companyId}`,
        ctx.cookie,
        ctx.accountId,
      );
      const body = (await listed.json()) as { moneyAccounts: { id: string }[] };
      expect(body.moneyAccounts.map((a) => a.id)).not.toContain(savings.id);

      // ...but the money is still there. Hiding an account from a picker must
      // never hide its balance from the books.
      const onHand = await cashOnHand(getTestDb(), {
        accountId: ctx.accountId,
        companyId: ctx.companyId,
      });
      expect(onHand).toBe('500.00');
    } finally {
      await handle.close();
    }
  });
});
