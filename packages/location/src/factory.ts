import { createGooglePlacesProvider } from './google.js';
import type { AddressAutocompleteProvider } from './types.js';

export interface LocationEnv {
  GOOGLE_PLACES_API_KEY?: string;
}

// Address autocomplete is powered by Google Places (New). It's optional: set
// GOOGLE_PLACES_API_KEY to enable it, leave it unset (or blank) to run without
// — the address field then degrades to plain manual entry rather than erroring.
// Returns null in the disabled case so callers (the api boot + the SvelteKit
// proxy) branch on it directly, no try/catch around construction needed.
export function createAddressAutocompleteProvider(
  env: LocationEnv,
): AddressAutocompleteProvider | null {
  const apiKey = env.GOOGLE_PLACES_API_KEY?.trim();
  if (!apiKey) return null;
  return createGooglePlacesProvider({ apiKey });
}
