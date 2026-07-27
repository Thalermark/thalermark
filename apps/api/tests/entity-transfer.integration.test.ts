import {
  authUser,
  capitalPurchases,
  chartOfAccounts,
  companies,
  memberships,
} from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { sweepDepreciation } from '../src/lib/depreciation.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// The incorporation handoff, end to end: a sole proprietor's books handed to a
// new corporation.
//
// The invariants, in order of how badly they'd hurt:
//   1. the predecessor's balance sheet goes to EXACTLY zero and still balances,
//      while its stub-period P&L survives untouched for the final Schedule C —
//      this is the whole reason no partial-year close is needed;
//   2. the successor opens with the predecessor's closing position, account for
//      account;
//   3. a transferred asset resumes its schedule rather than restarting, and its
//      loan is visible to the successor's loanBalance (which is derived per
//      purchase, so an aggregate posting would be invisible to it);
//   4. contra accounts survive the flip — 1900 carries a credit balance on a
//      debit-normal account, so a naive "credit the assets" would double it.

const EFFECTIVE = '2026-07-01';

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

type Ctx = { app: App; cookie: string; accountId: string; companyId: string };

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
  if (!row) throw new Error(`COA ${code} not seeded for ${companyId}`);
  return row.id;
}

type BalanceSheet = {
  assets: { code: string; amount: string }[];
  liabilities: { code: string; amount: string }[];
  equity: { code: string; amount: string }[];
  netIncome: string;
  totalAssets: string;
  totalEquity: string;
  balanced: boolean;
};

async function balanceSheet(ctx: Ctx, companyId: string, asOf: string): Promise<BalanceSheet> {
  const res = await req(ctx, `/api/companies/${companyId}/balance-sheet?asOf=${asOf}`);
  return (await res.json()) as BalanceSheet;
}

// A sole proprietor mid-life: cash in the bank, an expense on the books (so the
// stub-period P&L has something in it), and a financed mower part-way through
// depreciation.
async function seedSoleProp(ctx: Ctx) {
  await req(ctx, '/api/owner-money', {
    method: 'POST',
    body: JSON.stringify({
      companyId: ctx.companyId,
      kind: 'contribution',
      amount: '20000.00',
      occurredOn: '2024-01-05',
    }),
  });

  await req(ctx, '/api/expenses', {
    method: 'POST',
    body: JSON.stringify({
      companyId: ctx.companyId,
      categoryAccountId: await coaId(ctx.companyId, '6200'),
      paymentAccountId: await coaId(ctx.companyId, '1000'),
      amount: '500.00',
      expenseDate: '2026-03-01',
      merchant: 'Fuel',
    }),
  });

  const purchase = await req(ctx, '/api/purchases', {
    method: 'POST',
    body: JSON.stringify({
      companyId: ctx.companyId,
      description: 'Mower',
      amount: '6000.00',
      purchaseDate: '2024-03-01',
      funding: 'financed',
      downPayment: '1000.00',
      taxTreatment: 'spread',
      usefulLifeYears: 5,
    }),
  });
  if (purchase.status !== 201) throw new Error(`purchase failed: ${purchase.status}`);
  return ((await purchase.json()) as { id: string }).id;
}

const handoff = (ctx: Ctx, body?: Record<string, unknown>) =>
  req(ctx, '/api/entity-transfers', {
    method: 'POST',
    body: JSON.stringify({
      predecessorCompanyId: ctx.companyId,
      name: 'Newco Inc',
      businessType: 's_corp',
      effectiveDate: EFFECTIVE,
      ...body,
    }),
  });

async function setup(email: string): Promise<{ ctx: Ctx; close: () => Promise<void> }> {
  const { app, handle } = buildApp();
  const cookie = await signUp(app, email);
  const { accountId, companyId } = await ownerContext(email);
  return { ctx: { app, cookie, accountId, companyId }, close: () => handle.close() };
}

describe('incorporation handoff', () => {
  beforeEach(resetDb);

  it('empties the predecessor and opens the successor with its position', async () => {
    const { ctx, close } = await setup('et-core@example.com');
    try {
      await seedSoleProp(ctx);
      const before = await balanceSheet(ctx, ctx.companyId, '2026-06-30');
      expect(before.balanced).toBe(true);

      const res = await handoff(ctx);
      expect(res.status).toBe(201);
      const { successorCompanyId } = (await res.json()) as { successorCompanyId: string };

      // 1. The predecessor is empty and still balances. Total equity lands at
      //    exactly zero because the plug equals A − L, which the identity says
      //    is equity + net income.
      const after = await balanceSheet(ctx, ctx.companyId, EFFECTIVE);
      expect(after.balanced).toBe(true);
      expect(after.totalAssets).toBe('0.00');
      expect(after.totalEquity).toBe('0.00');

      // 2. The stub-period P&L is untouched — this is why no partial close is
      //    needed, and it's what the final Schedule C is filed from.
      const pl = (await (
        await req(ctx, `/api/companies/${ctx.companyId}/profit-loss?from=2026-01-01&to=2026-06-30`)
      ).json()) as { totalExpenses: string };
      expect(pl.totalExpenses).toBe('500.00');

      // 3. The successor opens with what the predecessor closed with.
      const opened = await balanceSheet(ctx, successorCompanyId, EFFECTIVE);
      expect(opened.balanced).toBe(true);
      expect(opened.totalAssets).toBe(before.totalAssets);
    } finally {
      await close();
    }
  });

  it('carries a contra account across without doubling it', async () => {
    const { ctx, close } = await setup('et-contra@example.com');
    try {
      await seedSoleProp(ctx);
      const before = await balanceSheet(ctx, ctx.companyId, '2026-06-30');
      const beforeAccum = before.assets.find((a) => a.code === '1900')?.amount;

      const { successorCompanyId } = (await (await handoff(ctx)).json()) as {
        successorCompanyId: string;
      };
      const opened = await balanceSheet(ctx, successorCompanyId, EFFECTIVE);

      // 1900 is a contra-asset seeded debit-normal but carrying a credit
      // balance. Flipping on the RAW balance carries it across unchanged;
      // "credit every asset" would have doubled it and broken the sheet.
      expect(opened.assets.find((a) => a.code === '1900')?.amount).toBe(beforeAccum);
      expect(opened.assets.find((a) => a.code === '1500')?.amount).toBe('6000.00');
      expect(opened.balanced).toBe(true);
    } finally {
      await close();
    }
  });

  it('recreates the asset at carried basis and keeps its loan visible', async () => {
    const { ctx, close } = await setup('et-asset@example.com');
    try {
      const originalId = await seedSoleProp(ctx);
      // Depreciation reaches the books through the daily sweep, so run it —
      // otherwise nothing has accumulated and there is no carryover to test.
      await sweepDepreciation({
        bootstrapDb: getTestDb(),
        tenantDb: getTestDb(),
        now: new Date('2026-06-01T12:00:00Z'),
      });
      const owedBefore = (await (await req(ctx, `/api/purchases/${originalId}`)).json()) as {
        owing: string;
      };

      const { successorCompanyId } = (await (await handoff(ctx)).json()) as {
        successorCompanyId: string;
      };

      const [carried] = await getTestDb()
        .select()
        .from(capitalPurchases)
        .where(eq(capitalPurchases.companyId, successorCompanyId));
      // Carryover basis: original cost, original date, original life. Not net
      // book value with a fresh clock.
      expect(carried?.amount).toBe('6000.00');
      expect(carried?.purchaseDate).toBe('2024-03-01');
      expect(Number(carried?.usefulLifeYears)).toBe(5);
      expect(carried?.transferredFromPurchaseId).toBe(originalId);
      expect(Number(carried?.depreciationStartYear)).toBe(2026);
      expect(Number(carried?.priorAccumulatedDepreciation)).toBeGreaterThan(0);

      // The loan followed, and — the subtle part — it's visible to the
      // successor's loanBalance, which derives from entries tagged with the
      // purchase id. An aggregate Cr 2700 would have been invisible here.
      const carriedDetail = (await (await req(ctx, `/api/purchases/${carried?.id}`)).json()) as {
        owing: string;
      };
      expect(carriedDetail.owing).toBe(owedBefore.owing);

      // ...and the predecessor now owes nothing on it.
      const originalDetail = (await (await req(ctx, `/api/purchases/${originalId}`)).json()) as {
        owing: string;
      };
      expect(originalDetail.owing).toBe('0.00');
    } finally {
      await close();
    }
  });

  it('retires the predecessor and copies its setup', async () => {
    const { ctx, close } = await setup('et-retire@example.com');
    try {
      await seedSoleProp(ctx);
      await req(ctx, '/api/contacts', {
        method: 'POST',
        body: JSON.stringify({ companyId: ctx.companyId, name: 'Acme' }),
      });

      const body = (await (await handoff(ctx)).json()) as {
        successorCompanyId: string;
        copied: { contacts: number };
      };
      expect(body.copied.contacts).toBe(1);

      const [pred] = await getTestDb()
        .select({ retiredAt: companies.retiredAt })
        .from(companies)
        .where(eq(companies.id, ctx.companyId));
      expect(pred?.retiredAt).not.toBeNull();

      // The predecessor takes no new business...
      const blocked = await req(ctx, '/api/expenses', {
        method: 'POST',
        body: JSON.stringify({
          companyId: ctx.companyId,
          categoryAccountId: await coaId(ctx.companyId, '6200'),
          paymentAccountId: await coaId(ctx.companyId, '1000'),
          amount: '10.00',
          expenseDate: '2026-08-01',
          merchant: 'Too late',
        }),
      });
      expect(blocked.status).toBe(409);

      // ...but its reports still work, because the final return depends on them.
      const bs = await req(ctx, `/api/companies/${ctx.companyId}/balance-sheet?asOf=2026-06-30`);
      expect(bs.status).toBe(200);
    } finally {
      await close();
    }
  });

  it('leaves receivables behind when the old business keeps collecting', async () => {
    const { ctx, close } = await setup('et-ar@example.com');
    try {
      await seedSoleProp(ctx);
      const contact = (await (
        await req(ctx, '/api/contacts', {
          method: 'POST',
          body: JSON.stringify({ companyId: ctx.companyId, name: 'Acme' }),
        })
      ).json()) as { id: string };
      const inv = (await (
        await req(ctx, '/api/invoices', {
          method: 'POST',
          body: JSON.stringify({
            companyId: ctx.companyId,
            contactId: contact.id,
            number: 'INV-1',
            issueDate: '2026-05-01',
            dueDate: '2026-06-01',
            subtotal: '900.00',
            tax: '0.00',
            total: '900.00',
            lineItems: [
              {
                position: 1,
                description: 'Mowing',
                quantity: '1',
                unitPrice: '900.00',
                amount: '900.00',
              },
            ],
          }),
        })
      ).json()) as { id: string };
      await req(ctx, `/api/invoices/${inv.id}/mark-sent`, { method: 'POST' });

      // mark-sent posts at `now` rather than the issue date, so the receivable
      // only exists from today. Date this handoff after it, or there would be no
      // A/R on the books to leave behind.
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const { successorCompanyId } = (await (
        await handoff(ctx, { openInvoicesDisposition: 'stay', effectiveDate: tomorrow })
      ).json()) as { successorCompanyId: string };

      // The receivable stayed, so the predecessor is NOT empty — it still has
      // the 900 owed to it, matched by equity it hasn't handed over.
      const pred = await balanceSheet(ctx, ctx.companyId, tomorrow);
      expect(pred.balanced).toBe(true);
      expect(pred.assets.find((a) => a.code === '1200')?.amount).toBe('900.00');
      // ...and the successor opened without it.
      const succ = await balanceSheet(ctx, successorCompanyId, tomorrow);
      expect(succ.assets.some((a) => a.code === '1200')).toBe(false);

      // The old business can still bank the cheque — the settlement carve-out
      // in the retirement lock exists precisely for this.
      const paid = await req(ctx, `/api/invoices/${inv.id}/mark-paid`, {
        method: 'POST',
        body: JSON.stringify({ method: 'cash', paidOn: '2026-08-15' }),
      });
      expect(paid.status).toBe(200);
    } finally {
      await close();
    }
  });

  it('refuses to hand off a company that has already been retired', async () => {
    const { ctx, close } = await setup('et-twice@example.com');
    try {
      await seedSoleProp(ctx);
      expect((await handoff(ctx)).status).toBe(201);

      const again = await handoff(ctx, { name: 'Thirdco' });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toBe('already_retired');
    } finally {
      await close();
    }
  });

  // --- Undoing a handoff ----------------------------------------------------

  it('puts both businesses back the way they were', async () => {
    const { ctx, close } = await setup('et-undo@example.com');
    try {
      await seedSoleProp(ctx);
      const before = await balanceSheet(ctx, ctx.companyId, '2026-06-30');

      const { transferId, successorCompanyId } = (await (await handoff(ctx)).json()) as {
        transferId: string;
        successorCompanyId: string;
      };
      // Sanity: it really did empty out first.
      expect((await balanceSheet(ctx, ctx.companyId, EFFECTIVE)).totalAssets).toBe('0.00');

      const undo = await req(ctx, `/api/entity-transfers/${transferId}/reverse`, {
        method: 'POST',
      });
      expect(undo.status).toBe(200);

      // The predecessor is trading again, with the position it had.
      const restored = await balanceSheet(ctx, ctx.companyId, '2026-06-30');
      expect(restored.balanced).toBe(true);
      expect(restored.totalAssets).toBe(before.totalAssets);
      expect(restored.totalEquity).toBe(before.totalEquity);
      const [predecessor] = await getTestDb()
        .select()
        .from(companies)
        .where(eq(companies.id, ctx.companyId));
      expect(predecessor?.retiredAt).toBeNull();

      // The successor is emptied and closed — not deleted. The ledger is
      // append-only, so the entries stay and simply net to nothing.
      const emptied = await balanceSheet(ctx, successorCompanyId, '2026-06-30');
      expect(emptied.balanced).toBe(true);
      expect(emptied.totalAssets).toBe('0.00');
      expect(emptied.totalEquity).toBe('0.00');
      const [successor] = await getTestDb()
        .select()
        .from(companies)
        .where(eq(companies.id, successorCompanyId));
      expect(successor?.retiredAt).not.toBeNull();
    } finally {
      await close();
    }
  });

  it('gives the loan back to the business that took it out', async () => {
    const { ctx, close } = await setup('et-undo-loan@example.com');
    try {
      const originalId = await seedSoleProp(ctx);
      const owedBefore = (await (await req(ctx, `/api/purchases/${originalId}`)).json()) as {
        owing: string;
      };
      expect(Number(owedBefore.owing)).toBeGreaterThan(0);

      const { transferId, successorCompanyId } = (await (await handoff(ctx)).json()) as {
        transferId: string;
        successorCompanyId: string;
      };
      await req(ctx, `/api/entity-transfers/${transferId}/reverse`, { method: 'POST' });

      // The subtle one. The loan leg was tagged with the purchase id on the way
      // out so loanBalance would read zero; the reversal has to carry the SAME
      // tag or the debt never comes back.
      const after = (await (await req(ctx, `/api/purchases/${originalId}`)).json()) as {
        owing: string;
      };
      expect(after.owing).toBe(owedBefore.owing);

      // The carried copy is gone from the successor's asset list.
      const carried = await getTestDb()
        .select()
        .from(capitalPurchases)
        .where(eq(capitalPurchases.companyId, successorCompanyId));
      expect(carried).toHaveLength(1);
      expect(carried[0]?.deletedAt).not.toBeNull();
    } finally {
      await close();
    }
  });

  it('undoes depreciation the sweep posted rather than refusing over it', async () => {
    const { ctx, close } = await setup('et-undo-depr@example.com');
    try {
      await seedSoleProp(ctx);
      const { transferId, successorCompanyId } = (await (await handoff(ctx)).json()) as {
        transferId: string;
        successorCompanyId: string;
      };

      // The nightly sweep runs and writes down the carried asset. Nobody asked
      // it to, so it must not be able to take the undo away. Dated into 2027
      // because the sweep only posts years that have finished, and the
      // successor's first depreciable year is the one it took over in.
      await sweepDepreciation({
        bootstrapDb: getTestDb(),
        tenantDb: getTestDb(),
        now: new Date('2027-01-02T12:00:00Z'),
      });

      const undo = await req(ctx, `/api/entity-transfers/${transferId}/reverse`, {
        method: 'POST',
      });
      expect(undo.status).toBe(200);
      expect(((await undo.json()) as { depreciationReversed: number }).depreciationReversed).toBe(
        1,
      );

      const emptied = await balanceSheet(ctx, successorCompanyId, '2027-12-31');
      expect(emptied.balanced).toBe(true);
      expect(emptied.totalAssets).toBe('0.00');
    } finally {
      await close();
    }
  });

  it('refuses once the new business has traded', async () => {
    const { ctx, close } = await setup('et-undo-traded@example.com');
    try {
      await seedSoleProp(ctx);
      const { transferId, successorCompanyId } = (await (await handoff(ctx)).json()) as {
        transferId: string;
        successorCompanyId: string;
      };

      const expense = await req(ctx, '/api/expenses', {
        method: 'POST',
        body: JSON.stringify({
          companyId: successorCompanyId,
          categoryAccountId: await coaId(successorCompanyId, '6200'),
          paymentAccountId: await coaId(successorCompanyId, '1000'),
          amount: '75.00',
          expenseDate: '2026-07-05',
          merchant: 'Fuel',
        }),
      });
      expect(expense.status).toBe(201);

      const undo = await req(ctx, `/api/entity-transfers/${transferId}/reverse`, {
        method: 'POST',
      });
      expect(undo.status).toBe(409);
      expect(((await undo.json()) as { error: string }).error).toBe('successor_has_activity');

      // ...and the page is told BEFORE offering the button.
      const current = (await (
        await req(ctx, `/api/entity-transfers/current?companyId=${successorCompanyId}`)
      ).json()) as { transfer: { reversible: boolean } };
      expect(current.transfer.reversible).toBe(false);
    } finally {
      await close();
    }
  });

  it('will not undo the same handoff twice', async () => {
    const { ctx, close } = await setup('et-undo-twice@example.com');
    try {
      await seedSoleProp(ctx);
      const { transferId } = (await (await handoff(ctx)).json()) as { transferId: string };
      const path = `/api/entity-transfers/${transferId}/reverse`;
      expect((await req(ctx, path, { method: 'POST' })).status).toBe(200);

      const again = await req(ctx, path, { method: 'POST' });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toBe('already_reversed');
    } finally {
      await close();
    }
  });
});
