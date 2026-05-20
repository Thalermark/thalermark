import { type Database, accounts, authUser, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ApiAuth } from './lib/auth.js';
import { type RlsVariables, rlsContext } from './middleware/rls-context.js';

export type AppDeps = {
  auth: ApiAuth;
  db: Database;
  scheduleFlush?: (db: Database, accountId: string) => void;
  trustedOrigins?: string[];
};

// Routes are chained so Hono's type system carries each route's path + handler
// shape through to AppType, which Phase 4's packages/api-contract re-exports
// for hc<AppType>() clients. Breaking the chain (e.g. `app.get(...); app.get(...)`)
// erases that schema back to an empty Hono.
export function createApp(deps: AppDeps) {
  const origins = deps.trustedOrigins ?? [];
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
    });
}

export type AppType = ReturnType<typeof createApp>;
