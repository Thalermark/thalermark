import { sql } from 'drizzle-orm';
import { type Database, createDatabase } from '../src/client.js';

let _db: Database | undefined;

export function getTestDb(): Database {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL not set — global-setup.ts should have set it');
    }
    _db = createDatabase(url);
  }
  return _db;
}

/**
 * TRUNCATE every public table except Drizzle's migration tracker.
 * Auto-discovers tables so this stays correct as schema grows.
 * Call in `beforeEach` to guarantee clean state per test.
 */
export async function resetDb(): Promise<void> {
  const db = getTestDb();
  const result = await db.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '__drizzle_migrations'
  `);

  if (result.rows.length === 0) return;

  const tables = result.rows.map((r) => `"${r.tablename}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`));
}
