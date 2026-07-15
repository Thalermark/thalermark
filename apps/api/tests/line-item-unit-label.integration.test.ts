import {
  authUser,
  companies,
  invoiceLineItems,
  invoices,
  items,
  memberships,
} from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// TMC-139: a line's unit of measure ("hour", "sq ft") is a snapshot that must
// ride from the catalog item onto the line and out to the sent/public document,
// never re-read from items.unit_label at render. Mirrors the sourceItemId /
// tax_rate_pct snapshot contracts already covered by the provenance + tax tests.

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

describe('line-item unit_label snapshot', () => {
  beforeEach(resetDb);

  it('carries the unit onto the sent/public document and keeps hand-typed lines unitless', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'unit@example.com');
      const { accountId, companyId } = await userContext('unit@example.com');
      const h = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };

      // Catalog item with a unit label, plus a customer.
      const itemRes = await app.request('/api/items', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({
          companyId,
          name: 'Consulting',
          unitPrice: '65.00',
          unitLabel: 'hour',
        }),
      });
      const item = (await itemRes.json()) as { id: string };
      const custRes = await app.request('/api/contacts', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ companyId, name: 'Acme' }),
      });
      const customer = (await custRes.json()) as { id: string };

      // A picked line carries the unit; a hand-typed line has none.
      const invRes = await app.request('/api/invoices', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({
          companyId,
          contactId: customer.id,
          number: 'INV-UNIT-1',
          issueDate: '2026-07-14',
          dueDate: '2026-08-13',
          subtotal: '505.00',
          total: '505.00',
          lineItems: [
            {
              position: 1,
              description: 'Consulting',
              quantity: '7',
              unitLabel: 'hour',
              unitPrice: '65.00',
              amount: '455.00',
              sourceItemId: item.id,
            },
            {
              position: 2,
              description: 'Ad-hoc fee',
              quantity: '1',
              unitPrice: '50.00',
              amount: '50.00',
            },
          ],
        }),
      });
      expect(invRes.status).toBe(201);
      const invoice = (await invRes.json()) as { id: string };

      // The snapshot lands on the row.
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
      expect(lines[0]?.unitLabel).toBe('hour');
      expect(lines[1]?.unitLabel).toBeNull();

      // Send, then read the unauthed public view — the unit rides through.
      await app.request(`/api/invoices/${invoice.id}/mark-sent`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
      const token = row?.publicToken;
      const pubRes = await app.request(`/api/public/invoices/${token}`);
      expect(pubRes.status).toBe(200);
      const pub = (await pubRes.json()) as {
        lineItems: { quantity: string; unitLabel: string | null }[];
      };
      expect(pub.lineItems[0]?.unitLabel).toBe('hour');
      expect(pub.lineItems[1]?.unitLabel).toBeNull();

      // Snapshot semantics: renaming the source item's unit must NOT rewrite the
      // sent invoice — the public view still reads the value as it was sold.
      await db.update(items).set({ unitLabel: 'session' }).where(eq(items.id, item.id));
      const pubAfter = await app.request(`/api/public/invoices/${token}`);
      const after = (await pubAfter.json()) as {
        lineItems: { unitLabel: string | null }[];
      };
      expect(after.lineItems[0]?.unitLabel).toBe('hour');
    } finally {
      await handle.close();
    }
  });
});
