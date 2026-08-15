import { authUser, companies, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// GET /api/account/export — the full-account data-export bundle behind
// Settings → Export. Covers: the happy-path shape (invoices carry their lines
// and a resolved contact name), all-companies coverage, cross-account isolation,
// the business-records-only exclusions, and reports:export gating.

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
  return { userId: user.id, accountId: m.accountId, companyId: company.id };
}

async function setRole(userId: string, role: string) {
  await getTestDb().update(memberships).set({ role }).where(eq(memberships.userId, userId));
}

async function createContact(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  companyId: string,
  name: string,
): Promise<string> {
  const res = await app.request('/api/contacts', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify({ companyId, name }),
  });
  if (res.status !== 201) throw new Error(`contact create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function createInvoice(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  companyId: string,
  contactId: string,
  number: string,
): Promise<string> {
  const res = await app.request('/api/invoices', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify({
      companyId,
      contactId,
      number,
      issueDate: '2026-05-28',
      dueDate: '2026-06-27',
      subtotal: '100.00',
      tax: '8.25',
      total: '108.25',
      lineItems: [
        {
          position: 1,
          description: 'Service',
          quantity: '1',
          unitPrice: '100.00',
          amount: '100.00',
        },
      ],
    }),
  });
  if (res.status !== 201) throw new Error(`invoice create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function createCompany(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  name: string,
): Promise<string> {
  const res = await app.request('/api/companies', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify({ name, businessType: 'sole_prop' }),
  });
  if (res.status !== 201) throw new Error(`company create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

type ExportBundle = {
  version: number;
  exportedAt: string;
  account: { id: string; name: string };
  companies: {
    company: { id: string; name: string };
    contacts: { id: string; name: string }[];
    items: unknown[];
    invoices: {
      number: string;
      contactName: string | null;
      lines: { amount: string; description: string }[];
    }[];
    estimates: unknown[];
    recurringInvoices: unknown[];
    expenses: unknown[];
    bills: unknown[];
    capitalPurchases: unknown[];
    ownerMoney: unknown[];
    taxPolicies: unknown[];
    invoicePayments: {
      amount: string;
      receivedOn: string;
      method: string;
      reference: string | null;
      invoiceNumber: string | null;
    }[];
    billPayments: unknown[];
    mileageTrips: unknown[];
    vehicles: unknown[];
    jobs: unknown[];
    timeEntries: unknown[];
  }[];
};

async function recordPayment(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  invoiceId: string,
  amount: string,
  receivedOn: string,
  reference: string,
): Promise<void> {
  const res = await app.request(`/api/invoices/${invoiceId}/payments`, {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify({ amount, receivedOn, method: 'check', reference }),
  });
  if (res.status !== 201) throw new Error(`payment failed: ${res.status} ${await res.text()}`);
}

async function getExport(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
): Promise<Response> {
  return app.request('/api/account/export', {
    headers: { cookie, 'x-account-id': accountId },
  });
}

describe('GET /api/account/export', () => {
  beforeEach(resetDb);

  it('returns invoices with their lines and a resolved contact name', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'owner@example.com');
      const { accountId, companyId } = await userContext('owner@example.com');
      const contactId = await createContact(app, cookie, accountId, companyId, 'Bob');
      await createInvoice(app, cookie, accountId, companyId, contactId, 'AE-1');

      const res = await getExport(app, cookie, accountId);
      expect(res.status).toBe(200);
      const bundle = (await res.json()) as ExportBundle;

      expect(bundle.version).toBe(1);
      const co = bundle.companies.find((c) => c.company.id === companyId);
      expect(co).toBeDefined();
      expect(co?.contacts.map((c) => c.name)).toContain('Bob');
      expect(co?.invoices).toHaveLength(1);
      expect(co?.invoices[0]?.number).toBe('AE-1');
      expect(co?.invoices[0]?.contactName).toBe('Bob');
      expect(co?.invoices[0]?.lines).toHaveLength(1);
      expect(co?.invoices[0]?.lines[0]?.amount).toBe('100.00');
    } finally {
      await handle.close();
    }
  });

  it('carries every payment, not just the last one mirrored on the invoice', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'parts@example.com');
      const { accountId, companyId } = await userContext('parts@example.com');
      const contactId = await createContact(app, cookie, accountId, companyId, 'Bob');
      const invoiceId = await createInvoice(app, cookie, accountId, companyId, contactId, 'AE-9');
      // A draft is off the books entirely and refuses payment (409 not_issued),
      // which is correct: you cannot receive money against an invoice nobody has.
      const sent = await app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      });
      if (sent.status !== 200) throw new Error(`mark-sent failed: ${sent.status}`);

      // A deposit, then a second instalment. The invoice total is 108.25, so
      // this leaves the invoice part-paid — the shape the header mirror cannot
      // represent, because paid_at / payment_method describe ONE payment.
      await recordPayment(app, cookie, accountId, invoiceId, '40.00', '2026-06-01', 'dep-1');
      await recordPayment(app, cookie, accountId, invoiceId, '25.00', '2026-06-15', 'chk-2');

      const bundle = (await (await getExport(app, cookie, accountId)).json()) as ExportBundle;
      const co = bundle.companies.find((c) => c.company.id === companyId);

      // The actual acceptance criterion from the ticket: a user can reconstruct
      // their financial history from the export alone. Both payments, with
      // their own dates and references, and they sum to what was received.
      expect(co?.invoicePayments).toHaveLength(2);
      const paid = (co?.invoicePayments ?? []).reduce((sum, p) => sum + Number(p.amount), 0);
      expect(paid).toBeCloseTo(65, 2);
      expect(co?.invoicePayments.map((p) => p.reference).sort()).toEqual(['chk-2', 'dep-1']);
      expect(co?.invoicePayments.map((p) => p.receivedOn).sort()).toEqual([
        '2026-06-01',
        '2026-06-15',
      ]);
      // Joins back to invoices.csv without a UUID.
      expect(co?.invoicePayments.every((p) => p.invoiceNumber === 'AE-9')).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('carries the work records a business would need to take with it', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'records@example.com');
      const { accountId, companyId } = await userContext('records@example.com');

      const bundle = (await (await getExport(app, cookie, accountId)).json()) as ExportBundle;
      const co = bundle.companies.find((c) => c.company.id === companyId);

      // Present and empty, rather than absent. An absent key is indistinguishable
      // from "this account had none", which is exactly how the gap went unnoticed:
      // mileage is Schedule C substantiation and jobs/time are the record of what
      // work was done at all.
      for (const key of [
        'billPayments',
        'mileageTrips',
        'vehicles',
        'jobs',
        'timeEntries',
      ] as const) {
        expect(Array.isArray(co?.[key]), `${key} missing from the bundle`).toBe(true);
      }
    } finally {
      await handle.close();
    }
  });

  it('covers every company in the workspace', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'multi@example.com');
      const { accountId, companyId } = await userContext('multi@example.com');
      const second = await createCompany(app, cookie, accountId, 'Second Biz');

      const res = await getExport(app, cookie, accountId);
      const bundle = (await res.json()) as ExportBundle;
      const ids = bundle.companies.map((c) => c.company.id);
      expect(ids).toContain(companyId);
      expect(ids).toContain(second);
      expect(bundle.companies).toHaveLength(2);
    } finally {
      await handle.close();
    }
  });

  it('never leaks another account into the bundle', async () => {
    const { app, handle } = buildApp();
    try {
      const aCookie = await signUp(app, 'a@example.com');
      const a = await userContext('a@example.com');
      await createContact(app, aCookie, a.accountId, a.companyId, 'Alice-Only');

      const bCookie = await signUp(app, 'b@example.com');
      const b = await userContext('b@example.com');

      const res = await getExport(app, bCookie, b.accountId);
      const bundle = (await res.json()) as ExportBundle;
      const names = bundle.companies.flatMap((c) => c.contacts.map((ct) => ct.name));
      expect(names).not.toContain('Alice-Only');
      expect(bundle.companies).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  it('exports only business-record shapes — no ledger tables, no secrets', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'shape@example.com');
      const { accountId } = await userContext('shape@example.com');

      const res = await getExport(app, cookie, accountId);
      const bundle = (await res.json()) as ExportBundle;

      expect(Object.keys(bundle).sort()).toEqual(['account', 'companies', 'exportedAt', 'version']);
      for (const co of bundle.companies) {
        // An exact list on purpose: adding an entity to the export has to fail
        // here first, so nobody widens what leaves the product without someone
        // reading the new table's columns. The six added by TMC-231 went through
        // exactly that review.
        expect(Object.keys(co).sort()).toEqual([
          'billPayments',
          'bills',
          'capitalPurchases',
          'company',
          'contacts',
          'estimates',
          'expenses',
          'invoicePayments',
          'invoices',
          'items',
          'jobs',
          'mileageTrips',
          'ownerMoney',
          'recurringInvoices',
          'taxPolicies',
          'timeEntries',
          'vehicles',
        ]);
      }
      // No ledger / auth / connection artifacts anywhere in the serialized bundle.
      const raw = JSON.stringify(bundle);
      expect(raw).not.toContain('journalEntries');
      expect(raw).not.toContain('chartOfAccounts');
      expect(raw).not.toContain('apiKey');
    } finally {
      await handle.close();
    }
  });

  it('is gated on reports:export', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'gate@example.com');
      const { userId, accountId } = await userContext('gate@example.com');

      const asOwner = await getExport(app, cookie, accountId);
      expect(asOwner.status).toBe(200);

      await setRole(userId, 'member');
      const asMember = await getExport(app, cookie, accountId);
      expect(asMember.status).toBe(403);
    } finally {
      await handle.close();
    }
  });
});
