import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiDatabase } from '../src/lib/db.js';

// Exercises createApiDatabase end-to-end against the testcontainer booted
// in tests/global-setup.ts: connect, query, drain. Container lifecycle is
// shared with other integration tests in this package.

describe('createApiDatabase', () => {
  let lastHandle: ReturnType<typeof createApiDatabase> | undefined;

  afterEach(async () => {
    await lastHandle?.close();
    lastHandle = undefined;
  });

  it('connects and runs a trivial query', async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not set');
    lastHandle = createApiDatabase(url);
    const result = await lastHandle.db.execute<{ one: number }>(sql`SELECT 1 AS one`);
    expect(result.rows[0]?.one).toBe(1);
  });

  it('close() drains the pool and is idempotent', async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not set');
    const handle = createApiDatabase(url);
    await handle.db.execute(sql`SELECT 1`);
    await handle.close();
    expect(handle.pool.ended).toBe(true);
    // Second close must not throw.
    await handle.close();
  });
});
