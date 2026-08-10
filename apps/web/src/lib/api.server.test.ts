import { afterEach, describe, expect, it, vi } from 'vitest';

// TMC-248. The behaviour under test only happens when a socket dies, so it is
// the kind that ships broken and is discovered by a user mid-invoice. What
// matters is the SHAPE the rest of the app sees: a resolved 503 carrying a code
// the error catalogue knows, rather than a rejection nobody catches.

// $env/dynamic/* only exists inside the SvelteKit build, so stub both before
// importing the module under test.
vi.mock('$env/dynamic/private', () => ({ env: { INTERNAL_API_URL: 'http://api.test' } }));
vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_API_URL: '' } }));

const event = {
  request: { headers: new Headers() },
  locals: {},
} as unknown as import('@sveltejs/kit').RequestEvent;

afterEach(() => vi.unstubAllGlobals());

describe('serverApiClient when the API cannot be reached', () => {
  it('resolves a 503 instead of rejecting', async () => {
    // Every transport failure arrives this way: DNS, refused connection, reset
    // socket, TLS. Undici throws a TypeError; the cause varies and is not ours.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const { serverApiClient } = await import('./api.server');

    const res = await serverApiClient(event).api.contacts.$get({ query: {} });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
  });

  it('carries a code the shared catalogue turns into a sentence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    );
    const [{ serverApiClient }, { apiErrorMessage }] = await Promise.all([
      import('./api.server'),
      import('./api-errors'),
    ]);

    const res = await serverApiClient(event).api.contacts.$get({ query: {} });
    const body = (await res.json()) as { error?: string };

    // This is the whole point: a call site's existing `if (!res.ok)` branch
    // reads the body, hands the code to apiErrorMessage, and gets a sentence —
    // without knowing that the failure was a dead socket rather than a 4xx.
    expect(body.error).toBe('unreachable');
    expect(apiErrorMessage(body.error, 'unused fallback')).toMatch(/could not reach/i);
  });

  it('leaves a real HTTP failure exactly as it was', async () => {
    // The wrapper must not swallow or reshape an answer the API actually gave.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_recipient' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    const { serverApiClient } = await import('./api.server');

    const res = await serverApiClient(event).api.contacts.$get({ query: {} });

    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toEqual({ error: 'invalid_recipient' });
  });

  it('passes a successful response through untouched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ contacts: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    const { serverApiClient } = await import('./api.server');

    const res = await serverApiClient(event).api.contacts.$get({ query: {} });

    expect(res.ok).toBe(true);
    expect((await res.json()) as unknown).toEqual({ contacts: [] });
  });
});
