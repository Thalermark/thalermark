import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

// Stub auth handler — exercises the route registration without spinning up
// a real BA instance. Real BA exercise lives in tests/auth.integration.test.ts.
const stubAuth = {
  handler: async () => new Response('stub', { status: 418 }),
} as unknown as Parameters<typeof createApp>[0]['auth'];

describe('health route', () => {
  it('returns 200 with status ok', async () => {
    const app = createApp({ auth: stubAuth });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('returns 404 for an unknown route', async () => {
    const app = createApp({ auth: stubAuth });
    const res = await app.request('/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('routes /api/auth/* to the auth handler', async () => {
    const app = createApp({ auth: stubAuth });
    const res = await app.request('/api/auth/anything');
    expect(res.status).toBe(418);
  });
});

describe('env loader', () => {
  const baseEnv = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test/test',
    BETTER_AUTH_SECRET: 'test-secret',
    BETTER_AUTH_URL: 'http://localhost:3000',
  };

  it('defaults port to 3000 when API_PORT is unset', async () => {
    const { loadEnv } = await import('./env.js');
    const env = loadEnv(baseEnv);
    expect(env.port).toBe(3000);
    expect(env.nodeEnv).toBe('test');
  });

  it('parses API_PORT when set', async () => {
    const { loadEnv } = await import('./env.js');
    const env = loadEnv({ ...baseEnv, API_PORT: '8080' });
    expect(env.port).toBe(8080);
  });

  it('rejects non-numeric API_PORT', async () => {
    const { loadEnv } = await import('./env.js');
    expect(() => loadEnv({ ...baseEnv, API_PORT: 'oops' })).toThrow(/positive integer/);
  });

  it('rejects out-of-range API_PORT', async () => {
    const { loadEnv } = await import('./env.js');
    expect(() => loadEnv({ ...baseEnv, API_PORT: '99999' })).toThrow(/positive integer/);
  });

  it('rejects an unknown NODE_ENV', async () => {
    const { loadEnv } = await import('./env.js');
    expect(() => loadEnv({ ...baseEnv, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('rejects missing DATABASE_URL', async () => {
    const { loadEnv } = await import('./env.js');
    const { DATABASE_URL: _drop, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('rejects missing BETTER_AUTH_SECRET', async () => {
    const { loadEnv } = await import('./env.js');
    const { BETTER_AUTH_SECRET: _drop, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(/BETTER_AUTH_SECRET/);
  });

  it('rejects missing BETTER_AUTH_URL', async () => {
    const { loadEnv } = await import('./env.js');
    const { BETTER_AUTH_URL: _drop, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(/BETTER_AUTH_URL/);
  });

  it('migrateOnBoot defaults false', async () => {
    const { loadEnv } = await import('./env.js');
    expect(loadEnv(baseEnv).migrateOnBoot).toBe(false);
  });

  it('migrateOnBoot accepts true/1', async () => {
    const { loadEnv } = await import('./env.js');
    expect(loadEnv({ ...baseEnv, MIGRATE_ON_BOOT: 'true' }).migrateOnBoot).toBe(true);
    expect(loadEnv({ ...baseEnv, MIGRATE_ON_BOOT: '1' }).migrateOnBoot).toBe(true);
  });
});
