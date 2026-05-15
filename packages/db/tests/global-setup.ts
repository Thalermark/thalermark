import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../src/migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, '../migrations');

let container: StartedPostgreSqlContainer | undefined;

export async function setup() {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;
  await runMigrations(url, migrationsFolder);
}

export async function teardown() {
  await container?.stop();
}
