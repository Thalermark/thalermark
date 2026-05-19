import type { Database } from '@thalermark/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export type ApiDatabase = {
  db: Database;
  pool: Pool;
  close: () => Promise<void>;
};

// Constructs the api process's owned DB handle. Mirrors the inline pool +
// drizzle dance from packages/db's createDatabase, but exposes the pool so
// server.ts can drain it on shutdown. Idempotent close() lets the SIGTERM
// and SIGINT handlers both run safely.
export function createApiDatabase(connectionString: string): ApiDatabase {
  const pool = new Pool({ connectionString });
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
