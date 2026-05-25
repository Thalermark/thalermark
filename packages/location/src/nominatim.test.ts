import { describe, expect, it } from 'vitest';
import { createNominatimProvider } from './nominatim.js';

function fakeFetch(payload: unknown, init: { status?: number } = {}): typeof fetch {
  return (async () => {
    return new Response(JSON.stringify(payload), { status: init.status ?? 200 });
  }) as unknown as typeof fetch;
}

describe('nominatim provider', () => {
  it('maps a jsonv2 response to the suggestion shape', async () => {
    const provider = createNominatimProvider({
      fetchImpl: fakeFetch([
        {
          display_name: '111, Main Street, Brooklyn, NY 11201, United States',
          address: {
            house_number: '111',
            road: 'Main Street',
            town: 'Brooklyn',
            state: 'New York',
            postcode: '11201',
            country_code: 'us',
          },
        },
      ]),
    });
    const [s] = await provider.autocomplete({ q: '111 main' });
    expect(s).toEqual({
      label: '111, Main Street, Brooklyn, NY 11201, United States',
      addressLine1: '111 Main Street',
      city: 'Brooklyn',
      region: 'New York',
      postalCode: '11201',
      country: 'US',
    });
  });

  it('prefers city over town over village', async () => {
    const provider = createNominatimProvider({
      fetchImpl: fakeFetch([
        { display_name: 'x', address: { town: 'T', village: 'V' } },
        { display_name: 'y', address: { city: 'C', town: 'T' } },
      ]),
    });
    const out = await provider.autocomplete({ q: 'x' });
    expect(out[0]?.city).toBe('T');
    expect(out[1]?.city).toBe('C');
  });

  it('handles missing house number', async () => {
    const provider = createNominatimProvider({
      fetchImpl: fakeFetch([{ display_name: 'just a road', address: { road: 'Just A Road' } }]),
    });
    const [s] = await provider.autocomplete({ q: 'r' });
    expect(s?.addressLine1).toBe('Just A Road');
  });

  it('strips trailing slashes on baseUrl', async () => {
    let calledUrl = '';
    const provider = createNominatimProvider({
      baseUrl: 'https://nom.example/',
      fetchImpl: (async (input: string) => {
        calledUrl = input;
        return new Response('[]');
      }) as unknown as typeof fetch,
    });
    await provider.autocomplete({ q: 'x' });
    expect(calledUrl.startsWith('https://nom.example/search?')).toBe(true);
  });

  it('sends a User-Agent', async () => {
    let headers: Headers | undefined;
    const provider = createNominatimProvider({
      userAgent: 'Test/1.0',
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        headers = new Headers(init?.headers);
        return new Response('[]');
      }) as unknown as typeof fetch,
    });
    await provider.autocomplete({ q: 'x' });
    expect(headers?.get('user-agent')).toBe('Test/1.0');
  });

  it('throws on non-2xx', async () => {
    const provider = createNominatimProvider({ fetchImpl: fakeFetch({}, { status: 503 }) });
    await expect(provider.autocomplete({ q: 'x' })).rejects.toThrow(/503/);
  });
});
