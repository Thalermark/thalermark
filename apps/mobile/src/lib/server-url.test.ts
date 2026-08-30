import { afterEach, describe, expect, it, vi } from 'vitest';

// secure-store wraps expo-secure-store, which needs a native module. Stubbing it
// is what lets the rest of this file run on a laptop at all.
vi.mock('./secure-store', () => ({
  clearStoredServerUrl: vi.fn(async () => {}),
  getStoredServerUrl: vi.fn(async () => null),
  setStoredServerUrl: vi.fn(async () => {}),
}));

import { normalizeUrl, probeServer } from './server-url';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeUrl', () => {
  it('strips trailing slashes so `${url}/api/...` never doubles up', () => {
    expect(normalizeUrl('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(normalizeUrl('http://localhost:3000///')).toBe('http://localhost:3000');
  });

  it('trims whitespace, which is what a typed-in address arrives with', () => {
    expect(normalizeUrl('  https://app.thalermark.com  ')).toBe('https://app.thalermark.com');
  });

  it('leaves an already-clean url alone', () => {
    expect(normalizeUrl('https://app.thalermark.com')).toBe('https://app.thalermark.com');
  });
});

// Three outcomes, not two. "The address is wrong" and "the address is right and
// the server is struggling" are different facts and the user acts on them
// differently (TMC-278).
describe('probeServer', () => {
  const respond = (body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => body })),
    );

  it('is ok when the server reports it can serve', async () => {
    respond({ status: 'ok' });
    expect(await probeServer('http://localhost:3000')).toEqual({ kind: 'ok' });
  });

  it('is degraded, NOT unreachable, when the database is down', async () => {
    // The address is correct here. Saying "couldn't reach a server" would send
    // someone off to edit an address that was right all along.
    respond({ status: 'error' });
    expect(await probeServer('http://localhost:3000')).toEqual({ kind: 'degraded' });
  });

  it('is unreachable when something answers without our status field', async () => {
    // The TMC-278 bug in miniature: the proxy serves the web app's sign-in page
    // for anything outside /api/*, so a probe can get a perfectly good 200 of
    // HTML from a perfectly good server and must not read that as ok.
    respond({ notOurs: true });
    expect(await probeServer('http://localhost:3000')).toEqual({ kind: 'unreachable' });
  });

  it('is unreachable when the body is not JSON at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => {
          throw new Error('not json');
        },
      })),
    );
    expect(await probeServer('http://localhost:3000')).toEqual({ kind: 'unreachable' });
  });

  it('is unreachable when the request throws, rather than propagating', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    expect(await probeServer('http://nope.invalid')).toEqual({ kind: 'unreachable' });
  });

  it('probes /ready, not /health', async () => {
    // /health lives at the ROOT of the api service, so it is only reachable when
    // the api IS the origin. Under either compose file the proxy sends it to the
    // web app instead. /ready is routed explicitly in both Caddyfiles.
    const fetchMock = vi.fn(async () => ({ json: async () => ({ status: 'ok' }) }));
    vi.stubGlobal('fetch', fetchMock);
    await probeServer('http://localhost:3000/');
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/ready', { method: 'GET' });
  });
});
