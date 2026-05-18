import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '@thalermark/db';
import { Pool } from 'pg';

// Mirrors packages/db/tests/global-setup.ts: spin up the same pgvector image,
// run the shared migrations folder, promote the RLS app role to LOGIN, and
// export APP_DATABASE_URL. Telemetry integration tests share the same
// migration source of truth as the db package.

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../../db/migrations');

let container: StartedPostgreSqlContainer | undefined;

const APP_PASSWORD = 'test_app_pw';

export async function setup() {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  const superuserUrl = container.getConnectionUri();
  process.env.DATABASE_URL = superuserUrl;
  await runMigrations(superuserUrl, migrationsFolder);

  const pool = new Pool({ connectionString: superuserUrl });
  try {
    await pool.query(`ALTER ROLE thalermark_app WITH LOGIN PASSWORD '${APP_PASSWORD}'`);
  } finally {
    await pool.end();
  }

  process.env.APP_DATABASE_URL = withCredentials(superuserUrl, 'thalermark_app', APP_PASSWORD);
}

export async function teardown() {
  await container?.stop();
}

function withCredentials(connectionString: string, user: string, password: string): string {
  const url = new URL(connectionString);
  url.username = user;
  url.password = password;
  return url.toString();
}
