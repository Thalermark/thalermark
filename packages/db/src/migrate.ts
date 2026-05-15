import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

export async function runMigrations(connectionString: string, migrationsFolder: string) {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder });
  await pool.end();
}
