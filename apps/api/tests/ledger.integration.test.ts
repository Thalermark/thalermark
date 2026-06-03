import {
  authUser,
  chartOfAccounts,
  companies,
  journalEntries,
  journalLines,
  memberships,
} from '@thalermark/db';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { getTestDb, resetDb } from './test-helper.js';

// L2 — ledger posting wired into invoice state transitions. Asserts the full
// end-to-end chain (signup → COA seeded → invoice create → transition →
// balanced journal entry posted) and tenant isolation. Pure-policy coverage
// of `invoicePostingLines` lives in apps/api/src/lib/ledger.test.ts.

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
  const handle = createApiDatabase(url);
  const auth = createApiAuth(handle.db, { ...testEnv, databaseUrl: url });
  const app = createApp({ auth, db: handle.db, publicAppUrl: testEnv.publicAppUrl });
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
    body: JSON.stringify({ companyId, name: 'Wile E. Coyote' }),
  });
  if (res.status !== 201) throw new Error(`customer create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

function invoiceBody(companyId: string, customerId: string, number: string, withTax = true) {
  return {
    companyId,
    customerId,
    number,
    issueDate: '2026-05-28',
    dueDate: '2026-06-27',
    subtotal: '100.00',
    tax: withTax ? '8.25' : '0',
    total: withTax ? '108.25' : '100.00',
    lineItems: [
      {
        position: 1,
        description: 'Service',
        quantity: '1',
        unitPrice: '100.00',
        amount: '100.00',
      },
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
  withTax = true,
): Promise<string> {
  const res = await app.request('/api/invoices', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify(invoiceBody(companyId, customerId, number, withTax)),
  });
  if (res.status !== 201) throw new Error(`invoice create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function entriesFor(invoiceId: string) {
  const db = getTestDb();
  return db.select().from(journalEntries).where(eq(journalEntries.sourceEntityId, invoiceId));
}

async function linesFor(entryId: string) {
  const db = getTestDb();
  const lines = await db
    .select({
      id: journalLines.id,
      side: journalLines.side,
      amount: journalLines.amount,
      code: chartOfAccounts.code,
    })
    .from(journalLines)
    .leftJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
    .where(eq(journalLines.journalEntryId, entryId));
  return lines;
}

describe('ledger postings — invoice transitions', () => {
  beforeEach(resetDb);

  it('mark-sent posts Dr AR / Cr Revenue / Cr Sales Tax Payable (taxed)', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'sender-tax@example.com');
      const { accountId, companyId } = await userContext('sender-tax@example.com');
      const customerId = await createCustomer(ctx.app, cookie, accountId, companyId);
      const invoiceId = await createInvoice(
        ctx.app,
        cookie,
        accountId,
        companyId,
        customerId,
        'L-1',
        true,
      );

      const res = await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);

      const entries = await entriesFor(invoiceId);
      expect(entries).toHaveLength(1);
      const lines = await linesFor(entries[0]?.id as string);
      expect(lines).toHaveLength(3);
      const byCode = new Map(lines.map((l) => [l.code, l]));
      expect(byCode.get('1200')).toMatchObject({ side: 'debit', amount: '108.25' });
      expect(byCode.get('4000')).toMatchObject({ side: 'credit', amount: '100.00' });
      expect(byCode.get('2200')).toMatchObject({ side: 'credit', amount: '8.25' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('mark-sent skips the Sales Tax line when tax = 0', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'sender-notax@example.com');
      const { accountId, companyId } = await userContext('sender-notax@example.com');
      const customerId = await createCustomer(ctx.app, cookie, accountId, companyId);
      const invoiceId = await createInvoice(
        ctx.app,
        cookie,
        accountId,
        companyId,
        customerId,
        'L-2',
        false,
      );

      await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });

      const entries = await entriesFor(invoiceId);
      const lines = await linesFor(entries[0]?.id as string);
      expect(lines).toHaveLength(2);
      const codes = lines.map((l) => l.code).sort();
      expect(codes).toEqual(['1200', '4000']);
    } finally {
      await ctx.handle.close();
    }
  });

  it('mark-paid sent→paid posts Dr Cash / Cr AR (two entries total per invoice)', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'payer-sent@example.com');
      const { accountId, companyId } = await userContext('payer-sent@example.com');
      const customerId = await createCustomer(ctx.app, cookie, accountId, companyId);
      const invoiceId = await createInvoice(
        ctx.app,
        cookie,
        accountId,
        companyId,
        customerId,
        'L-3',
        true,
      );

      await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      await ctx.app.request(`/api/invoices/${invoiceId}/mark-paid`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'cash' }),
      });

      const entries = await entriesFor(invoiceId);
      expect(entries).toHaveLength(2);
      // Entries ordered by uuidv7 (time-sortable); the second one is mark-paid.
      const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : 1));
      const lines = await linesFor(sorted[1]?.id as string);
      expect(lines).toHaveLength(2);
      const byCode = new Map(lines.map((l) => [l.code, l]));
      expect(byCode.get('1000')).toMatchObject({ side: 'debit', amount: '108.25' });
      expect(byCode.get('1200')).toMatchObject({ side: 'credit', amount: '108.25' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('mark-paid draft→paid posts Dr Cash / Cr Revenue / Cr Tax — no AR', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'payer-direct@example.com');
      const { accountId, companyId } = await userContext('payer-direct@example.com');
      const customerId = await createCustomer(ctx.app, cookie, accountId, companyId);
      const invoiceId = await createInvoice(
        ctx.app,
        cookie,
        accountId,
        companyId,
        customerId,
        'L-4',
        true,
      );

      const res = await ctx.app.request(`/api/invoices/${invoiceId}/mark-paid`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'cash' }),
      });
      expect(res.status).toBe(200);

      const entries = await entriesFor(invoiceId);
      expect(entries).toHaveLength(1);
      const lines = await linesFor(entries[0]?.id as string);
      const codes = lines.map((l) => l.code).sort();
      expect(codes).toEqual(['1000', '2200', '4000']);
      expect(codes).not.toContain('1200');
      const byCode = new Map(lines.map((l) => [l.code, l]));
      expect(byCode.get('1000')).toMatchObject({ side: 'debit', amount: '108.25' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('void sent→voided posts the reversal of mark-sent', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'voider-sent@example.com');
      const { accountId, companyId } = await userContext('voider-sent@example.com');
      const customerId = await createCustomer(ctx.app, cookie, accountId, companyId);
      const invoiceId = await createInvoice(
        ctx.app,
        cookie,
        accountId,
        companyId,
        customerId,
        'L-5',
        true,
      );

      await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      await ctx.app.request(`/api/invoices/${invoiceId}/void`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });

      const entries = await entriesFor(invoiceId);
      expect(entries).toHaveLength(2);
      const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : 1));
      const voidLines = await linesFor(sorted[1]?.id as string);
      const byCode = new Map(voidLines.map((l) => [l.code, l]));
      expect(byCode.get('4000')).toMatchObject({ side: 'debit', amount: '100.00' });
      expect(byCode.get('2200')).toMatchObject({ side: 'debit', amount: '8.25' });
      expect(byCode.get('1200')).toMatchObject({ side: 'credit', amount: '108.25' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('void draft→voided posts nothing', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'voider-draft@example.com');
      const { accountId, companyId } = await userContext('voider-draft@example.com');
      const customerId = await createCustomer(ctx.app, cookie, accountId, companyId);
      const invoiceId = await createInvoice(
        ctx.app,
        cookie,
        accountId,
        companyId,
        customerId,
        'L-6',
        true,
      );

      const res = await ctx.app.request(`/api/invoices/${invoiceId}/void`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);

      const entries = await entriesFor(invoiceId);
      expect(entries).toHaveLength(0);
    } finally {
      await ctx.handle.close();
    }
  });

  it('trial balance — sum of debits == sum of credits per tenant after a full life cycle', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'tb@example.com');
      const { accountId, companyId } = await userContext('tb@example.com');
      const customerId = await createCustomer(ctx.app, cookie, accountId, companyId);

      // Three invoices: one sent+paid, one sent+voided, one paid-from-draft.
      const a = await createInvoice(ctx.app, cookie, accountId, companyId, customerId, 'TB-1');
      const b = await createInvoice(ctx.app, cookie, accountId, companyId, customerId, 'TB-2');
      const c = await createInvoice(ctx.app, cookie, accountId, companyId, customerId, 'TB-3');

      for (const id of [a, b]) {
        await ctx.app.request(`/api/invoices/${id}/mark-sent`, {
          method: 'POST',
          headers: { cookie, 'x-account-id': accountId },
        });
      }
      await ctx.app.request(`/api/invoices/${a}/mark-paid`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'cash' }),
      });
      await ctx.app.request(`/api/invoices/${b}/void`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      await ctx.app.request(`/api/invoices/${c}/mark-paid`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'cash' }),
      });

      const db = getTestDb();
      const allLines = await db
        .select({ side: journalLines.side, amount: journalLines.amount })
        .from(journalLines)
        .where(eq(journalLines.accountId, accountId));
      const totalDebit = allLines
        .filter((l) => l.side === 'debit')
        .reduce((s, l) => s + Number(l.amount), 0);
      const totalCredit = allLines
        .filter((l) => l.side === 'credit')
        .reduce((s, l) => s + Number(l.amount), 0);
      expect(totalDebit).toBeCloseTo(totalCredit, 2);
    } finally {
      await ctx.handle.close();
    }
  });

  it('cross-account isolation — tenant A postings do not appear under tenant B account_id', async () => {
    const ctx = buildApp();
    try {
      const aCookie = await signUp(ctx.app, 'alice-l@example.com');
      const aCtx = await userContext('alice-l@example.com');
      const aCust = await createCustomer(ctx.app, aCookie, aCtx.accountId, aCtx.companyId);
      const aInvoice = await createInvoice(
        ctx.app,
        aCookie,
        aCtx.accountId,
        aCtx.companyId,
        aCust,
        'A-1',
      );

      await signUp(ctx.app, 'bob-l@example.com');
      const bCtx = await userContext('bob-l@example.com');

      await ctx.app.request(`/api/invoices/${aInvoice}/mark-sent`, {
        method: 'POST',
        headers: { cookie: aCookie, 'x-account-id': aCtx.accountId },
      });

      const db = getTestDb();
      const bEntries = await db
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.accountId, bCtx.accountId));
      expect(bEntries).toEqual([]);

      const aEntries = await db
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.accountId, aCtx.accountId));
      expect(aEntries).toHaveLength(1);

      // And the journal_lines all carry tenant A's account_id; none carry B's.
      const aLines = await db
        .select()
        .from(journalLines)
        .where(eq(journalLines.accountId, aCtx.accountId));
      expect(aLines.length).toBeGreaterThan(0);
      const bLines = await db
        .select()
        .from(journalLines)
        .where(eq(journalLines.accountId, bCtx.accountId));
      expect(bLines).toEqual([]);

      // sanity: the COA codes used on tenant A's lines actually belong to
      // tenant A's COA, not tenant B's (defense against a stale code lookup).
      const aCoaIds = aLines.map((l) => l.coaAccountId);
      const coa = await db
        .select()
        .from(chartOfAccounts)
        .where(
          and(eq(chartOfAccounts.accountId, aCtx.accountId), inArray(chartOfAccounts.id, aCoaIds)),
        );
      expect(coa.length).toBe(aCoaIds.length);
    } finally {
      await ctx.handle.close();
    }
  });
});
