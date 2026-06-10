import { type Database, createDatabase } from '@thalermark/db';
import { sql } from 'drizzle-orm';

let _db: Database | undefined;

// Superuser handle for tests. Bypasses RLS — use for seeding and reading back
// state in assertions, and as the createApp `bootstrapDb` + auth handle (the
// legitimate RLS-bypass surface: /api/me, the membership probe, public routes).
export function getTestDb(): Database {
  if (!_db) {
    _db = createDatabase(requireEnv('DATABASE_URL'));
  }
  return _db;
}

// The non-BYPASSRLS thalermark_app connection (global-setup provisions the role
// + sets this). Pass it as createApp's `db` so integration tests run THROUGH
// RLS rather than only the explicit account_id filters. The superuser
// DATABASE_URL above stays the seeding / bootstrap / auth handle.
export function appDatabaseUrl(): string {
  return requireEnv('APP_DATABASE_URL');
}

// TRUNCATE every table except the migration ledger so each test starts
// clean. Re-seeds the synthetic system user from migration 0009 because
// some downstream code joins to it.
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
