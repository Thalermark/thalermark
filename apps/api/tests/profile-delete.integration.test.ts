import { randomUUID } from 'node:crypto';
import { authUser, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
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
  publicAppUrl: '',
  resendApiKey: undefined,
  emailFrom: 'Thalermark <test@thalermark.test>',
  stripeSecretKey: undefined,
  stripePublishableKey: undefined,
  stripeWebhookSecret: undefined,
  recurringSweepCron: '0 6 * * *',
};

function cookieOf(res: Response): string {
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

async function signUp(app: ReturnType<typeof createApp>, email: string, name: string) {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return cookieOf(res);
}

function buildApp() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({ auth, db: handle.db, bootstrapDb: getTestDb() });
  return { app, handle };
}

async function companyIdOf(app: ReturnType<typeof createApp>, cookie: string, accountId: string) {
  const res = await app.request('/api/companies', {
    headers: { cookie, 'x-account-id': accountId },
  });
  const { companies } = (await res.json()) as { companies: { id: string }[] };
  return companies[0]?.id as string;
}

async function userIdOf(app: ReturnType<typeof createApp>, cookie: string) {
  const res = await app.request('/api/me', { headers: { cookie } });
  return ((await res.json()) as { user: { id: string } }).user.id;
}

// The helper Sarah: invited into the owner's workspace as a plain member, does
// some work, then leaves for good.
async function seedHelper(app: ReturnType<typeof createApp>, accountId: string) {
  const cookie = await signUp(app, 'sarah@example.com', 'Sarah');
  const userId = await userIdOf(app, cookie);
  await getTestDb()
    .insert(memberships)
    .values({ id: randomUUID(), userId, accountId, role: 'member' });
  return { cookie, userId };
}

// TMC-268. Deleting a person, without the audit trail forgetting who they were.
describe('deleting my profile', () => {
  beforeEach(resetDb);

  it('keeps naming the person in the audit trail after they are gone', async () => {
    // The property the whole design turns on. Without the snapshotted name the
    // history reads "Unknown" and an owner whose helpers come and go loses the
    // record of who did the work.
    const { app, handle } = buildApp();
    try {
      const ownerCookie = await signUp(app, 'raz@example.com', 'Raz');
      const meRes = await app.request('/api/me', { headers: { cookie: ownerCookie } });
      const { memberships: mine } = (await meRes.json()) as {
        memberships: { accountId: string }[];
      };
      const accountId = mine[0]?.accountId as string;
      const { cookie: sarah } = await seedHelper(app, accountId);
      const auth = { cookie: sarah, 'x-account-id': accountId, 'content-type': 'application/json' };

      // Sarah does a piece of audited work.
      const companyId = await companyIdOf(app, ownerCookie, accountId);
      const created = await app.request('/api/contacts', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ companyId, name: 'A customer Sarah added' }),
      });
      expect(created.status).toBe(201);

      const before = await app.request('/api/audit-events', {
        headers: { cookie: ownerCookie, 'x-account-id': accountId },
      });
      const beforeBody = (await before.json()) as { events: { actorName: string }[] };
      expect(beforeBody.events.some((e) => e.actorName === 'Sarah')).toBe(true);

      // She deletes her profile.
      const del = await app.request('/api/me/profile/delete', {
        method: 'POST',
        headers: { cookie: sarah },
      });
      expect(del.status).toBe(200);

      // The owner still sees who did the work — and that she has left.
      const after = await app.request('/api/audit-events', {
        headers: { cookie: ownerCookie, 'x-account-id': accountId },
      });
      const afterBody = (await after.json()) as {
        events: { actorName: string; actorRemoved: boolean }[];
      };
      const row = afterBody.events.find((e) => e.actorName === 'Sarah');
      expect(row, 'the audit trail must still name Sarah').toBeDefined();
      expect(row?.actorRemoved).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('removes them from every workspace and ends the session', async () => {
    const { app, handle } = buildApp();
    try {
      const ownerCookie = await signUp(app, 'raz2@example.com', 'Raz');
      const meRes = await app.request('/api/me', { headers: { cookie: ownerCookie } });
      const accountId = ((await meRes.json()) as { memberships: { accountId: string }[] })
        .memberships[0]?.accountId as string;
      const { cookie: sarah, userId } = await seedHelper(app, accountId);

      await app.request('/api/me/profile/delete', { method: 'POST', headers: { cookie: sarah } });

      const db = getTestDb();
      const left = await db.select().from(memberships).where(eq(memberships.userId, userId));
      expect(left).toHaveLength(0);
      // Signed out everywhere: the cookie she still holds is dead.
      expect((await app.request('/api/me', { headers: { cookie: sarah } })).status).toBe(401);
    } finally {
      await handle.close();
    }
  });

  it('frees the email, so signing up again is a genuinely new person', async () => {
    const { app, handle } = buildApp();
    try {
      const ownerCookie = await signUp(app, 'raz3@example.com', 'Raz');
      const meRes = await app.request('/api/me', { headers: { cookie: ownerCookie } });
      const accountId = ((await meRes.json()) as { memberships: { accountId: string }[] })
        .memberships[0]?.accountId as string;
      const { cookie: sarah, userId: oldId } = await seedHelper(app, accountId);
      await app.request('/api/me/profile/delete', { method: 'POST', headers: { cookie: sarah } });

      const againCookie = await signUp(app, 'sarah@example.com', 'Sarah');
      const newId = await userIdOf(app, againCookie);
      expect(newId).not.toBe(oldId);

      // The old row survives, tombstoned, so the audit FK still resolves.
      const db = getTestDb();
      const [ghost] = await db
        .select({ email: authUser.email, name: authUser.name, deletedAt: authUser.deletedAt })
        .from(authUser)
        .where(eq(authUser.id, oldId))
        .limit(1);
      expect(ghost?.name).toBeNull();
      expect(ghost?.email).toBe(`deleted-${oldId}@invalid`);
      expect(ghost?.deletedAt).not.toBeNull();
    } finally {
      await handle.close();
    }
  });

  it('refuses an owner, naming the workspaces they must hand over first', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'owner-del@example.com', 'Raz');
      const meRes = await app.request('/api/me', { headers: { cookie } });
      const accountId = ((await meRes.json()) as { memberships: { accountId: string }[] })
        .memberships[0]?.accountId as string;
      // Someone else has to depend on the workspace — a solo starter workspace
      // is not a reason to refuse, or nobody could ever delete their profile.
      await seedHelper(app, accountId);
      const res = await app.request('/api/me/profile/delete', {
        method: 'POST',
        headers: { cookie },
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: string;
        workspaces: { accountId: string; name: string }[];
      };
      expect(body.error).toBe('owner_must_hand_over');
      // Named, so the answer is actionable rather than a flat refusal.
      expect(body.workspaces).toHaveLength(1);
      expect(body.workspaces[0]?.name).toBeTruthy();
      // And nothing happened.
      expect((await app.request('/api/me', { headers: { cookie } })).status).toBe(200);
    } finally {
      await handle.close();
    }
  });
});
