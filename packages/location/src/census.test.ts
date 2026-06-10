import { describe, expect, it } from 'vitest';
import { createCensusProvider } from './census.js';

function fakeFetch(payload: unknown, init: { status?: number } = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: init.status ?? 200,
    })) as unknown as typeof fetch;
}

// Shape mirrors a real onelineaddress response (trimmed to the fields we read).
const dartmoor = {
  result: {
    addressMatches: [
      {
        matchedAddress: '17483 W DARTMOOR DR, GRAYSLAKE, IL, 60030',
        addressComponents: { city: 'GRAYSLAKE', state: 'IL', zip: '60030' },
      },
    ],
  },
};

describe('census provider', () => {
  it('maps a matched address to the suggestion shape and title-cases it', async () => {
    const provider = createCensusProvider({ fetchImpl: fakeFetch(dartmoor) });
    const suggestions = await provider.autocomplete({ q: '17483 w dartmoor' });
    expect(suggestions).toEqual([
      {
        label: '17483 W Dartmoor Dr, Grayslake, IL 60030',
        addressLine1: '17483 W Dartmoor Dr',
        city: 'Grayslake',
        region: 'IL',
        postalCode: '60030',
        country: 'US',
      },
    ]);
  });

  it('always reports country US', async () => {
    const provider = createCensusProvider({ fetchImpl: fakeFetch(dartmoor) });
    const [s] = await provider.autocomplete({ q: 'x' });
    expect(s?.country).toBe('US');
  });

  it('returns empty when there are no matches', async () => {
    const provider = createCensusProvider({
      fetchImpl: fakeFetch({ result: { addressMatches: [] } }),
    });
    expect(await provider.autocomplete({ q: 'nowhere' })).toEqual([]);
  });

  it('returns empty when the result envelope is missing', async () => {
    const provider = createCensusProvider({ fetchImpl: fakeFetch({}) });
    expect(await provider.autocomplete({ q: 'x' })).toEqual([]);
  });

  it('caps at five matches', async () => {
    const many = {
      result: {
        addressMatches: Array.from({ length: 9 }, (_, i) => ({
          matchedAddress: `${i} MAIN ST, ANYTOWN, IL, 60000`,
          addressComponents: { city: 'ANYTOWN', state: 'IL', zip: '60000' },
        })),
      },
    };
    const provider = createCensusProvider({ fetchImpl: fakeFetch(many) });
    expect(await provider.autocomplete({ q: 'main' })).toHaveLength(5);
  });

  it('sends the onelineaddress + current benchmark query', async () => {
    let calledUrl = '';
    const provider = createCensusProvider({
      fetchImpl: (async (input: string) => {
        calledUrl = input;
        return new Response(JSON.stringify({ result: { addressMatches: [] } }));
      }) as unknown as typeof fetch,
    });
    await provider.autocomplete({ q: '17483 w dartmoor dr' });
    expect(calledUrl).toContain('/geocoder/locations/onelineaddress');
    expect(calledUrl).toContain('benchmark=Public_AR_Current');
    expect(calledUrl).toContain('address=17483');
  });

  it('throws on a non-2xx response', async () => {
    const provider = createCensusProvider({
      fetchImpl: fakeFetch({ error: 'down' }, { status: 503 }),
    });
    await expect(provider.autocomplete({ q: 'x' })).rejects.toThrow(/503/);
  });
});
