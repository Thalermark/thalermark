import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

// Absolute path to the SQL migration files. Resolved from this module's URL
// so it works the same whether @thalermark/db is loaded from the workspace
// (./packages/db/src) or from inside a deployed slice (.../node_modules/...).
export const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

// Apply pending migrations by *identity*, not by timestamp.
//
// drizzle-orm's own migrate() gates each migration on a single high-water mark:
// the max(created_at) in drizzle.__drizzle_migrations, where created_at is the
// journal `when`. A migration whose `when` sorts *below* an already-applied one
// is skipped — permanently. That is exactly how 0009_legal_acceptances was
// dropped on every beta.2 -> beta.3 upgrade: 0008's `when` had been hand-edited
// to a round value that leapfrogged 0009, so once a DB recorded 0008 as its
// latest, 0009 fell below the mark and never ran (TMC-138).
//
// We instead apply, in journal order, any migration whose file hash isn't
// already recorded. readMigrationFiles() hashes each file exactly as drizzle
// does (sha256 of the raw .sql text), so hashes written by earlier drizzle runs
// match here — already-applied migrations are recognised, not re-run. `when`
// ordering no longer affects correctness, so no future timestamp slip can skip a
// migration (journal-order.test.ts still fails CI on a backwards `when`, so it
// stays a caught smell rather than a silent landmine).
export async function runMigrations(connectionString: string, folder: string = migrationsFolder) {
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  const pool = new Pool({ connectionString });
  const db = drizzle(pool);
  try {
    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

    const applied = await db.execute<{ hash: string }>(
      sql`select hash from "drizzle"."__drizzle_migrations"`,
    );
    const appliedHashes = new Set(applied.rows.map((row) => row.hash));

    // One transaction for all pending files: matches drizzle's atomicity and
    // lets a `SET search_path` at the top of one file carry into the next.
    await db.transaction(async (tx) => {
      for (const migration of migrations) {
        if (appliedHashes.has(migration.hash)) continue;
        for (const statement of migration.sql) {
          await tx.execute(sql.raw(statement));
        }
        await tx.execute(
          sql`insert into "drizzle"."__drizzle_migrations" ("hash", "created_at")
              values (${migration.hash}, ${migration.folderMillis})`,
        );
      }
    });
  } finally {
    await pool.end();
  }
}
