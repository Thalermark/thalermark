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
  }[];
};

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
        expect(Object.keys(co).sort()).toEqual([
          'bills',
          'capitalPurchases',
          'company',
          'contacts',
          'estimates',
          'expenses',
          'invoices',
          'items',
          'ownerMoney',
          'recurringInvoices',
          'taxPolicies',
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
