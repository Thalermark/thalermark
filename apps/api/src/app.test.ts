import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('health route', () => {
  it('returns 200 with status ok', async () => {
    const app = createApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('returns 404 for an unknown route', async () => {
    const app = createApp();
    const res = await app.request('/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('env loader', () => {
  it('defaults port to 3000 when API_PORT is unset', async () => {
    const { loadEnv } = await import('./env.js');
    const env = loadEnv({ NODE_ENV: 'test' });
    expect(env.port).toBe(3000);
    expect(env.nodeEnv).toBe('test');
  });

  it('parses API_PORT when set', async () => {
    const { loadEnv } = await import('./env.js');
    const env = loadEnv({ NODE_ENV: 'test', API_PORT: '8080' });
    expect(env.port).toBe(8080);
  });

  it('rejects non-numeric API_PORT', async () => {
    const { loadEnv } = await import('./env.js');
    expect(() => loadEnv({ NODE_ENV: 'test', API_PORT: 'oops' })).toThrow(/positive integer/);
  });

  it('rejects out-of-range API_PORT', async () => {
    const { loadEnv } = await import('./env.js');
    expect(() => loadEnv({ NODE_ENV: 'test', API_PORT: '99999' })).toThrow(/positive integer/);
  });

  it('rejects an unknown NODE_ENV', async () => {
    const { loadEnv } = await import('./env.js');
    expect(() => loadEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
