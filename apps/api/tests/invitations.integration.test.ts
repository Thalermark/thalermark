import { accounts, authUser, invitations, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  migrateOnBoot: false,
  betterAuthSecret: 'test-secret-at-least-32-characters-long',
  betterAuthUrl: 'http://localhost:3000',
  trustedOrigins: [],
  publicAppUrl: 'http://localhost:5173',
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

async function userAndAccount(email: string): Promise<{ userId: string; accountId: string }> {
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
  return { userId: user.id, accountId: m.accountId };
}

function buildApp(logInviteUrl?: (msg: string) => void) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(url);
  const auth = createApiAuth(handle.db, { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    publicAppUrl: testEnv.publicAppUrl,
    logInviteUrl,
  });
  return { app, handle };
}

describe('POST /api/invitations', () => {
  beforeEach(resetDb);

  it('creates an invitation row and logs the accept URL', async () => {
    const logInviteUrl = vi.fn();
    const { app, handle } = buildApp(logInviteUrl);
    try {
      const cookie = await signUp(app, 'inviter@example.com');
      const { accountId } = await userAndAccount('inviter@example.com');

      const res = await app.request('/api/invitations', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'New@Example.com' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; email: string; token: string };
      expect(body.email).toBe('new@example.com');
      expect(body.token).toMatch(/^[0-9a-f]{64}$/);

      const rows = await getTestDb()
        .select()
        .from(invitations)
        .where(eq(invitations.accountId, accountId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.email).toBe('new@example.com');
      expect(rows[0]?.acceptedAt).toBeNull();

      expect(logInviteUrl).toHaveBeenCalledTimes(1);
      expect(logInviteUrl.mock.calls[0]?.[0]).toContain(
        `http://localhost:5173/accept-invite?token=${body.token}`,
      );
    } finally {
      await handle.close();
    }
  });

  it('rejects malformed emails with 400', async () => {
    const { app, handle } = buildApp(() => {});
    try {
      const cookie = await signUp(app, 'inviter2@example.com');
      const { accountId } = await userAndAccount('inviter2@example.com');
      const res = await app.request('/api/invitations', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it('refuses unauthed requests', async () => {
    const { app, handle } = buildApp(() => {});
    try {
      const res = await app.request('/api/invitations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'who@example.com' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.close();
    }
  });
});

describe('POST /api/invitations/:token/accept', () => {
  beforeEach(resetDb);

  it('creates a membership for the invitee and stamps the invitation', async () => {
    const { app, handle } = buildApp(() => {});
    try {
      const inviterCookie = await signUp(app, 'host@example.com');
      const { accountId } = await userAndAccount('host@example.com');
      const inviteRes = await app.request('/api/invitations', {
        method: 'POST',
        headers: {
          cookie: inviterCookie,
          'x-account-id': accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'guest@example.com' }),
      });
      const { token } = (await inviteRes.json()) as { token: string };

      const guestCookie = await signUp(app, 'guest@example.com');
      const acceptRes = await app.request(`/api/invitations/${token}/accept`, {
        method: 'POST',
        headers: { cookie: guestCookie },
      });
      expect(acceptRes.status).toBe(200);
      const { accountId: returnedAccountId } = (await acceptRes.json()) as { accountId: string };
      expect(returnedAccountId).toBe(accountId);

      const db = getTestDb();
      const [guest] = await db
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, 'guest@example.com'));
      if (!guest) throw new Error('guest not found');
      const guestMems = await db
        .select({ accountId: memberships.accountId })
        .from(memberships)
        .where(eq(memberships.userId, guest.id));
      // Guest now has: own account (from signup hook) + invited account
      expect(guestMems.map((m) => m.accountId).sort()).toContain(accountId);

      const [stamped] = await db.select().from(invitations).where(eq(invitations.token, token));
      expect(stamped?.acceptedAt).not.toBeNull();
      expect(stamped?.acceptedByUserId).toBe(guest.id);
    } finally {
      await handle.close();
    }
  });

  it('rejects when the authed user email does not match the invitation', async () => {
    const { app, handle } = buildApp(() => {});
    try {
      const inviterCookie = await signUp(app, 'host2@example.com');
      const { accountId } = await userAndAccount('host2@example.com');
      const inviteRes = await app.request('/api/invitations', {
        method: 'POST',
        headers: {
          cookie: inviterCookie,
          'x-account-id': accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'wanted@example.com' }),
      });
      const { token } = (await inviteRes.json()) as { token: string };

      const wrongCookie = await signUp(app, 'wrong@example.com');
      const acceptRes = await app.request(`/api/invitations/${token}/accept`, {
        method: 'POST',
        headers: { cookie: wrongCookie },
      });
      expect(acceptRes.status).toBe(403);
    } finally {
      await handle.close();
    }
  });

  it('returns 404 for an unknown token', async () => {
    const { app, handle } = buildApp(() => {});
    try {
      const cookie = await signUp(app, 'lookup@example.com');
      const res = await app.request('/api/invitations/deadbeef/accept', {
        method: 'POST',
        headers: { cookie },
      });
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it('returns 410 for an expired invitation', async () => {
    const { app, handle } = buildApp(() => {});
    try {
      const inviterCookie = await signUp(app, 'host3@example.com');
      const { accountId } = await userAndAccount('host3@example.com');
      const inviteRes = await app.request('/api/invitations', {
        method: 'POST',
        headers: {
          cookie: inviterCookie,
          'x-account-id': accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'stale@example.com' }),
      });
      const { token } = (await inviteRes.json()) as { token: string };
      // Backdate the expiry directly via superuser.
      await getTestDb()
        .update(invitations)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(invitations.token, token));

      const guestCookie = await signUp(app, 'stale@example.com');
      const acceptRes = await app.request(`/api/invitations/${token}/accept`, {
        method: 'POST',
        headers: { cookie: guestCookie },
      });
      expect(acceptRes.status).toBe(410);
    } finally {
      await handle.close();
    }
  });
});

describe('createApp returns an account with the auto-seeded account name', () => {
  beforeEach(resetDb);

  it('signup → /api/me lists exactly the seeded membership', async () => {
    const { app, handle } = buildApp(() => {});
    try {
      const cookie = await signUp(app, 'fresh@example.com');
      const res = await app.request('/api/me', { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        memberships: { accountId: string; name: string }[];
      };
      expect(body.memberships).toHaveLength(1);
      // Hook uses user.name (passed as the email above) for the account name.
      expect(body.memberships[0]?.name).toBe('fresh@example.com');

      // The seeded account should be visible via the accounts row too.
      const seeded = await getTestDb()
        .select({ name: accounts.name })
        .from(accounts)
        .where(eq(accounts.id, body.memberships[0]?.accountId ?? ''));
      expect(seeded[0]?.name).toBe('fresh@example.com');
    } finally {
      await handle.close();
    }
  });
});
