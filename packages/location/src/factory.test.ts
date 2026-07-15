import { describe, expect, it } from 'vitest';
import { createAddressAutocompleteProvider } from './factory.js';

describe('createAddressAutocompleteProvider', () => {
  it('returns the google provider when a key is set', () => {
    const p = createAddressAutocompleteProvider({ GOOGLE_PLACES_API_KEY: 'k' });
    expect(p?.name).toBe('google');
  });

  it('returns null when no key is set', () => {
    expect(createAddressAutocompleteProvider({})).toBeNull();
  });

  it('treats a blank key as unset', () => {
    expect(createAddressAutocompleteProvider({ GOOGLE_PLACES_API_KEY: '  ' })).toBeNull();
  });
});
