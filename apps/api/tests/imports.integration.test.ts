import { auditEvents, authUser, companies, contacts, items, memberships } from '@thalermark/db';
import { MAX_IMPORT_ROWS } from '@thalermark/validation';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Bulk CSV import endpoints (POST /api/contacts/import, POST /api/items/import).
// The capability gate is covered by roles-authz.integration.test.ts (both routes
// are in its matrix); this file covers the import-specific behavior: atomic
// batch insert, per-row audit, company scoping, and the MAX_IMPORT_ROWS ceiling.

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
  if (!m) throw new Error(`membership for ${email} not seeded by hook`);
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.accountId, m.accountId));
  if (!company) throw new Error(`default company for ${email} not seeded by hook`);
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

describe('POST /api/contacts/import', () => {
  beforeEach(resetDb);

  it('inserts every row and writes a create audit per row', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'imp-cust@example.com');
      const { accountId, companyId } = await userContext('imp-cust@example.com');

      const res = await app.request('/api/contacts/import', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({
          companyId,
          rows: [
            { name: 'Acme Co', email: 'ap@acme.example', city: 'Tucson' },
            { name: 'Globex', phone: '555-0100' },
            { name: 'Initech' },
          ],
        }),
      });
      expect(res.status).toBe(201);
      expect((await res.json()) as { created: number }).toEqual({ created: 3 });

      const db = getTestDb();
      const rows = await db.select().from(contacts).where(eq(contacts.companyId, companyId));
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.accountId === accountId)).toBe(true);
      expect(rows.map((r) => r.name).sort()).toEqual(['Acme Co', 'Globex', 'Initech']);

      const audits = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityType, 'contact'));
      expect(audits).toHaveLength(3);
      expect(audits.every((a) => a.action === 'create')).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('rejects the whole batch atomically when any row is invalid (nothing inserted)', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'imp-bad@example.com');
      const { accountId, companyId } = await userContext('imp-bad@example.com');

      const res = await app.request('/api/contacts/import', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({
          companyId,
          rows: [
            { name: 'Valid One' },
            { name: '' }, // invalid: name min(1)
            { name: 'Valid Two' },
          ],
        }),
      });
      expect(res.status).toBe(400);

      const db = getTestDb();
      const rows = await db.select().from(contacts).where(eq(contacts.companyId, companyId));
      expect(rows).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });

  it('404s a companyId belonging to a different account (nothing inserted)', async () => {
    const { app, handle } = buildApp();
    try {
      await signUp(app, 'imp-a@example.com');
      const a = await userContext('imp-a@example.com');
      const bCookie = await signUp(app, 'imp-b@example.com');
      const b = await userContext('imp-b@example.com');

      const res = await app.request('/api/contacts/import', {
        method: 'POST',
        headers: {
          cookie: bCookie,
          'x-account-id': b.accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ companyId: a.companyId, rows: [{ name: 'Cross-tenant' }] }),
      });
      expect(res.status).toBe(404);

      const db = getTestDb();
      const rows = await db.select().from(contacts).where(eq(contacts.companyId, a.companyId));
      expect(rows).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });

  it('rejects a batch over MAX_IMPORT_ROWS with 400', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'imp-max@example.com');
      const { accountId, companyId } = await userContext('imp-max@example.com');

      const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({ name: `C${i}` }));
      const res = await app.request('/api/contacts/import', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ companyId, rows }),
      });
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it('rejects an empty rows array with 400', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'imp-empty@example.com');
      const { accountId, companyId } = await userContext('imp-empty@example.com');
      const res = await app.request('/api/contacts/import', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ companyId, rows: [] }),
      });
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it('refuses unauthed requests', async () => {
    const { app, handle } = buildApp();
    try {
      const res = await app.request('/api/contacts/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ companyId: 'x', rows: [{ name: 'y' }] }),
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.close();
    }
  });
});

describe('POST /api/items/import', () => {
  beforeEach(resetDb);

  it('inserts every row, coerced money + type round-trip, with a create audit per row', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'imp-item@example.com');
      const { accountId, companyId } = await userContext('imp-item@example.com');

      const res = await app.request('/api/items/import', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({
          companyId,
          rows: [
            { name: 'Lawn Mowing', type: 'service', unitPrice: '45.00', unitLabel: 'hour' },
            { name: 'Mulch Bag', type: 'product', unitPrice: '6.50', taxable: true },
            { name: 'Consultation' },
          ],
        }),
      });
      expect(res.status).toBe(201);
      expect((await res.json()) as { created: number }).toEqual({ created: 3 });

      const db = getTestDb();
      const rows = await db.select().from(items).where(eq(items.companyId, companyId));
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.accountId === accountId)).toBe(true);
      const mulch = rows.find((r) => r.name === 'Mulch Bag');
      expect(mulch?.type).toBe('product');
      expect(mulch?.unitPrice).toBe('6.50');
      expect(mulch?.taxable).toBe(true);

      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityType, 'item'));
      expect(audits).toHaveLength(3);
      expect(audits.every((a) => a.action === 'create')).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('sets archived_at from the import-only `archived` flag (omitted/false → active)', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'imp-item-arch@example.com');
      const { accountId, companyId } = await userContext('imp-item-arch@example.com');

      const res = await app.request('/api/items/import', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({
          companyId,
          rows: [
            { name: 'Retired Service', archived: true },
            { name: 'Active Service', archived: false },
            { name: 'Default Service' },
          ],
        }),
      });
      expect(res.status).toBe(201);

      const db = getTestDb();
      const rows = await db.select().from(items).where(eq(items.companyId, companyId));
      const byName = new Map(rows.map((r) => [r.name, r]));
      expect(byName.get('Retired Service')?.archivedAt).toBeInstanceOf(Date);
      expect(byName.get('Active Service')?.archivedAt).toBeNull();
      expect(byName.get('Default Service')?.archivedAt).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it('rejects the whole batch atomically on a malformed money string (nothing inserted)', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'imp-item-bad@example.com');
      const { accountId, companyId } = await userContext('imp-item-bad@example.com');

      const res = await app.request('/api/items/import', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({
          companyId,
          rows: [
            { name: 'Good', unitPrice: '10.00' },
            { name: 'Bad', unitPrice: '$10' }, // not a moneyString — client must coerce first
          ],
        }),
      });
      expect(res.status).toBe(400);

      const db = getTestDb();
      const rows = await db.select().from(items).where(eq(items.companyId, companyId));
      expect(rows).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });
});
