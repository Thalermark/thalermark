import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export type Database = ReturnType<typeof createDatabase>;

// Transaction handle as Drizzle exposes it inside `db.transaction(fn)`.
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export function createDatabase(connectionString: string) {
  const pool = new Pool({ connectionString });
  return drizzle(pool);
}

/**
 * Run `fn` inside a transaction with the request's tenant context set via GUCs
 * that RLS policies read (see migration 0006). `accountId` is required; an
 * optional `userId` widens visibility of `memberships` to the user's own rows.
 *
 * Uses `set_config(..., is_local=true)` rather than `SET LOCAL` so the UUIDs
 * can be passed as bind parameters — Postgres rejects bind params on SET.
 */
export async function withAccountContext<T>(
  db: Database,
  ctx: { accountId: string; userId?: string },
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_account_id', ${ctx.accountId}, true)`);
    if (ctx.userId !== undefined) {
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`);
    }
    return fn(tx);
  });
}
