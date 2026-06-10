import { accounts, authUser, invitations, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import type { Mailer } from '../src/lib/mailer.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Recorder mailer mirrors the shape used in invoices.integration.test.ts —
// each .send() call appends to `sent`; the throws flag flips the next send
// into a failure to exercise the 502 path without coupling to Resend or
// fetch internals.
type SentMail = { to: string; subject: string; html: string; text: string };
function makeRecorder(opts: { throws?: boolean } = {}) {
  const sent: SentMail[] = [];
  const mailer: Mailer = {
    async send(msg: SentMail) {
      if (opts.throws) throw new Error('mailer_down');
      sent.push(msg);
    },
  };
  return { sent, mailer };
}

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

function buildApp(opts: { mailer?: Mailer } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
    mailer: opts.mailer ?? makeRecorder().mailer,
    emailFrom: testEnv.emailFrom,
  });
  return { app, handle };
}

describe('POST /api/invitations', () => {
  beforeEach(resetDb);

  it('creates an invitation row and emails the accept URL', async () => {
    const { sent, mailer } = makeRecorder();
    const { app, handle } = buildApp({ mailer });
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

      expect(sent).toHaveLength(1);
      const msg = sent[0];
      expect(msg?.to).toBe('new@example.com');
      expect(msg?.subject).toContain('Thalermark');
      expect(msg?.text).toContain(`http://localhost:5173/accept-invite?token=${body.token}`);
      expect(msg?.html).toContain(`http://localhost:5173/accept-invite?token=${body.token}`);
    } finally {
      await handle.close();
    }
  });

  it('returns 502 with the row still committed when the mailer fails', async () => {
    const { mailer } = makeRecorder({ throws: true });
    const { app, handle } = buildApp({ mailer });
    try {
      const cookie = await signUp(app, 'fail-inviter@example.com');
      const { accountId } = await userAndAccount('fail-inviter@example.com');

      const res = await app.request('/api/invitations', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'recipient@example.com' }),
      });
      expect(res.status).toBe(502);

      // Insert sat in the tenant tx and committed because the handler
      // returned normally — the user can recover by retrying.
      const rows = await getTestDb()
        .select()
        .from(invitations)
        .where(eq(invitations.accountId, accountId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.email).toBe('recipient@example.com');
    } finally {
      await handle.close();
    }
  });

  it('rejects malformed emails with 400', async () => {
    const { app, handle } = buildApp();
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
    const { app, handle } = buildApp();
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
    const { app, handle } = buildApp();
    try {
      const inviterCookie = await signUp(app, 'host@example.com');
      const { accountId } = await userAndAccount('host@example.com');
      // The explicit accept path is for EXISTING users — sign the guest up
      // FIRST (no pending invite yet → they get their own account), THEN invite
      // + accept. A brand-new invitee is instead auto-joined by the signup hook,
      // with no explicit accept.
      const guestCookie = await signUp(app, 'guest@example.com');
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
    const { app, handle } = buildApp();
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
    const { app, handle } = buildApp();
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
    const { app, handle } = buildApp();
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
    const { app, handle } = buildApp();
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

describe('GET /api/team', () => {
  beforeEach(resetDb);

  it('returns the account members and pending invitations', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'owner@example.com');
      const { userId, accountId } = await userAndAccount('owner@example.com');

      // One open invitation so the pending list is non-empty.
      const inviteRes = await app.request('/api/invitations', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'pending@example.com' }),
      });
      expect(inviteRes.status).toBe(201);

      const res = await app.request('/api/team', {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        members: { userId: string; email: string; isYou: boolean }[];
        invitations: { email: string; expired: boolean }[];
      };

      expect(body.members).toHaveLength(1);
      expect(body.members[0]?.userId).toBe(userId);
      expect(body.members[0]?.email).toBe('owner@example.com');
      expect(body.members[0]?.isYou).toBe(true);

      expect(body.invitations).toHaveLength(1);
      expect(body.invitations[0]?.email).toBe('pending@example.com');
      expect(body.invitations[0]?.expired).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it('omits invitations that have already been accepted', async () => {
    const { app, handle } = buildApp();
    try {
      const ownerCookie = await signUp(app, 'host4@example.com');
      const { accountId } = await userAndAccount('host4@example.com');
      const inviteRes = await app.request('/api/invitations', {
        method: 'POST',
        headers: {
          cookie: ownerCookie,
          'x-account-id': accountId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'joiner@example.com' }),
      });
      const { token } = (await inviteRes.json()) as { token: string };

      const joinerCookie = await signUp(app, 'joiner@example.com');
      await app.request(`/api/invitations/${token}/accept`, {
        method: 'POST',
        headers: { cookie: joinerCookie },
      });

      const res = await app.request('/api/team', {
        headers: { cookie: ownerCookie, 'x-account-id': accountId },
      });
      const body = (await res.json()) as {
        members: { email: string }[];
        invitations: unknown[];
      };
      // Both users are now members; the accepted invite drops off pending.
      expect(body.members.map((m) => m.email).sort()).toEqual([
        'host4@example.com',
        'joiner@example.com',
      ]);
      expect(body.invitations).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });
});

describe('GET /api/invitations/:token (public preview)', () => {
  beforeEach(resetDb);

  it('returns the org + inviter + invited email for a valid token, no session', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'owner@example.com');
      const { accountId } = await userAndAccount('owner@example.com');
      const inviteRes = await app.request('/api/invitations', {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'newhire@example.com' }),
      });
      const { token } = (await inviteRes.json()) as { token: string };

      // No cookie / x-account-id — the preview is a public, token-gated route.
      const res = await app.request(`/api/invitations/${token}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        email: string;
        accountName: string;
        inviterName: string | null;
        expired: boolean;
        accepted: boolean;
      };
      expect(body.email).toBe('newhire@example.com');
      // The signup hook names the account after the user (here the email).
      expect(body.accountName).toBe('owner@example.com');
      expect(body.expired).toBe(false);
      expect(body.accepted).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it('404s an unknown token', async () => {
    const { app, handle } = buildApp();
    try {
      const res = await app.request('/api/invitations/deadbeef');
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
});

describe('invited sign-up joins the inviting account (no personal company)', () => {
  beforeEach(resetDb);

  it('a new user signing up with a pending invite joins that account, no personal one', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'boss@example.com');
      const { accountId: bossAccount } = await userAndAccount('boss@example.com');
      await app.request('/api/invitations', {
        method: 'POST',
        headers: { cookie, 'x-account-id': bossAccount, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'hire@example.com' }),
      });

      // The invited user signs up — the hook joins them to the inviting account.
      await signUp(app, 'hire@example.com');

      const db = getTestDb();
      const [hire] = await db
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, 'hire@example.com'));
      if (!hire) throw new Error('invited user not created');
      const mships = await db
        .select({ accountId: memberships.accountId })
        .from(memberships)
        .where(eq(memberships.userId, hire.id));
      // Exactly one membership → the inviting account. A personal-account seed
      // would have added a second.
      expect(mships).toHaveLength(1);
      expect(mships[0]?.accountId).toBe(bossAccount);

      // The invite is consumed (marked accepted by the new user).
      const [inv] = await db
        .select({ acceptedByUserId: invitations.acceptedByUserId })
        .from(invitations)
        .where(eq(invitations.email, 'hire@example.com'));
      expect(inv?.acceptedByUserId).toBe(hire.id);
    } finally {
      await handle.close();
    }
  });

  it('a fresh sign-up with no invite still seeds its own personal account', async () => {
    const { app, handle } = buildApp();
    try {
      await signUp(app, 'solo@example.com');
      const db = getTestDb();
      const [solo] = await db
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, 'solo@example.com'));
      if (!solo) throw new Error('solo user not created');
      const mships = await db
        .select({ accountId: memberships.accountId })
        .from(memberships)
        .where(eq(memberships.userId, solo.id));
      expect(mships).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });
});
