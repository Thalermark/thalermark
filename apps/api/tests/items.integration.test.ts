import { auditEvents, authUser, companies, items, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { getTestDb, resetDb } from './test-helper.js';

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

async function userContext(email: string): Promise<{
  userId: string;
  accountId: string;
  companyId: string;
}> {
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
  return { userId: user.id, accountId: m.accountId, companyId: company.id };
}

function buildApp() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(url);
  const auth = createApiAuth(handle.db, { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    publicAppUrl: testEnv.publicAppUrl,
  });
  return { app, handle };
}

type ItemBody = {
  companyId: string;
  name: string;
  description?: string;
  unitPrice?: string;
  unitLabel?: string;
  defaultQuantity?: string;
};

function createItem(
  app: ReturnType<typeof createApp>,
  ctx: { cookie: string; accountId: string },
  body: ItemBody,
) {
  return app.request('/api/items', {
    method: 'POST',
    headers: {
      cookie: ctx.cookie,
      'x-account-id': ctx.accountId,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/items', () => {
  beforeEach(resetDb);

  it('creates an item with defaults and writes an audit row', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'bob@example.com');
      const { accountId, companyId } = await userContext('bob@example.com');

      const res = await createItem(app, { cookie, accountId }, { companyId, name: 'Lawn mowing' });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; name: string; companyId: string };
      expect(body.name).toBe('Lawn mowing');
      expect(body.companyId).toBe(companyId);

      const db = getTestDb();
      const [row] = await db.select().from(items).where(eq(items.id, body.id));
      expect(row?.accountId).toBe(accountId);
      expect(row?.unitPrice).toBe('0.00');
      expect(row?.defaultQuantity).toBe('1.0000');
      expect(row?.archivedAt).toBeNull();

      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, body.id));
      expect(audits.map((a) => a.action)).toEqual(['create']);
      expect(audits[0]?.entityType).toBe('item');
    } finally {
      await handle.close();
    }
  });

  it('stores full catalog fields', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'full@example.com');
      const { accountId, companyId } = await userContext('full@example.com');
      const res = await createItem(
        app,
        { cookie, accountId },
        {
          companyId,
          name: 'Hourly labor',
          description: 'General handyman work',
          unitPrice: '65.00',
          unitLabel: 'hour',
          defaultQuantity: '2.5',
        },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        unitPrice: string;
        unitLabel: string;
        defaultQuantity: string;
        description: string;
      };
      expect(body.unitPrice).toBe('65.00');
      expect(body.unitLabel).toBe('hour');
      expect(body.defaultQuantity).toBe('2.5');
      expect(body.description).toBe('General handyman work');
    } finally {
      await handle.close();
    }
  });

  it('rejects a malformed body with 400', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'carol@example.com');
      const { accountId, companyId } = await userContext('carol@example.com');
      const res = await createItem(app, { cookie, accountId }, { companyId, name: '' });
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it('rejects a companyId belonging to a different account with 404', async () => {
    const { app, handle } = buildApp();
    try {
      await signUp(app, 'dan@example.com');
      const danCtx = await userContext('dan@example.com');
      const ericCookie = await signUp(app, 'eric@example.com');
      const ericCtx = await userContext('eric@example.com');

      const res = await createItem(
        app,
        { cookie: ericCookie, accountId: ericCtx.accountId },
        { companyId: danCtx.companyId, name: 'Cross-tenant' },
      );
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it('refuses unauthed requests', async () => {
    const { app, handle } = buildApp();
    try {
      const res = await app.request('/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ companyId: 'x', name: 'y' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.close();
    }
  });
});

describe('GET /api/items', () => {
  beforeEach(resetDb);

  it('lists only the active account items (RLS), ordered by name', async () => {
    const { app, handle } = buildApp();
    try {
      const aCookie = await signUp(app, 'alice-a@example.com');
      const aCtx = await userContext('alice-a@example.com');
      const bCookie = await signUp(app, 'bob-b@example.com');
      const bCtx = await userContext('bob-b@example.com');

      await createItem(
        app,
        { cookie: aCookie, accountId: aCtx.accountId },
        {
          companyId: aCtx.companyId,
          name: 'Weeding',
        },
      );
      await createItem(
        app,
        { cookie: aCookie, accountId: aCtx.accountId },
        {
          companyId: aCtx.companyId,
          name: 'Aeration',
        },
      );
      await createItem(
        app,
        { cookie: bCookie, accountId: bCtx.accountId },
        {
          companyId: bCtx.companyId,
          name: 'B Item',
        },
      );

      const res = await app.request('/api/items', {
        headers: { cookie: aCookie, 'x-account-id': aCtx.accountId },
      });
      const body = (await res.json()) as { items: { name: string }[] };
      expect(body.items.map((i) => i.name)).toEqual(['Aeration', 'Weeding']);
    } finally {
      await handle.close();
    }
  });

  it('hides archived items by default and includes them with includeArchived=true', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'arch@example.com');
      const { accountId, companyId } = await userContext('arch@example.com');
      const create = await createItem(
        app,
        { cookie, accountId },
        { companyId, name: 'Old service' },
      );
      const { id } = (await create.json()) as { id: string };

      const archived = await app.request(`/api/items/${id}/archive`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(archived.status).toBe(200);

      const def = await app.request('/api/items', {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(((await def.json()) as { items: unknown[] }).items).toHaveLength(0);

      const withArchived = await app.request('/api/items?includeArchived=true', {
        headers: { cookie, 'x-account-id': accountId },
      });
      const body = (await withArchived.json()) as { items: { id: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.id).toBe(id);
    } finally {
      await handle.close();
    }
  });

  it('filters by a case-insensitive contains search on q', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'search@example.com');
      const { accountId, companyId } = await userContext('search@example.com');
      await createItem(app, { cookie, accountId }, { companyId, name: 'Power washing' });
      await createItem(app, { cookie, accountId }, { companyId, name: 'Window washing' });
      await createItem(app, { cookie, accountId }, { companyId, name: 'Lawn mowing' });

      const res = await app.request('/api/items?q=WASH', {
        headers: { cookie, 'x-account-id': accountId },
      });
      const body = (await res.json()) as { items: { name: string }[] };
      expect(body.items.map((i) => i.name)).toEqual(['Power washing', 'Window washing']);
    } finally {
      await handle.close();
    }
  });

  it('treats LIKE metacharacters in q as literals', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'literal@example.com');
      const { accountId, companyId } = await userContext('literal@example.com');
      await createItem(app, { cookie, accountId }, { companyId, name: '50% off cleanup' });
      await createItem(app, { cookie, accountId }, { companyId, name: 'Regular cleanup' });

      const res = await app.request('/api/items?q=50%25', {
        headers: { cookie, 'x-account-id': accountId },
      });
      const body = (await res.json()) as { items: { name: string }[] };
      expect(body.items.map((i) => i.name)).toEqual(['50% off cleanup']);
    } finally {
      await handle.close();
    }
  });
});

describe('GET /api/items/:id', () => {
  beforeEach(resetDb);

  it('returns 404 for an item in another account', async () => {
    const { app, handle } = buildApp();
    try {
      const aCookie = await signUp(app, 'alice2@example.com');
      const aCtx = await userContext('alice2@example.com');
      const bCookie = await signUp(app, 'bob2@example.com');
      const bCtx = await userContext('bob2@example.com');

      const create = await createItem(
        app,
        { cookie: aCookie, accountId: aCtx.accountId },
        {
          companyId: aCtx.companyId,
          name: 'A Only',
        },
      );
      const { id } = (await create.json()) as { id: string };

      const res = await app.request(`/api/items/${id}`, {
        headers: { cookie: bCookie, 'x-account-id': bCtx.accountId },
      });
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it('returns 400 for a malformed uuid', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'frank@example.com');
      const { accountId } = await userContext('frank@example.com');
      const res = await app.request('/api/items/not-a-uuid', {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });
});

describe('PATCH /api/items/:id', () => {
  beforeEach(resetDb);

  async function seedItem(
    app: ReturnType<typeof createApp>,
    email: string,
  ): Promise<{ cookie: string; accountId: string; companyId: string; itemId: string }> {
    const cookie = await signUp(app, email);
    const { accountId, companyId } = await userContext(email);
    const create = await createItem(
      app,
      { cookie, accountId },
      {
        companyId,
        name: 'Original',
        description: 'orig desc',
        unitPrice: '10.00',
        unitLabel: 'job',
        defaultQuantity: '3',
      },
    );
    if (create.status !== 201) throw new Error(`seed item failed: ${create.status}`);
    const { id } = (await create.json()) as { id: string };
    return { cookie, accountId, companyId, itemId: id };
  }

  it('replaces fields and writes an update audit row', async () => {
    const { app, handle } = buildApp();
    try {
      const { cookie, accountId, itemId } = await seedItem(app, 'patcher@example.com');
      const res = await app.request(`/api/items/${itemId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed', unitPrice: '25.50' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        name: string;
        unitPrice: string;
        // Omitted optionals collapse to their column default.
        description: string | null;
        unitLabel: string | null;
        defaultQuantity: string;
      };
      expect(body.name).toBe('Renamed');
      expect(body.unitPrice).toBe('25.50');
      expect(body.description).toBeNull();
      expect(body.unitLabel).toBeNull();
      expect(body.defaultQuantity).toBe('1.0000');

      const db = getTestDb();
      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, itemId));
      expect(audits.map((a) => a.action).sort()).toEqual(['create', 'update']);
    } finally {
      await handle.close();
    }
  });

  it('leaves archived_at intact when editing an archived item', async () => {
    const { app, handle } = buildApp();
    try {
      const { cookie, accountId, itemId } = await seedItem(app, 'edit-archived@example.com');
      await app.request(`/api/items/${itemId}/archive`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      const res = await app.request(`/api/items/${itemId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Still archived' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string; archivedAt: string | null };
      expect(body.name).toBe('Still archived');
      expect(body.archivedAt).not.toBeNull();
    } finally {
      await handle.close();
    }
  });

  it('rejects a malformed body with 400', async () => {
    const { app, handle } = buildApp();
    try {
      const { cookie, accountId, itemId } = await seedItem(app, 'bad@example.com');
      const res = await app.request(`/api/items/${itemId}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it('returns 404 for a cross-tenant item id', async () => {
    const { app, handle } = buildApp();
    try {
      const a = await seedItem(app, 'tenant-a@example.com');
      const bCookie = await signUp(app, 'tenant-b@example.com');
      const bCtx = await userContext('tenant-b@example.com');
      const res = await app.request(`/api/items/${a.itemId}`, {
        method: 'PATCH',
        headers: {
          cookie: bCookie,
          'x-account-id': bCtx.accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Hijack' }),
      });
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
});

describe('POST /api/items/:id/archive + /restore', () => {
  beforeEach(resetDb);

  it('archives then restores, writing one audit row each, idempotently', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'archiver@example.com');
      const { accountId, companyId } = await userContext('archiver@example.com');
      const create = await createItem(app, { cookie, accountId }, { companyId, name: 'Toggle me' });
      const { id } = (await create.json()) as { id: string };

      const archive = await app.request(`/api/items/${id}/archive`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(archive.status).toBe(200);
      expect(((await archive.json()) as { archivedAt: string | null }).archivedAt).not.toBeNull();

      // Second archive is a no-op: still 200, but writes no extra audit row.
      const archiveAgain = await app.request(`/api/items/${id}/archive`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(archiveAgain.status).toBe(200);

      const restore = await app.request(`/api/items/${id}/restore`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(restore.status).toBe(200);
      expect(((await restore.json()) as { archivedAt: string | null }).archivedAt).toBeNull();

      const db = getTestDb();
      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
      expect(audits.map((a) => a.action).sort()).toEqual(['archive', 'create', 'restore']);
    } finally {
      await handle.close();
    }
  });

  it('returns 404 archiving a cross-tenant item', async () => {
    const { app, handle } = buildApp();
    try {
      const aCookie = await signUp(app, 'owner@example.com');
      const aCtx = await userContext('owner@example.com');
      const bCookie = await signUp(app, 'intruder@example.com');
      const bCtx = await userContext('intruder@example.com');
      const create = await createItem(
        app,
        { cookie: aCookie, accountId: aCtx.accountId },
        {
          companyId: aCtx.companyId,
          name: 'Owned',
        },
      );
      const { id } = (await create.json()) as { id: string };

      const res = await app.request(`/api/items/${id}/archive`, {
        method: 'POST',
        headers: { cookie: bCookie, 'x-account-id': bCtx.accountId },
      });
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
});

describe('GET /api/audit-events — item feed label', () => {
  beforeEach(resetDb);

  it('labels an item event with the item name in feed mode', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'feed@example.com');
      const { accountId, companyId } = await userContext('feed@example.com');
      await createItem(app, { cookie, accountId }, { companyId, name: 'Gutter cleaning' });

      const res = await app.request('/api/audit-events', {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        events: { entityType: string; entityLabel: string | null; action: string }[];
      };
      const itemEvent = body.events.find((e) => e.entityType === 'item');
      expect(itemEvent).toBeDefined();
      expect(itemEvent?.entityLabel).toBe('Gutter cleaning');
    } finally {
      await handle.close();
    }
  });
});
