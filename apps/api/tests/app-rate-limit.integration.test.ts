import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkRateLimit } from '../src/lib/rate-limit.js';
import { getTestDb, resetDb } from './test-helper.js';

// Exercises the real Postgres fixed-window counter (migration 0006) — the
// atomic upsert + window rollover that the middleware unit test stubs out.

describe('checkRateLimit (Postgres fixed-window counter)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('allows up to max within a window, then denies', async () => {
    const db = getTestDb();
    const opts = { key: `t:${Date.now()}`, max: 3, windowSeconds: 60 };

    const r1 = await checkRateLimit(db, opts);
    const r2 = await checkRateLimit(db, opts);
    const r3 = await checkRateLimit(db, opts);
    const r4 = await checkRateLimit(db, opts);

    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
    expect(r4.allowed).toBe(false);
    expect(r4.retryAfterSeconds).toBeGreaterThan(0);
    expect(r4.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('keeps separate counters per key', async () => {
    const db = getTestDb();
    const a = { key: `a:${Date.now()}`, max: 1, windowSeconds: 60 };
    const b = { key: `b:${Date.now()}`, max: 1, windowSeconds: 60 };

    expect((await checkRateLimit(db, a)).allowed).toBe(true);
    expect((await checkRateLimit(db, a)).allowed).toBe(false);
    // b is untouched by a's exhaustion.
    expect((await checkRateLimit(db, b)).allowed).toBe(true);
  });

  it('resets the count once the window has rolled over', async () => {
    const db = getTestDb();
    const key = `reset:${Date.now()}`;
    const opts = { key, max: 2, windowSeconds: 60 };

    await checkRateLimit(db, opts);
    await checkRateLimit(db, opts);
    expect((await checkRateLimit(db, opts)).allowed).toBe(false);

    // Backdate the stored window past the limit so the next call rolls over.
    await db.execute(
      sql`UPDATE app_rate_limit SET window_start = now() - interval '120 seconds' WHERE key = ${key}`,
    );

    const afterReset = await checkRateLimit(db, opts);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(1);
  });
});
