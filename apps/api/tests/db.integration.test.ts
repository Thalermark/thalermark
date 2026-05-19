import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '@thalermark/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiDatabase } from '../src/lib/db.js';

// Boots a real pg17 container, runs the shared migrations, and exercises
// createApiDatabase end-to-end: connect, issue a query, drain. Single-file
// setup (no global-setup.ts) because this is the only api-side test that
// needs a database — adding one is justified when we have ≥2 such tests.

describe('createApiDatabase', () => {
  let container: StartedPostgreSqlContainer;
  let url: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
    url = container.getConnectionUri();
    await runMigrations(url);
  }, 60_000);

  afterAll(async () => {
    await container?.stop();
  });

  it('connects and runs a trivial query', async () => {
    const handle = createApiDatabase(url);
    try {
      const result = await handle.db.execute<{ one: number }>(sql`SELECT 1 AS one`);
      expect(result.rows[0]?.one).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it('close() drains the pool and is idempotent', async () => {
    const handle = createApiDatabase(url);
    await handle.db.execute(sql`SELECT 1`);
    await handle.close();
    expect(handle.pool.ended).toBe(true);
    // Second close must not throw.
    await handle.close();
  });
});
