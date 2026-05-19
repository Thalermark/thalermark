import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '@thalermark/db';

// One pgvector container per `vitest run`. Shared across every test file
// that hits a database (db.integration, auth.integration, ...). Tests rely
// on the test-helper's resetDb between describe blocks for isolation.

let container: StartedPostgreSqlContainer | undefined;

export async function setup() {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;
  await runMigrations(url);
}

export async function teardown() {
  await container?.stop();
}
