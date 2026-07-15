import { describe, expect, it } from 'vitest';
import { createGooglePlacesProvider } from './google.js';

function fakeFetch(payload: unknown, init: { ok?: boolean; status?: number } = {}): typeof fetch {
  return (async () => {
    return new Response(JSON.stringify(payload), {
      status: init.status ?? (init.ok === false ? 500 : 200),
    });
  }) as unknown as typeof fetch;
}

const autocompletePayload = {
  suggestions: [
    {
      placePrediction: {
        placeId: 'ChIJplace123',
        text: { text: '123 Main St, Brooklyn, NY 11201, USA' },
      },
    },
    {
      // A query prediction (no placeId) — should be dropped, not returned.
      queryPrediction: { text: { text: 'main street' } },
    },
  ],
};

const detailsPayload = {
  formattedAddress: '123 Main St, Brooklyn, NY 11201, USA',
  addressComponents: [
    { longText: '123', shortText: '123', types: ['street_number'] },
    { longText: 'Main Street', shortText: 'Main St', types: ['route'] },
    { longText: 'Brooklyn', shortText: 'Brooklyn', types: ['locality', 'political'] },
    {
      longText: 'New York',
      shortText: 'NY',
      types: ['administrative_area_level_1', 'political'],
    },
    { longText: '11201', shortText: '11201', types: ['postal_code'] },
    { longText: 'United States', shortText: 'US', types: ['country', 'political'] },
  ],
};

describe('google places provider', () => {
  it('maps autocomplete suggestions to predictions and drops query predictions', async () => {
    const provider = createGooglePlacesProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch(autocompletePayload),
    });
    const predictions = await provider.autocomplete({ q: '123 main' });
    expect(predictions).toEqual([
      { placeId: 'ChIJplace123', label: '123 Main St, Brooklyn, NY 11201, USA' },
    ]);
  });

  it('maps place details components to the structured suggestion', async () => {
    const provider = createGooglePlacesProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch(detailsPayload),
    });
    const suggestion = await provider.retrieve({ placeId: 'ChIJplace123' });
    expect(suggestion).toEqual({
      label: '123 Main St, Brooklyn, NY 11201, USA',
      // street_number + route, joined.
      addressLine1: '123 Main Street',
      city: 'Brooklyn',
      // admin_area_level_1 shortText, not the long "New York".
      region: 'NY',
      postalCode: '11201',
      // country shortText, uppercased.
      country: 'US',
    });
  });

  it('falls back through postal_town / sublocality when locality is absent', async () => {
    const provider = createGooglePlacesProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch({
        formattedAddress: '10 Downing St, London SW1A 2AA, UK',
        addressComponents: [
          { longText: '10', types: ['street_number'] },
          { longText: 'Downing Street', types: ['route'] },
          { longText: 'London', shortText: 'London', types: ['postal_town'] },
          { longText: 'SW1A 2AA', types: ['postal_code'] },
          { longText: 'United Kingdom', shortText: 'GB', types: ['country'] },
        ],
      }),
    });
    const s = await provider.retrieve({ placeId: 'x' });
    expect(s?.city).toBe('London');
    expect(s?.country).toBe('GB');
  });

  it('biases autocomplete to the country via includedRegionCodes (lowercased)', async () => {
    let sentBody = '';
    const provider = createGooglePlacesProvider({
      apiKey: 'k',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sentBody = String(init.body);
        return new Response(JSON.stringify({ suggestions: [] }));
      }) as unknown as typeof fetch,
    });
    await provider.autocomplete({ q: 'main', country: 'US' });
    expect(JSON.parse(sentBody)).toMatchObject({ includedRegionCodes: ['us'] });
  });

  it('threads the session token through autocomplete and retrieve', async () => {
    let autoBody = '';
    let detailsUrl = '';
    const provider = createGooglePlacesProvider({
      apiKey: 'k',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          autoBody = String(init.body);
          return new Response(JSON.stringify({ suggestions: [] }));
        }
        detailsUrl = url;
        return new Response(JSON.stringify(detailsPayload));
      }) as unknown as typeof fetch,
    });
    await provider.autocomplete({ q: 'main', sessionToken: 'sess-1' });
    await provider.retrieve({ placeId: 'p1', sessionToken: 'sess-1' });
    expect(JSON.parse(autoBody)).toMatchObject({ sessionToken: 'sess-1' });
    expect(detailsUrl).toContain('sessionToken=sess-1');
  });

  it('throws on a non-2xx autocomplete', async () => {
    const provider = createGooglePlacesProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch({ error: 'rate_limited' }, { status: 429 }),
    });
    await expect(provider.autocomplete({ q: 'x' })).rejects.toThrow(/429/);
  });

  it('throws on a non-2xx place details', async () => {
    const provider = createGooglePlacesProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch({ error: 'not_found' }, { status: 404 }),
    });
    await expect(provider.retrieve({ placeId: 'x' })).rejects.toThrow(/404/);
  });
});
