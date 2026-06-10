import { createCensusProvider } from './census.js';
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
// pick mapbox when a token is set and the US Census geocoder otherwise. Census
// is the no-config default because it's free + keyless and its TIGER data
// covers US residential addresses that OpenStreetMap (Nominatim) is missing —
// the right default for a US-first product. Set MAPBOX_ACCESS_TOKEN to upgrade
// to Mapbox (better typeahead + international); set LOCATION_PROVIDER=nominatim
// to force the OSS/international fallback. An unknown name throws at boot
// rather than silently degrading, so a typo in compose env is loud.
export function createAddressAutocompleteProvider(env: LocationEnv): AddressAutocompleteProvider {
  const explicit = env.LOCATION_PROVIDER?.trim().toLowerCase();
  const provider = explicit || (env.MAPBOX_ACCESS_TOKEN ? 'mapbox' : 'census');

  if (provider === 'mapbox') {
    const token = env.MAPBOX_ACCESS_TOKEN?.trim();
    if (!token) {
      throw new Error('LOCATION_PROVIDER=mapbox requires MAPBOX_ACCESS_TOKEN');
    }
    return createMapboxProvider({ accessToken: token });
  }

  if (provider === 'census') {
    return createCensusProvider();
  }

  if (provider === 'nominatim') {
    return createNominatimProvider({
      baseUrl: env.NOMINATIM_BASE_URL?.trim() || undefined,
      userAgent: env.NOMINATIM_USER_AGENT?.trim() || undefined,
    });
  }

  throw new Error(`unknown LOCATION_PROVIDER: ${provider}`);
}
