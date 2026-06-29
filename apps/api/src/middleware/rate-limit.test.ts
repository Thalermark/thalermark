import type { Database } from '@thalermark/db';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { RATE_LIMITS, rateLimit } from './rate-limit.js';

// Fake DB: checkRateLimit only calls db.execute() and reads result.rows[0].
// Each test hands back a crafted row (or throws) to drive the middleware
// without a Postgres container — the real SQL counter is integration-tested in
// tests/app-rate-limit.integration.test.ts.
function fakeDb(execute: () => unknown): Database {
  return { execute: async () => execute() } as unknown as Database;
}

function appWith(deps: { db: Database; rateLimitEnabled?: boolean }) {
  return new Hono()
    .use(
      '*',
      rateLimit(deps, RATE_LIMITS.ai, (c) => c.req.header('x-key')),
    )
    .get('/', (c) => c.json({ ok: true }));
}

const withKey = { headers: { 'x-key': 'acct-1' } };

describe('rateLimit middleware', () => {
  it('passes through when disabled, even over the limit', async () => {
    const db = fakeDb(() => ({ rows: [{ count: 999, retry_after: 60 }] }));
    const res = await appWith({ db, rateLimitEnabled: false }).request('/', withKey);
    expect(res.status).toBe(200);
  });

  it('allows a request under the limit', async () => {
    const db = fakeDb(() => ({ rows: [{ count: 1, retry_after: 60 }] }));
    const res = await appWith({ db, rateLimitEnabled: true }).request('/', withKey);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 429 + Retry-After once over the limit', async () => {
    const db = fakeDb(() => ({ rows: [{ count: RATE_LIMITS.ai.max + 1, retry_after: 42 }] }));
    const res = await appWith({ db, rateLimitEnabled: true }).request('/', withKey);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(await res.json()).toEqual({ error: 'rate_limited', retryAfter: 42 });
  });

  it('fails open (allows) when the limiter query throws', async () => {
    const db = fakeDb(() => {
      throw new Error('pool exhausted');
    });
    const res = await appWith({ db, rateLimitEnabled: true }).request('/', withKey);
    expect(res.status).toBe(200);
  });

  it('allows unkeyable requests (no key derivable)', async () => {
    const db = fakeDb(() => ({ rows: [{ count: 999, retry_after: 60 }] }));
    // No x-key header → key() returns undefined → fail open.
    const res = await appWith({ db, rateLimitEnabled: true }).request('/');
    expect(res.status).toBe(200);
  });
});
