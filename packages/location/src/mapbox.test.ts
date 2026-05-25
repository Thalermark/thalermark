import { describe, expect, it } from 'vitest';
import { createMapboxProvider } from './mapbox.js';

function fakeFetch(payload: unknown, init: { ok?: boolean; status?: number } = {}): typeof fetch {
  return (async () => {
    return new Response(JSON.stringify(payload), {
      status: init.status ?? (init.ok === false ? 500 : 200),
    });
  }) as unknown as typeof fetch;
}

describe('mapbox provider', () => {
  it('maps a v6 forward response to the suggestion shape', async () => {
    const provider = createMapboxProvider({
      accessToken: 'pk.fake',
      fetchImpl: fakeFetch({
        features: [
          {
            properties: {
              full_address: '111 Main St, Brooklyn, New York 11201, United States',
              name: '111 Main St',
              context: {
                address: { name: '111 Main St' },
                street: { name: 'Main St' },
                postcode: { name: '11201' },
                place: { name: 'Brooklyn' },
                region: { name: 'New York', region_code: 'NY' },
                country: { country_code: 'us' },
              },
            },
          },
        ],
      }),
    });
    const suggestions = await provider.autocomplete({ q: '111 main' });
    expect(suggestions).toEqual([
      {
        label: '111 Main St, Brooklyn, New York 11201, United States',
        addressLine1: '111 Main St',
        city: 'Brooklyn',
        region: 'NY',
        postalCode: '11201',
        country: 'US',
      },
    ]);
  });

  it('falls back when optional fields are missing', async () => {
    const provider = createMapboxProvider({
      accessToken: 'pk.fake',
      fetchImpl: fakeFetch({
        features: [
          {
            properties: {
              name: 'Some Road',
              context: { street: { name: 'Some Road' } },
            },
          },
        ],
      }),
    });
    const [s] = await provider.autocomplete({ q: 'some' });
    expect(s).toEqual({
      label: 'Some Road',
      addressLine1: 'Some Road',
      city: '',
      region: '',
      postalCode: '',
      country: '',
    });
  });

  it('returns empty when features missing', async () => {
    const provider = createMapboxProvider({
      accessToken: 'pk.fake',
      fetchImpl: fakeFetch({}),
    });
    expect(await provider.autocomplete({ q: 'nope' })).toEqual([]);
  });

  it('throws on non-2xx', async () => {
    const provider = createMapboxProvider({
      accessToken: 'pk.fake',
      fetchImpl: fakeFetch({ error: 'rate_limited' }, { status: 429 }),
    });
    await expect(provider.autocomplete({ q: 'x' })).rejects.toThrow(/429/);
  });

  it('passes country bias lowercased', async () => {
    let calledUrl = '';
    const provider = createMapboxProvider({
      accessToken: 'pk.fake',
      fetchImpl: (async (input: string) => {
        calledUrl = input;
        return new Response(JSON.stringify({ features: [] }));
      }) as unknown as typeof fetch,
    });
    await provider.autocomplete({ q: 'main', country: 'US' });
    expect(calledUrl).toContain('country=us');
  });
});
