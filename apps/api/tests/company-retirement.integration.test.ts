import { authUser, chartOfAccounts, companies, memberships } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Company retirement — a business that has stopped trading, most often a sole
// proprietorship that incorporated.
//
// The invariants worth guarding, in order of how badly they'd hurt:
//   1. a retired company refuses NEW business from every posting route, not just
//      the ones that remembered to check;
//   2. but it still SETTLES what it was already owed — a customer paying an
//      invoice it had already sent. Without this, "retired" and "unpaid invoices
//      stay with the old business" are mutually exclusive, and the incorporation
//      handoff this is being built for becomes impossible;
//   3. reports keep working — the old books have to stay filable for years;
//   4. retiring the last active company is refused, because a workspace with no
//      active company strands every company-scoped screen.

const IN_YEAR = '2024-06-15';

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

type Ctx = {
  app: App;
  cookie: string;
  accountId: string;
  companyId: string;
  cashId: string;
  fuelId: string;
};

function req(ctx: Ctx, path: string, init?: RequestInit) {
  const headers: Record<string, string> = { cookie: ctx.cookie, 'x-account-id': ctx.accountId };
  if (init?.body) headers['content-type'] = 'application/json';
  return ctx.app.request(path, { ...init, headers: { ...headers, ...init?.headers } });
}

async function coaId(companyId: string, code: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.companyId, companyId), eq(chartOfAccounts.code, code)));
  if (!row) throw new Error(`COA ${code} not seeded for company ${companyId}`);
  return row.id;
}

// A second company, so retiring the first isn't refused as the last active one.
async function addSecondCompany(ctx: Ctx): Promise<string> {
  const res = await req(ctx, '/api/companies', {
    method: 'POST',
    body: JSON.stringify({ name: 'Second Co', businessType: 'sole_prop' }),
  });
  if (res.status !== 201) throw new Error(`second company failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

function retire(ctx: Ctx, companyId = ctx.companyId) {
  return req(ctx, `/api/companies/${companyId}/retire`, { method: 'POST' });
}

function spend(ctx: Ctx, on: string, amount: string, merchant: string) {
  return req(ctx, '/api/expenses', {
    method: 'POST',
    body: JSON.stringify({
      companyId: ctx.companyId,
      categoryAccountId: ctx.fuelId,
      paymentAccountId: ctx.cashId,
      amount,
      expenseDate: on,
      merchant,
    }),
  });
}

// An invoice sitting in `sent` — the case that makes the origination/settlement
// split necessary: the old business billed it, so the old business collects it.
async function sendInvoice(ctx: Ctx, number: string): Promise<string> {
  const contact = (await (
    await req(ctx, '/api/contacts', {
      method: 'POST',
      body: JSON.stringify({ companyId: ctx.companyId, name: 'Acme' }),
    })
  ).json()) as { id: string };

  const invRes = await req(ctx, '/api/invoices', {
    method: 'POST',
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId: contact.id,
      number,
      issueDate: IN_YEAR,
      dueDate: IN_YEAR,
      subtotal: '500.00',
      tax: '0.00',
      total: '500.00',
      lineItems: [
        {
          position: 1,
          description: 'Mowing',
          quantity: '1',
          unitPrice: '500.00',
          amount: '500.00',
        },
      ],
    }),
  });
  if (invRes.status !== 201) throw new Error(`invoice create failed: ${invRes.status}`);
  const invoice = (await invRes.json()) as { id: string };
  const sent = await req(ctx, `/api/invoices/${invoice.id}/mark-sent`, { method: 'POST' });
  if (sent.status !== 200) throw new Error(`mark-sent failed: ${sent.status}`);
  return invoice.id;
}

async function setup(email: string): Promise<{ ctx: Ctx; close: () => Promise<void> }> {
  const { app, handle } = buildApp();
  const cookie = await signUp(app, email);
  const { accountId, companyId } = await ownerContext(email);
  return {
    ctx: {
      app,
      cookie,
      accountId,
      companyId,
      cashId: await coaId(companyId, '1000'),
      fuelId: await coaId(companyId, '6200'),
    },
    close: () => handle.close(),
  };
}

describe('company retirement', () => {
  beforeEach(resetDb);

  it('refuses new business from every posting route', async () => {
    const { ctx, close } = await setup('cr-block@example.com');
    try {
      await addSecondCompany(ctx);
      expect((await retire(ctx)).status).toBe(200);

      // One table over the posting routes rather than a test each: this is the
      // assertion that catches a future route slipping past the funnel.
      const expense = await spend(ctx, '2026-03-01', '50.00', 'Fuel');
      const manualEntry = await req(ctx, '/api/ledger/entries', {
        method: 'POST',
        body: JSON.stringify({
          companyId: ctx.companyId,
          postedOn: '2026-03-01',
          memo: 'Adjustment after retirement',
          lines: [
            { coaAccountId: ctx.fuelId, side: 'debit', amount: '10.00' },
            { coaAccountId: ctx.cashId, side: 'credit', amount: '10.00' },
          ],
        }),
      });
      const ownerMoney = await req(ctx, '/api/owner-money', {
        method: 'POST',
        body: JSON.stringify({
          companyId: ctx.companyId,
          kind: 'draw',
          amount: '25.00',
          occurredOn: '2026-03-01',
        }),
      });

      for (const res of [expense, manualEntry, ownerMoney]) {
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: string; retiredAt: string };
        expect(body.error).toBe('company_retired');
        expect(body.retiredAt).toBeTruthy();
      }
    } finally {
      await close();
    }
  });

  it('still lets a retired company collect what it had already billed', async () => {
    const { ctx, close } = await setup('cr-settle@example.com');
    try {
      await addSecondCompany(ctx);
      const invoiceId = await sendInvoice(ctx, 'INV-SETTLE-1');
      expect((await retire(ctx)).status).toBe(200);

      // THE invariant that makes the incorporation handoff possible: the old
      // business billed this, so the old business banks the cheque.
      const paid = await req(ctx, `/api/invoices/${invoiceId}/mark-paid`, {
        method: 'POST',
        body: JSON.stringify({ method: 'cash', paidOn: '2026-03-01' }),
      });
      expect(paid.status).toBe(200);

      // ...while raising a NEW invoice is still refused.
      const contact = (await (
        await req(ctx, '/api/contacts', {
          method: 'POST',
          body: JSON.stringify({ companyId: ctx.companyId, name: 'Later Customer' }),
        })
      ).json()) as { id: string };
      const fresh = await req(ctx, '/api/invoices', {
        method: 'POST',
        body: JSON.stringify({
          companyId: ctx.companyId,
          contactId: contact.id,
          number: 'INV-AFTER-1',
          issueDate: '2026-03-01',
          dueDate: '2026-03-01',
          subtotal: '100.00',
          tax: '0.00',
          total: '100.00',
          lineItems: [
            {
              position: 1,
              description: 'New work',
              quantity: '1',
              unitPrice: '100.00',
              amount: '100.00',
            },
          ],
        }),
      });
      // The invoice row itself is created (no posting yet), but sending it —
      // which is what posts — must be refused.
      const created = (await fresh.json()) as { id?: string };
      if (created.id) {
        const sent = await req(ctx, `/api/invoices/${created.id}/mark-sent`, { method: 'POST' });
        expect(sent.status).toBe(409);
        expect(((await sent.json()) as { error: string }).error).toBe('company_retired');
      }
    } finally {
      await close();
    }
  });

  it('keeps serving reports so the final return can still be filed', async () => {
    const { ctx, close } = await setup('cr-reports@example.com');
    try {
      await addSecondCompany(ctx);
      await spend(ctx, IN_YEAR, '300.00', 'Fuel');
      const before = await (
        await req(ctx, `/api/companies/${ctx.companyId}/profit-loss?from=2024-01-01&to=2024-12-31`)
      ).json();

      expect((await retire(ctx)).status).toBe(200);

      // Byte-identical: retirement freezes the books, it does not hide them.
      const after = await (
        await req(ctx, `/api/companies/${ctx.companyId}/profit-loss?from=2024-01-01&to=2024-12-31`)
      ).json();
      expect(after).toEqual(before);

      const bs = await req(ctx, `/api/companies/${ctx.companyId}/balance-sheet?asOf=2024-12-31`);
      expect(bs.status).toBe(200);
      expect(((await bs.json()) as { balanced: boolean }).balanced).toBe(true);
    } finally {
      await close();
    }
  });

  it('refuses to retire the last active company', async () => {
    const { ctx, close } = await setup('cr-last@example.com');
    try {
      const res = await retire(ctx);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('last_active_company');

      // With somewhere else to work, the same call succeeds.
      const secondId = await addSecondCompany(ctx);
      expect((await retire(ctx)).status).toBe(200);
      // And now the second one is the last active, so it's protected in turn.
      const blocked = await retire(ctx, secondId);
      expect(blocked.status).toBe(409);
      expect(((await blocked.json()) as { error: string }).error).toBe('last_active_company');
    } finally {
      await close();
    }
  });

  it('un-retires, and reports retiredAt on the company list', async () => {
    const { ctx, close } = await setup('cr-unretire@example.com');
    try {
      await addSecondCompany(ctx);
      expect((await retire(ctx)).status).toBe(200);

      // Retired companies are still LISTED — filtering them here would let
      // pickActiveCompany silently swap in a different company's figures.
      const listed = (await (await req(ctx, '/api/companies')).json()) as {
        companies: { id: string; retiredAt: string | null }[];
      };
      const row = listed.companies.find((c) => c.id === ctx.companyId);
      expect(row?.retiredAt).toBeTruthy();

      expect(
        (await req(ctx, `/api/companies/${ctx.companyId}/unretire`, { method: 'POST' })).status,
      ).toBe(200);
      expect((await spend(ctx, '2026-03-01', '50.00', 'Back in business')).status).toBe(201);

      const again = await req(ctx, `/api/companies/${ctx.companyId}/unretire`, { method: 'POST' });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toBe('not_retired');
    } finally {
      await close();
    }
  });
});
