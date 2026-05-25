import { describe, expect, it } from 'vitest';
import { createAddressAutocompleteProvider } from './factory.js';

describe('createAddressAutocompleteProvider', () => {
  it('picks mapbox when token is set and no explicit provider', () => {
    const p = createAddressAutocompleteProvider({ MAPBOX_ACCESS_TOKEN: 'pk.fake' });
    expect(p.name).toBe('mapbox');
  });

  it('picks nominatim by default when no token', () => {
    const p = createAddressAutocompleteProvider({});
    expect(p.name).toBe('nominatim');
  });

  it('honours explicit LOCATION_PROVIDER=nominatim even when a token is set', () => {
    const p = createAddressAutocompleteProvider({
      LOCATION_PROVIDER: 'nominatim',
      MAPBOX_ACCESS_TOKEN: 'pk.fake',
    });
    expect(p.name).toBe('nominatim');
  });

  it('throws when LOCATION_PROVIDER=mapbox without token', () => {
    expect(() => createAddressAutocompleteProvider({ LOCATION_PROVIDER: 'mapbox' })).toThrow(
      /MAPBOX_ACCESS_TOKEN/,
    );
  });

  it('throws on unknown provider', () => {
    expect(() => createAddressAutocompleteProvider({ LOCATION_PROVIDER: 'google' })).toThrow(
      /unknown LOCATION_PROVIDER/,
    );
  });

  it('treats blank LOCATION_PROVIDER as unset', () => {
    const p = createAddressAutocompleteProvider({
      LOCATION_PROVIDER: '  ',
      MAPBOX_ACCESS_TOKEN: 'pk.fake',
    });
    expect(p.name).toBe('mapbox');
  });
});
