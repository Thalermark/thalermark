import { authUser, companies, invoiceLineItems, memberships } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

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

async function signUp(app: ReturnType<typeof createApp>, email: string) {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return extractSessionCookie(res);
}

async function userContext(email: string): Promise<{ accountId: string; companyId: string }> {
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

describe('line-item source_item_id provenance', () => {
  beforeEach(resetDb);

  it('persists sourceItemId from a picked line and leaves hand-typed lines null', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'prov@example.com');
      const { accountId, companyId } = await userContext('prov@example.com');
      const h = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };

      // Seed a catalog item + a customer.
      const itemRes = await app.request('/api/items', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ companyId, name: 'Power washing', unitPrice: '120.00' }),
      });
      const item = (await itemRes.json()) as { id: string };
      const custRes = await app.request('/api/contacts', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ companyId, name: 'Coyote' }),
      });
      const customer = (await custRes.json()) as { id: string };

      // One picked line (carries the breadcrumb) + one hand-typed line.
      const invRes = await app.request('/api/invoices', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({
          companyId,
          contactId: customer.id,
          number: 'INV-PROV-1',
          issueDate: '2026-06-07',
          dueDate: '2026-07-07',
          subtotal: '170.00',
          total: '170.00',
          lineItems: [
            {
              position: 1,
              description: 'Power washing — patio',
              quantity: '1',
              unitPrice: '120.00',
              amount: '120.00',
              sourceItemId: item.id,
            },
            {
              position: 2,
              description: 'Ad-hoc cleanup',
              quantity: '1',
              unitPrice: '50.00',
              amount: '50.00',
            },
          ],
        }),
      });
      expect(invRes.status).toBe(201);
      const invoice = (await invRes.json()) as { id: string };

      const db = getTestDb();
      const lines = await db
        .select()
        .from(invoiceLineItems)
        .where(
          and(
            eq(invoiceLineItems.invoiceId, invoice.id),
            eq(invoiceLineItems.accountId, accountId),
          ),
        )
        .orderBy(invoiceLineItems.position);
      expect(lines).toHaveLength(2);
      expect(lines[0]?.sourceItemId).toBe(item.id);
      expect(lines[1]?.sourceItemId).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it('carries the breadcrumb forward when an invoice is duplicated', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'dup@example.com');
      const { accountId, companyId } = await userContext('dup@example.com');
      const h = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };

      const itemRes = await app.request('/api/items', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ companyId, name: 'Mowing', unitPrice: '40.00' }),
      });
      const item = (await itemRes.json()) as { id: string };
      const custRes = await app.request('/api/contacts', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ companyId, name: 'Roadrunner' }),
      });
      const customer = (await custRes.json()) as { id: string };

      const invRes = await app.request('/api/invoices', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({
          companyId,
          contactId: customer.id,
          number: 'INV-DUP-1',
          issueDate: '2026-06-07',
          dueDate: '2026-07-07',
          subtotal: '40.00',
          total: '40.00',
          lineItems: [
            {
              position: 1,
              description: 'Mowing',
              quantity: '1',
              unitPrice: '40.00',
              amount: '40.00',
              sourceItemId: item.id,
            },
          ],
        }),
      });
      const original = (await invRes.json()) as { id: string };

      const dupRes = await app.request(`/api/invoices/${original.id}/duplicate`, {
        method: 'POST',
        headers: h,
      });
      expect(dupRes.status).toBe(201);
      const dup = (await dupRes.json()) as { id: string };

      const db = getTestDb();
      const [dupLine] = await db
        .select()
        .from(invoiceLineItems)
        .where(
          and(eq(invoiceLineItems.invoiceId, dup.id), eq(invoiceLineItems.accountId, accountId)),
        );
      expect(dupLine?.sourceItemId).toBe(item.id);
    } finally {
      await handle.close();
    }
  });
});
