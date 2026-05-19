import { type Database, type Transaction, memberships, withAccountContext } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import type { ApiAuth } from '../lib/auth.js';

export type RlsContextDeps = {
  auth: ApiAuth;
  db: Database;
};

export type RlsVariables = {
  tx: Transaction;
  accountId: string;
  userId: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bootstrap endpoints: authenticated but not yet account-scoped. The picker
// reads from /api/me to learn which accounts the user can pick from, then sets
// x-account-id on every subsequent request.
const BOOTSTRAP_PATHS = new Set<string>(['/api/me', '/api/me/memberships']);

export function rlsContext({ auth, db }: RlsContextDeps): MiddlewareHandler {
  return async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    c.set('userId', session.user.id);

    if (BOOTSTRAP_PATHS.has(c.req.path)) return next();

    const accountId = c.req.header('x-account-id');
    if (!accountId || !UUID_RE.test(accountId)) {
      return c.json({ error: 'account_required' }, 400);
    }

    const found = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, session.user.id), eq(memberships.accountId, accountId)))
      .limit(1);
    if (found.length === 0) return c.json({ error: 'account_revoked' }, 403);

    return withAccountContext(db, { accountId, userId: session.user.id }, async (tx) => {
      c.set('tx', tx);
      c.set('accountId', accountId);
      await next();
    });
  };
}
