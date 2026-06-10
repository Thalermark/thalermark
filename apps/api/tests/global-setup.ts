import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '@thalermark/db';
import { provisionAppRole } from '../src/lib/role-provision.js';

// One pgvector container per `vitest run`. Shared across every test file
// that hits a database (db.integration, auth.integration, ...). Tests rely
// on the test-helper's resetDb between describe blocks for isolation.
//
// Two connection strings are exposed, mirroring production (server.ts):
//   DATABASE_URL     — the container superuser. Used by test-helper's
//                      getTestDb() for seeding + assertions, and as the
//                      bootstrapDb / auth handle (the RLS-bypass surface:
//                      /api/me, the rls-context membership probe, public
//                      routes, invite-accept).
//   APP_DATABASE_URL — the non-BYPASSRLS thalermark_app role. Tests pass this
//                      as createApp's `db` so the suite runs THROUGH RLS, not
//                      just the explicit account_id filters.
// The role is created NOLOGIN in migration 0005; provisionAppRole gives it a
// LOGIN + password (the same call server.ts makes at boot).

let container: StartedPostgreSqlContainer | undefined;

const APP_ROLE_PASSWORD = 'thalermark_app_test';

// Swap the superuser credentials in the container URI for the app role's.
function appRoleUrl(superuserUrl: string, password: string): string {
  const u = new URL(superuserUrl);
  u.username = 'thalermark_app';
  u.password = password;
  return u.toString();
}

export async function setup() {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;
  await runMigrations(url);
  await provisionAppRole(url, APP_ROLE_PASSWORD);
  process.env.APP_DATABASE_URL = appRoleUrl(url, APP_ROLE_PASSWORD);
}

export async function teardown() {
  await container?.stop();
}
