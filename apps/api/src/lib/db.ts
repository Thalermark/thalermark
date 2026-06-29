import type { Database } from '@thalermark/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export type ApiDatabase = {
  db: Database;
  pool: Pool;
  close: () => Promise<void>;
};

// Pool guardrails for the runtime Postgres pools. The api runs two of these
// (tenant + bootstrap); left unbounded each would inherit pg's implicit max of
// 10, and with the per-request tenant transaction that means ~10 concurrent
// slow operations can drain a pool and stall every other request. These cap
// that blast radius:
//   connectionTimeoutMillis — fail fast when the pool is saturated instead of
//     queueing the request indefinitely (turns a silent stall into a clean 500)
//   statement_timeout — abort a runaway query rather than pin its connection
//   idle_in_transaction_session_timeout — abort a transaction left idle across
//     a slow call. This is the guardrail that bounds the exact class of bug
//     where an upstream LLM/email call was awaited *inside* the tenant tx;
//     30s is generous enough that no legitimate short tx trips it.
// `max` is the one dimension that scales with the box, so it's the only knob
// (DB_POOL_MAX); the timeouts are fixed safety rails.
const CONNECTION_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 30_000;
const IDLE_IN_TX_TIMEOUT_MS = 30_000;

// Constructs the api process's owned DB handle. Mirrors the inline pool +
// drizzle dance from packages/db's createDatabase, but exposes the pool so
// server.ts can drain it on shutdown. Idempotent close() lets the SIGTERM
// and SIGINT handlers both run safely.
export function createApiDatabase(connectionString: string, poolMax = 10): ApiDatabase {
  const pool = new Pool({
    connectionString,
    max: poolMax,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TX_TIMEOUT_MS,
  });
  const db: Database = drizzle(pool);
  let closed = false;
  return {
    db,
    pool,
    close: async () => {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}
