import { randomBytes } from 'node:crypto';
import { type Database, accounts, authUser, invitations, memberships } from '@thalermark/db';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { v7 as uuidv7 } from 'uuid';
import type { ApiAuth } from './lib/auth.js';
import { type RlsVariables, rlsContext } from './middleware/rls-context.js';

export type AppDeps = {
  auth: ApiAuth;
  db: Database;
  scheduleFlush?: (db: Database, accountId: string) => void;
  trustedOrigins?: string[];
  publicAppUrl?: string;
  // Test seam: swap the invite-link logger. Defaults to console.log so dev
  // operators can grab the token from API stdout without an email transport.
  logInviteUrl?: (msg: string) => void;
};

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Routes are chained so Hono's type system carries each route's path + handler
// shape through to AppType, which Phase 4's packages/api-contract re-exports
// for hc<AppType>() clients. Breaking the chain (e.g. `app.get(...); app.get(...)`)
// erases that schema back to an empty Hono.
export function createApp(deps: AppDeps) {
  const origins = deps.trustedOrigins ?? [];
  const logInviteUrl = deps.logInviteUrl ?? ((msg: string) => console.log(msg));
  return new Hono<{ Variables: RlsVariables }>()
    .get('/health', (c) => c.json({ status: 'ok' }))
    .use(
      '/api/*',
      cors({
        origin: (incoming) => (origins.includes(incoming) ? incoming : null),
        credentials: true,
        allowHeaders: ['Content-Type', 'x-account-id'],
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      }),
    )
    .on(['GET', 'POST'], '/api/auth/*', (c) => deps.auth.handler(c.req.raw))
    .use('/api/*', rlsContext({ auth: deps.auth, db: deps.db, scheduleFlush: deps.scheduleFlush }))
    .get('/api/me', async (c) => {
      const userId = c.get('userId');
      const [user] = await deps.db
        .select({
          id: authUser.id,
          email: authUser.email,
          name: authUser.name,
          lastAccountId: authUser.lastAccountId,
        })
        .from(authUser)
        .where(eq(authUser.id, userId));
      if (!user) return c.json({ error: 'unauthorized' }, 401);
      const rows = await deps.db
        .select({ accountId: memberships.accountId, name: accounts.name })
        .from(memberships)
        .innerJoin(accounts, eq(memberships.accountId, accounts.id))
        .where(eq(memberships.userId, userId));
      return c.json({ user, memberships: rows });
    })
    .post('/api/invitations', async (c) => {
      const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!EMAIL_RE.test(email)) return c.json({ error: 'invalid_email' }, 400);

      const tx = c.get('tx');
      const accountId = c.get('accountId');
      const inviterId = c.get('userId');
      const id = uuidv7();
      const token = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

      await tx.insert(invitations).values({
        id,
        accountId,
        email,
        token,
        invitedByUserId: inviterId,
        expiresAt,
      });

      const path = `/accept-invite?token=${token}`;
      const url = deps.publicAppUrl ? `${deps.publicAppUrl}${path}` : path;
      logInviteUrl(`[invite] account=${accountId} email=${email} url=${url}`);

      return c.json({ id, email, token, expiresAt: expiresAt.toISOString() }, 201);
    })
    .post('/api/invitations/:token/accept', async (c) => {
      // Bootstrap path: rls-context set userId from the session but did not
      // open a tenant tx (the accepting user is not yet a member). Use the
      // raw db; uniqueness on token + the freshness checks below are enough.
      const userId = c.get('userId');
      const [user] = await deps.db
        .select({ id: authUser.id, email: authUser.email })
        .from(authUser)
        .where(eq(authUser.id, userId));
      if (!user) return c.json({ error: 'unauthorized' }, 401);

      const token = c.req.param('token');
      const [invite] = await deps.db
        .select()
        .from(invitations)
        .where(and(eq(invitations.token, token), isNull(invitations.acceptedAt)));
      if (!invite) return c.json({ error: 'invite_not_found' }, 404);
      if (invite.expiresAt.getTime() < Date.now()) return c.json({ error: 'invite_expired' }, 410);
      if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
        return c.json({ error: 'invite_email_mismatch' }, 403);
      }

      const acceptedAt = new Date();
      await deps.db.transaction(async (tx) => {
        await tx
          .insert(memberships)
          .values({ id: uuidv7(), userId: user.id, accountId: invite.accountId })
          .onConflictDoNothing({ target: [memberships.userId, memberships.accountId] });
        await tx
          .update(invitations)
          .set({ acceptedAt, acceptedByUserId: user.id, updatedAt: acceptedAt })
          .where(eq(invitations.id, invite.id));
      });

      return c.json({ accountId: invite.accountId });
    });
}

export type AppType = ReturnType<typeof createApp>;
