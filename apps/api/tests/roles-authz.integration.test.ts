import { auditEvents, authUser, companies, memberships } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import type { Mailer } from '../src/lib/mailer.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Exercises the capability gate (requireCapability) + the role assignment /
// transfer endpoints end-to-end through RLS (the suite runs as thalermark_app).
// Roles are authorization (what a member may do); RLS already handled isolation
// upstream. A forbidden role 403s at the gate, BEFORE the handler/body — so the
// negative assertions can use empty bodies and still prove the gate fired.

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

function makeRecorder() {
  const mailer: Mailer = {
    async send() {
      // Invites need a mailer wired; the content is irrelevant here.
    },
  };
  return mailer;
}

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
    mailer: makeRecorder(),
    emailFrom: testEnv.emailFrom,
  });
  return { app, handle };
}

type App = ReturnType<typeof createApp>;

async function signUp(app: App, email: string): Promise<string> {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return extractSessionCookie(res);
}

async function userIdByEmail(email: string): Promise<string> {
  const [u] = await getTestDb()
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email));
  if (!u) throw new Error(`user ${email} not found`);
  return u.id;
}

async function accountIdFor(userId: string): Promise<string> {
  const [m] = await getTestDb()
    .select({ accountId: memberships.accountId })
    .from(memberships)
    .where(eq(memberships.userId, userId));
  if (!m) throw new Error(`no membership for ${userId}`);
  return m.accountId;
}

async function companyIdFor(accountId: string): Promise<string> {
  const [c] = await getTestDb()
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.accountId, accountId));
  if (!c) throw new Error(`no company seeded for account ${accountId}`);
  return c.id;
}

function req(
  app: App,
  method: string,
  path: string,
  opts: { cookie: string; accountId?: string; body?: unknown },
) {
  const headers: Record<string, string> = { cookie: opts.cookie };
  if (opts.accountId) headers['x-account-id'] = opts.accountId;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  return app.request(path, init);
}

async function invite(
  app: App,
  cookie: string,
  accountId: string,
  email: string,
  role?: string,
): Promise<string> {
  const res = await req(app, 'POST', '/api/invitations', {
    cookie,
    accountId,
    body: role ? { email, role } : { email },
  });
  if (res.status !== 201) throw new Error(`invite failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

const NON_OWNER_ROLES = ['admin', 'member', 'accountant', 'viewer'] as const;
type NonOwnerRole = (typeof NON_OWNER_ROLES)[number];
type AnyRole = 'owner' | NonOwnerRole;

// Owner account with one invited member per non-owner role (each joins via the
// signup hook at sign-up time, carrying the invite's role).
async function workspaceWithRoles(app: App) {
  const ownerCookie = await signUp(app, 'owner@example.com');
  const ownerId = await userIdByEmail('owner@example.com');
  const accountId = await accountIdFor(ownerId);

  const cookies = { owner: ownerCookie } as Record<AnyRole, string>;
  const ids = { owner: ownerId } as Record<AnyRole, string>;
  for (const role of NON_OWNER_ROLES) {
    await invite(app, ownerCookie, accountId, `${role}@example.com`, role);
    cookies[role] = await signUp(app, `${role}@example.com`);
    ids[role] = await userIdByEmail(`${role}@example.com`);
  }
  return { accountId, cookies, ids };
}

describe('capability gate — create routes', () => {
  beforeEach(resetDb);

  // Each route names the roles that MAY call it; everyone else is gated at 403.
  const routes: { name: string; path: string; allow: AnyRole[] }[] = [
    { name: 'POST /api/invoices', path: '/api/invoices', allow: ['owner', 'admin', 'member'] },
    { name: 'POST /api/contacts', path: '/api/contacts', allow: ['owner', 'admin', 'member'] },
    {
      name: 'POST /api/contacts/import',
      path: '/api/contacts/import',
      allow: ['owner', 'admin', 'member'],
    },
    {
      name: 'POST /api/items/import',
      path: '/api/items/import',
      allow: ['owner', 'admin', 'member'],
    },
    {
      name: 'POST /api/expenses',
      path: '/api/expenses',
      allow: ['owner', 'admin', 'member', 'accountant'],
    },
    {
      name: 'POST /api/ledger/entries',
      path: '/api/ledger/entries',
      allow: ['owner', 'admin', 'accountant'],
    },
    {
      name: 'POST /api/ledger/entries/:id/reverse',
      // A well-formed (but non-existent) id: a forbidden role 403s at the gate
      // before the lookup; an allowed role passes the gate and 404s — never 403.
      path: '/api/ledger/entries/00000000-0000-0000-0000-000000000000/reverse',
      allow: ['owner', 'admin', 'accountant'],
    },
    { name: 'POST /api/invitations', path: '/api/invitations', allow: ['owner', 'admin'] },
  ];

  for (const route of routes) {
    it(`${route.name}: gate matches the capability matrix`, async () => {
      const { app, handle } = buildApp();
      try {
        const { accountId, cookies } = await workspaceWithRoles(app);
        for (const role of ['owner', ...NON_OWNER_ROLES] as AnyRole[]) {
          // Empty body: a forbidden role 403s at the gate; an allowed role gets
          // past it (then a 400 for the empty body — never a 403).
          const res = await req(app, 'POST', route.path, {
            cookie: cookies[role],
            accountId,
            body: {},
          });
          if (route.allow.includes(role)) {
            expect(res.status, `${role} should pass the gate`).not.toBe(403);
          } else {
            expect(res.status, `${role} should be gated`).toBe(403);
            expect((await res.json()) as { error: string }).toMatchObject({ error: 'forbidden' });
          }
        }
      } finally {
        await handle.close();
      }
    });
  }

  it('member can actually create a customer (happy path past the gate)', async () => {
    const { app, handle } = buildApp();
    try {
      const { accountId, cookies } = await workspaceWithRoles(app);
      const companyId = await companyIdFor(accountId);
      const res = await req(app, 'POST', '/api/contacts', {
        cookie: cookies.member,
        accountId,
        body: { companyId, name: 'Acme LLC' },
      });
      expect(res.status).toBe(201);
    } finally {
      await handle.close();
    }
  });
});

describe('capability gate — settings, reports, workspace', () => {
  beforeEach(resetDb);

  it('settings:manage gates company PATCH to owner/admin', async () => {
    const { app, handle } = buildApp();
    try {
      const { accountId, cookies } = await workspaceWithRoles(app);
      const companyId = await companyIdFor(accountId);
      const allow: AnyRole[] = ['owner', 'admin'];
      for (const role of ['owner', ...NON_OWNER_ROLES] as AnyRole[]) {
        const res = await req(app, 'PATCH', `/api/companies/${companyId}`, {
          cookie: cookies[role],
          accountId,
          body: { businessPhone: '555-0100' },
        });
        if (allow.includes(role)) expect(res.status, role).not.toBe(403);
        else expect(res.status, role).toBe(403);
      }
    } finally {
      await handle.close();
    }
  });

  it('reports:export gates the GL export to owner/admin/accountant', async () => {
    const { app, handle } = buildApp();
    try {
      const { accountId, cookies } = await workspaceWithRoles(app);
      const companyId = await companyIdFor(accountId);
      const allow: AnyRole[] = ['owner', 'admin', 'accountant'];
      for (const role of ['owner', ...NON_OWNER_ROLES] as AnyRole[]) {
        const res = await req(app, 'GET', `/api/companies/${companyId}/ledger/export`, {
          cookie: cookies[role],
          accountId,
        });
        if (allow.includes(role)) expect(res.status, role).not.toBe(403);
        else expect(res.status, role).toBe(403);
      }
    } finally {
      await handle.close();
    }
  });

  it('workspace:manage gates ownership transfer to the owner only', async () => {
    const { app, handle } = buildApp();
    try {
      const { accountId, cookies, ids } = await workspaceWithRoles(app);
      // admin (has team:manage but NOT workspace:manage) cannot transfer.
      const denied = await req(app, 'POST', `/api/team/${ids.member}/transfer-ownership`, {
        cookie: cookies.admin,
        accountId,
      });
      expect(denied.status).toBe(403);
    } finally {
      await handle.close();
    }
  });
});

describe('reads are ungated (viewer can GET)', () => {
  beforeEach(resetDb);

  it('viewer reads contacts, invoices, the team list, and search', async () => {
    const { app, handle } = buildApp();
    try {
      const { accountId, cookies } = await workspaceWithRoles(app);
      // /api/search is deliberately ungated too (TMC-198). A gate there would
      // be the only read gate in the app, and would imply a read model that
      // does not exist — search returns nothing a viewer cannot already list.
      for (const path of ['/api/contacts', '/api/invoices', '/api/team', '/api/search?q=smith']) {
        const res = await req(app, 'GET', path, { cookie: cookies.viewer, accountId });
        expect(res.status, path).toBe(200);
      }
    } finally {
      await handle.close();
    }
  });
});

describe('PATCH /api/team/:userId/role', () => {
  beforeEach(resetDb);

  it('owner changes a member role; the row updates and the change is audited', async () => {
    const { app, handle } = buildApp();
    try {
      const { accountId, cookies, ids } = await workspaceWithRoles(app);
      const res = await req(app, 'PATCH', `/api/team/${ids.member}/role`, {
        cookie: cookies.owner,
        accountId,
        body: { role: 'viewer' },
      });
      expect(res.status).toBe(200);

      const [row] = await getTestDb()
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.accountId, accountId), eq(memberships.userId, ids.member)));
      expect(row?.role).toBe('viewer');

      const [audit] = await getTestDb()
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, ids.member));
      expect(audit?.action).toBe('update');
      expect(audit?.actorUserId).toBe(ids.owner);
    } finally {
      await handle.close();
    }
  });

  it('admin can also change roles', async () => {
    const { app, handle } = buildApp();
    try {
      const { accountId, cookies, ids } = await workspaceWithRoles(app);
      const res = await req(app, 'PATCH', `/api/team/${ids.viewer}/role`, {
        cookie: cookies.admin,
        accountId,
        body: { role: 'member' },
      });
      expect(res.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('refuses to change the owner role (403 cannot_change_owner)', async () => {
    const { app, handle } = buildApp();
    try {
      const { accountId, cookies, ids } = await workspaceWithRoles(app);
      const res = await req(app, 'PATCH', `/api/team/${ids.owner}/role`, {
        cookie: cookies.owner,
        accountId,
        body: { role: 'admin' },
      });
      expect(res.status).toBe(403);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: 'cannot_change_owner',
      });
    } finally {
      await handle.close();
    }
  });

  it('rejects an invalid role (400) and owner as a target role (400)', async () => {
    const { app, handle } = buildApp();
    try {
      const { accountId, cookies, ids } = await workspaceWithRoles(app);
      for (const role of ['superuser', 'owner']) {
        const res = await req(app, 'PATCH', `/api/team/${ids.member}/role`, {
          cookie: cookies.owner,
          accountId,
          body: { role },
        });
        expect(res.status, role).toBe(400);
      }
    } finally {
      await handle.close();
    }
  });

  it('a member cannot change roles (team:manage gate, 403)', async () => {
    const { app, handle } = buildApp();
    try {
      const { accountId, cookies, ids } = await workspaceWithRoles(app);
      const res = await req(app, 'PATCH', `/api/team/${ids.viewer}/role`, {
        cookie: cookies.member,
        accountId,
        body: { role: 'admin' },
      });
      expect(res.status).toBe(403);
    } finally {
      await handle.close();
    }
  });
});

describe('POST /api/team/:userId/transfer-ownership', () => {
  beforeEach(resetDb);

  it('owner transfers to a member: target becomes owner, caller becomes admin', async () => {
    const { app, handle } = buildApp();
    try {
      const { accountId, cookies, ids } = await workspaceWithRoles(app);
      const res = await req(app, 'POST', `/api/team/${ids.member}/transfer-ownership`, {
        cookie: cookies.owner,
        accountId,
      });
      expect(res.status).toBe(200);

      const rows = await getTestDb()
        .select({ userId: memberships.userId, role: memberships.role })
        .from(memberships)
        .where(eq(memberships.accountId, accountId));
      const byUser = new Map(rows.map((r) => [r.userId, r.role]));
      expect(byUser.get(ids.member)).toBe('owner');
      expect(byUser.get(ids.owner)).toBe('admin');
      // The one-owner invariant still holds.
      expect(rows.filter((r) => r.role === 'owner')).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  it('rejects transfer to self (400 already_owner)', async () => {
    const { app, handle } = buildApp();
    try {
      const { accountId, cookies, ids } = await workspaceWithRoles(app);
      const res = await req(app, 'POST', `/api/team/${ids.owner}/transfer-ownership`, {
        cookie: cookies.owner,
        accountId,
      });
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it('404s an unknown target', async () => {
    const { app, handle } = buildApp();
    try {
      const { accountId, cookies } = await workspaceWithRoles(app);
      const res = await req(app, 'POST', `/api/team/${uuidv7()}/transfer-ownership`, {
        cookie: cookies.owner,
        accountId,
      });
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
});

describe('DELETE /api/team/:userId — leave vs remove', () => {
  beforeEach(resetDb);

  it('a member can leave (self) but cannot remove another member', async () => {
    const { app, handle } = buildApp();
    try {
      const { accountId, cookies, ids } = await workspaceWithRoles(app);
      const removeOther = await req(app, 'DELETE', `/api/team/${ids.viewer}`, {
        cookie: cookies.member,
        accountId,
      });
      expect(removeOther.status).toBe(403);

      const leave = await req(app, 'DELETE', `/api/team/${ids.member}`, {
        cookie: cookies.member,
        accountId,
      });
      expect(leave.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('an admin (team:manage) can remove another member', async () => {
    const { app, handle } = buildApp();
    try {
      const { accountId, cookies, ids } = await workspaceWithRoles(app);
      const res = await req(app, 'DELETE', `/api/team/${ids.viewer}`, {
        cookie: cookies.admin,
        accountId,
      });
      expect(res.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('even an admin cannot remove the owner (owner-protection, cannot_remove_owner)', async () => {
    const { app, handle } = buildApp();
    try {
      const { accountId, cookies, ids } = await workspaceWithRoles(app);
      const res = await req(app, 'DELETE', `/api/team/${ids.owner}`, {
        cookie: cookies.admin,
        accountId,
      });
      expect(res.status).toBe(403);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: 'cannot_remove_owner',
      });
    } finally {
      await handle.close();
    }
  });
});

describe('invite carries the role onto the membership', () => {
  beforeEach(resetDb);

  it('signup-hook path: an invited new user joins with the invite role', async () => {
    const { app, handle } = buildApp();
    try {
      const ownerCookie = await signUp(app, 'host@example.com');
      const ownerId = await userIdByEmail('host@example.com');
      const accountId = await accountIdFor(ownerId);
      await invite(app, ownerCookie, accountId, 'cpa@example.com', 'accountant');
      await signUp(app, 'cpa@example.com');

      const cpaId = await userIdByEmail('cpa@example.com');
      const [row] = await getTestDb()
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.accountId, accountId), eq(memberships.userId, cpaId)));
      expect(row?.role).toBe('accountant');
    } finally {
      await handle.close();
    }
  });

  it('explicit accept path: an existing user accepts with the invite role', async () => {
    const { app, handle } = buildApp();
    try {
      const ownerCookie = await signUp(app, 'host2@example.com');
      const ownerId = await userIdByEmail('host2@example.com');
      const accountId = await accountIdFor(ownerId);
      // Existing user signs up first (own account), THEN is invited as admin.
      const guestCookie = await signUp(app, 'existing@example.com');
      const token = await invite(app, ownerCookie, accountId, 'existing@example.com', 'admin');
      const acceptRes = await app.request(`/api/invitations/${token}/accept`, {
        method: 'POST',
        headers: { cookie: guestCookie },
      });
      expect(acceptRes.status).toBe(200);

      const guestId = await userIdByEmail('existing@example.com');
      const [row] = await getTestDb()
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.accountId, accountId), eq(memberships.userId, guestId)));
      expect(row?.role).toBe('admin');
    } finally {
      await handle.close();
    }
  });

  it('rejects an invite with an invalid role (400)', async () => {
    const { app, handle } = buildApp();
    try {
      const ownerCookie = await signUp(app, 'host3@example.com');
      const ownerId = await userIdByEmail('host3@example.com');
      const accountId = await accountIdFor(ownerId);
      const res = await req(app, 'POST', '/api/invitations', {
        cookie: ownerCookie,
        accountId,
        body: { email: 'x@example.com', role: 'owner' },
      });
      expect(res.status).toBe(400);
    } finally {
      await handle.close();
    }
  });
});
