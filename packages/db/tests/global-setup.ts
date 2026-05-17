import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { runMigrations } from '../src/migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../migrations');

let container: StartedPostgreSqlContainer | undefined;

const APP_PASSWORD = 'test_app_pw';
const STAFF_PASSWORD = 'test_staff_pw';

export async function setup() {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  const superuserUrl = container.getConnectionUri();
  process.env.DATABASE_URL = superuserUrl;
  await runMigrations(superuserUrl, migrationsFolder);

  // Promote the two non-login roles from migration 0005 to LOGIN so the RLS
  // isolation tests can connect AS those roles (production deploys provision
  // a separate LOGIN role that INHERITs; tests skip that indirection).
  const pool = new Pool({ connectionString: superuserUrl });
  try {
    await pool.query(`ALTER ROLE thalermark_app WITH LOGIN PASSWORD '${APP_PASSWORD}'`);
    await pool.query(
      `ALTER ROLE thalermark_staff_readonly WITH LOGIN PASSWORD '${STAFF_PASSWORD}'`,
    );
  } finally {
    await pool.end();
  }

  process.env.APP_DATABASE_URL = withCredentials(superuserUrl, 'thalermark_app', APP_PASSWORD);
  process.env.STAFF_DATABASE_URL = withCredentials(
    superuserUrl,
    'thalermark_staff_readonly',
    STAFF_PASSWORD,
  );
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
