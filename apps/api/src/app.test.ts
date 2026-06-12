import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

// Stub auth handler — exercises the route registration without spinning up
// a real BA instance. Real BA exercise lives in tests/auth.integration.test.ts.
const stubAuth = {
  handler: async () => new Response('stub', { status: 418 }),
} as unknown as Parameters<typeof createApp>[0]['auth'];

// Stub db — only needed by createApp's signature; routes that hit the DB are
// integration-tested separately. Public/auth routes here never touch it.
const stubDb = {} as unknown as Parameters<typeof createApp>[0]['db'];

describe('health route', () => {
  it('returns 200 with status ok', async () => {
    const app = createApp({ auth: stubAuth, db: stubDb });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('returns 404 for an unknown route', async () => {
    const app = createApp({ auth: stubAuth, db: stubDb });
    const res = await app.request('/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('routes /api/auth/* to the auth handler', async () => {
    const app = createApp({ auth: stubAuth, db: stubDb });
    const res = await app.request('/api/auth/anything');
    expect(res.status).toBe(418);
  });
});

describe('GET /api/social-providers (public)', () => {
  it('returns the configured provider ids without auth', async () => {
    const app = createApp({ auth: stubAuth, db: stubDb, socialProviders: ['google', 'facebook'] });
    const res = await app.request('/api/social-providers');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: ['google', 'facebook'] });
  });

  it('defaults to an empty list when none are configured', async () => {
    const app = createApp({ auth: stubAuth, db: stubDb });
    const res = await app.request('/api/social-providers');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: [] });
  });
});

describe('enabledSocialProviders', () => {
  const baseEnv = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test/test',
    APP_DATABASE_URL: 'postgres://thalermark_app:pw@test/test',
    BETTER_AUTH_SECRET: 'test-secret',
    BETTER_AUTH_URL: 'http://localhost:3000',
  };

  it('is empty with no creds', async () => {
    const { loadEnv } = await import('./env.js');
    const { enabledSocialProviders } = await import('./lib/auth.js');
    expect(enabledSocialProviders(loadEnv(baseEnv))).toEqual([]);
  });

  it('ignores a provider with only one half set', async () => {
    const { loadEnv } = await import('./env.js');
    const { enabledSocialProviders } = await import('./lib/auth.js');
    expect(enabledSocialProviders(loadEnv({ ...baseEnv, GOOGLE_CLIENT_ID: 'x' }))).toEqual([]);
  });

  it('lists providers whose id + secret are both set', async () => {
    const { loadEnv } = await import('./env.js');
    const { enabledSocialProviders } = await import('./lib/auth.js');
    const env = loadEnv({
      ...baseEnv,
      GOOGLE_CLIENT_ID: 'gid',
      GOOGLE_CLIENT_SECRET: 'gsec',
      TWITTER_CLIENT_ID: 'tid',
      TWITTER_CLIENT_SECRET: 'tsec',
    });
    expect(enabledSocialProviders(env).sort()).toEqual(['google', 'twitter']);
  });
});

describe('env loader', () => {
  const baseEnv = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test/test',
    APP_DATABASE_URL: 'postgres://thalermark_app:pw@test/test',
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

  it('rejects missing APP_DATABASE_URL', async () => {
    const { loadEnv } = await import('./env.js');
    const { APP_DATABASE_URL: _drop, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(/APP_DATABASE_URL/);
  });

  it('appRolePassword is undefined when THALERMARK_APP_PASSWORD is unset', async () => {
    const { loadEnv } = await import('./env.js');
    expect(loadEnv(baseEnv).appRolePassword).toBeUndefined();
  });

  it('appRolePassword reads THALERMARK_APP_PASSWORD when set', async () => {
    const { loadEnv } = await import('./env.js');
    expect(loadEnv({ ...baseEnv, THALERMARK_APP_PASSWORD: 'shh' }).appRolePassword).toBe('shh');
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

  it('trustedOrigins defaults to empty list', async () => {
    const { loadEnv } = await import('./env.js');
    expect(loadEnv(baseEnv).trustedOrigins).toEqual([]);
  });

  it('trustedOrigins splits a comma-separated allowlist', async () => {
    const { loadEnv } = await import('./env.js');
    const env = loadEnv({
      ...baseEnv,
      TRUSTED_ORIGINS: 'http://localhost:5173, http://localhost:8080',
    });
    expect(env.trustedOrigins).toEqual(['http://localhost:5173', 'http://localhost:8080']);
  });
});

describe('cors middleware', () => {
  it('echoes a trusted origin with credentials', async () => {
    const app = createApp({
      auth: stubAuth,
      db: stubDb,
      trustedOrigins: ['http://localhost:5173'],
    });
    const res = await app.request('/api/auth/anything', {
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('omits CORS headers for an untrusted origin', async () => {
    const app = createApp({
      auth: stubAuth,
      db: stubDb,
      trustedOrigins: ['http://localhost:5173'],
    });
    const res = await app.request('/api/auth/anything', {
      headers: { origin: 'http://evil.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('exposes set-auth-token so bearer clients can read the session token', async () => {
    const app = createApp({
      auth: stubAuth,
      db: stubDb,
      trustedOrigins: ['http://localhost:5173'],
    });
    const res = await app.request('/api/auth/anything', {
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.headers.get('access-control-expose-headers')).toContain('set-auth-token');
  });

  it('allows the Authorization header on preflight for bearer requests', async () => {
    const app = createApp({
      auth: stubAuth,
      db: stubDb,
      trustedOrigins: ['http://localhost:5173'],
    });
    const res = await app.request('/api/me', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization',
    );
  });
});
