import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

// Absolute path to the SQL migration files. Resolved from this module's URL
// so it works the same whether @thalermark/db is loaded from the workspace
// (./packages/db/src) or from inside a deployed slice (.../node_modules/...).
export const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

export async function runMigrations(connectionString: string, folder: string = migrationsFolder) {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: folder });
  await pool.end();
}
