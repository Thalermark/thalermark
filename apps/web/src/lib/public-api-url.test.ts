import { beforeEach, describe, expect, it, vi } from 'vitest';

// The base URL every BROWSER-side call is built from, including the sign-up POST
// that carries a password (TMC-237). The case that matters is an unset variable
// in a production build: it used to resolve to http://localhost:3000, aiming
// those requests at the visitor's own machine.
async function resolve(opts: { url?: string; dev: boolean }) {
  vi.resetModules();
  vi.doMock('$app/environment', () => ({ dev: opts.dev }));
  vi.doMock('$env/dynamic/public', () => ({
    env: opts.url === undefined ? {} : { PUBLIC_API_URL: opts.url },
  }));
  return (await import('./public-api-url.js')).publicApiBaseUrl;
}

describe('publicApiBaseUrl', () => {
  beforeEach(() => vi.resetModules());

  it('uses an explicit URL, in dev and in production', async () => {
    expect(await resolve({ url: 'https://api.example.com', dev: false })).toBe(
      'https://api.example.com',
    );
    expect(await resolve({ url: 'https://api.example.com', dev: true })).toBe(
      'https://api.example.com',
    );
  });

  it('treats an EMPTY value as a real answer: relative, same origin', async () => {
    // The self-host default. Caddy serves the api and the web app on one origin,
    // so this must not fall through to a fallback — which is why the source uses
    // ?? and not ||.
    expect(await resolve({ url: '', dev: false })).toBe('');
    expect(await resolve({ url: '', dev: true })).toBe('');
  });

  it('never points a production build at the visitor’s own machine', async () => {
    // The regression this exists for. Unset in production resolves to relative,
    // which is what a misconfigured deploy almost certainly wanted, and being
    // wrong that way is a broken request rather than a password sent to
    // localhost.
    const resolved = await resolve({ url: undefined, dev: false });
    expect(resolved).toBe('');
    expect(resolved).not.toContain('localhost');
  });

  it('keeps the localhost convenience in dev, where it is correct', async () => {
    expect(await resolve({ url: undefined, dev: true })).toBe('http://localhost:3000');
  });
});
