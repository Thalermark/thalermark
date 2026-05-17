import { sql } from 'drizzle-orm';
import { type Database, createDatabase } from '../src/client.js';

let _db: Database | undefined;
let _appDb: Database | undefined;
let _staffDb: Database | undefined;

/**
 * Superuser connection. Bypasses RLS — use for seeding and for non-RLS
 * schema tests. RLS isolation tests should use getAppDb() / getStaffDb().
 */
export function getTestDb(): Database {
  if (!_db) {
    _db = createDatabase(requireEnv('DATABASE_URL'));
  }
  return _db;
}

/**
 * Connection as `thalermark_app` — RLS-enforcing, full CRUD grants.
 * Use this with `withAccountContext` to test tenant isolation.
 */
export function getAppDb(): Database {
  if (!_appDb) {
    _appDb = createDatabase(requireEnv('APP_DATABASE_URL'));
  }
  return _appDb;
}

/**
 * Connection as `thalermark_staff_readonly` — BYPASSRLS, SELECT only.
 * Use to verify staff impersonation can read across accounts but cannot mutate.
 */
export function getStaffDb(): Database {
  if (!_staffDb) {
    _staffDb = createDatabase(requireEnv('STAFF_DATABASE_URL'));
  }
  return _staffDb;
}

/**
 * TRUNCATE every public table except Drizzle's migration tracker.
 * Auto-discovers tables so this stays correct as schema grows.
 * Call in `beforeEach` to guarantee clean state per test. Runs as superuser.
 *
 * Re-seeds rows that the migrations treat as part of the schema bootstrap
 * (currently: the synthetic system user from migration 0009), so tests see
 * the same baseline a fresh production database would.
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

  await db.execute(sql`
    INSERT INTO "auth_user" ("id", "email", "email_verified", "name", "is_staff", "is_system")
    VALUES ('00000000-0000-7000-8000-000000000001', 'system@thalermark.internal', false, 'System', false, true)
    ON CONFLICT ("id") DO NOTHING
  `);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set — global-setup.ts should have set it`);
  return v;
}
