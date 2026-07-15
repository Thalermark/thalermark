import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { getTestDb } from './db-test-helper.js';

// Regression test for TMC-138. A tiny out-of-order migration set: migB (idx 1)
// carries a `when` *earlier* than migA (idx 0). drizzle's stock high-water
// runner would skip migB once migA is recorded as the latest; runMigrations()
// gates on hash identity, so it must still apply migB.
const sqlA = 'CREATE TABLE recon_a (id int);';
const sqlB = 'CREATE TABLE recon_b (id int);';
const hashA = createHash('sha256').update(sqlA).digest('hex');
const hashB = createHash('sha256').update(sqlB).digest('hex');

let folder: string;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'recon-'));
  mkdirSync(join(folder, 'meta'), { recursive: true });
  writeFileSync(join(folder, '0000_a.sql'), sqlA);
  writeFileSync(join(folder, '0001_b.sql'), sqlB);
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [
        { idx: 0, version: '7', when: 1000, tag: '0000_a', breakpoints: true },
        { idx: 1, version: '7', when: 500, tag: '0001_b', breakpoints: true },
      ],
    }),
  );
});

afterAll(async () => {
  const db = getTestDb();
  await db.execute(sql`DROP TABLE IF EXISTS recon_a, recon_b`);
  await db.execute(
    sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash IN (${hashA}, ${hashB})`,
  );
  rmSync(folder, { recursive: true, force: true });
});

it('fills an out-of-order gap that a high-water runner would skip, idempotently', async () => {
  const db = getTestDb();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set — global-setup.ts should have set it');

  // Seed the exact state a high-water runner leaves after skipping migB:
  // migA applied and recorded at its high `when`, migB absent.
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
  await db.execute(sql.raw(sqlA));
  await db.execute(
    sql`INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES (${hashA}, 1000)`,
  );

  await runMigrations(url, folder);

  // migB applied despite its `when` sitting below the recorded high-water mark.
  const b = await db.execute<{ reg: string | null }>(
    sql`SELECT to_regclass('public.recon_b')::text AS reg`,
  );
  expect(b.rows[0]?.reg).toBe('recon_b');

  // Second run is a no-op: migA is skipped by hash (recon_a is never re-created,
  // which would throw), and migB is recorded exactly once.
  await runMigrations(url, folder);
  const n = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations" WHERE hash = ${hashB}`,
  );
  expect(n.rows[0]?.n).toBe(1);
});
