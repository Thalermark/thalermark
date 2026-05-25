import { createMapboxProvider } from './mapbox.js';
import { createNominatimProvider } from './nominatim.js';
import type { AddressAutocompleteProvider } from './types.js';

export interface LocationEnv {
  LOCATION_PROVIDER?: string;
  MAPBOX_ACCESS_TOKEN?: string;
  NOMINATIM_BASE_URL?: string;
  NOMINATIM_USER_AGENT?: string;
}

// Picks the provider per env. Explicit LOCATION_PROVIDER wins; otherwise we
// pick mapbox when the token is set and nominatim otherwise — gives a
// no-config dev experience (just works on the public OSM endpoint) and a
// no-code-change production toggle (set MAPBOX_ACCESS_TOKEN to switch). An
// unknown provider name throws at boot rather than silently falling back, so
// a typo in compose env doesn't ship Nominatim to a customer expecting
// Mapbox-quality results.
export function createAddressAutocompleteProvider(env: LocationEnv): AddressAutocompleteProvider {
  const explicit = env.LOCATION_PROVIDER?.trim().toLowerCase();
  const provider = explicit || (env.MAPBOX_ACCESS_TOKEN ? 'mapbox' : 'nominatim');

  if (provider === 'mapbox') {
    const token = env.MAPBOX_ACCESS_TOKEN?.trim();
    if (!token) {
      throw new Error('LOCATION_PROVIDER=mapbox requires MAPBOX_ACCESS_TOKEN');
    }
    return createMapboxProvider({ accessToken: token });
  }

  if (provider === 'nominatim') {
    return createNominatimProvider({
      baseUrl: env.NOMINATIM_BASE_URL?.trim() || undefined,
      userAgent: env.NOMINATIM_USER_AGENT?.trim() || undefined,
    });
  }

  throw new Error(`unknown LOCATION_PROVIDER: ${provider}`);
}
