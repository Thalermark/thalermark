import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '@thalermark/db';

// Mirrors packages/telemetry/tests/global-setup.ts: spin up the same pgvector
// image and run the shared migration folder. @thalermark/auth gets its own
// container (rather than reusing packages/db's) to avoid the cyclic
// workspace dependency that would otherwise sneak in.

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
