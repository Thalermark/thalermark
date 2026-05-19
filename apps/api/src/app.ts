import { type Database, accounts, authUser, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { ApiAuth } from './lib/auth.js';
import { type RlsVariables, rlsContext } from './middleware/rls-context.js';

export type AppDeps = {
  auth: ApiAuth;
  db: Database;
  scheduleFlush?: (db: Database, accountId: string) => void;
};

// The Hono app, separate from the server entry point so tests can mount it
// against a request directly without binding a network port. server.ts is the
// only file that calls @hono/node-server's serve().
export function createApp(deps: AppDeps) {
  const app = new Hono<{ Variables: RlsVariables }>();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Better Auth owns everything under /api/auth/*. Cookie strategy is the
  // default; mobile clients (Phase 6) will swap in bearer-token plugin then.
  app.on(['GET', 'POST'], '/api/auth/*', (c) => deps.auth.handler(c.req.raw));

  // Bootstrap endpoint must be reachable before the client knows which account
  // to send. Middleware sets userId but skips the x-account-id requirement for
  // /api/me; see middleware/rls-context.ts.
  app.use(
    '/api/*',
    rlsContext({ auth: deps.auth, db: deps.db, scheduleFlush: deps.scheduleFlush }),
  );

  app.get('/api/me', async (c) => {
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
    const rows = await deps.db
      .select({ accountId: memberships.accountId, name: accounts.name })
      .from(memberships)
      .innerJoin(accounts, eq(memberships.accountId, accounts.id))
      .where(eq(memberships.userId, userId));
    return c.json({ user, memberships: rows });
  });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
