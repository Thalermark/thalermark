import type { AddressAutocompleteProvider, AddressSuggestion, AutocompleteQuery } from './types.js';

// Mapbox Geocoding v6 forward endpoint with autocomplete=true returns
// per-keystroke-friendly structured addresses in a single call. We avoid the
// newer Search Box API because it requires a session-token + two-phase
// suggest/retrieve dance; for the MVP volume the geocode endpoint is
// equivalent quality at half the request count.
const MAPBOX_FORWARD_URL = 'https://api.mapbox.com/search/geocode/v6/forward';

// The pieces of the Mapbox response we actually consume. Mapbox's full schema
// is wide and version-drift-prone; pinning a narrow type means a Mapbox
// addition can't break our parse, and a Mapbox rename will fail the unit test
// rather than ship empty suggestions to users.
interface MapboxFeature {
  properties?: {
    full_address?: string;
    place_formatted?: string;
    name?: string;
    context?: {
      address?: { name?: string };
      street?: { name?: string };
      postcode?: { name?: string };
      place?: { name?: string };
      region?: { name?: string; region_code?: string };
      country?: { country_code?: string };
    };
  };
}

interface MapboxResponse {
  features?: MapboxFeature[];
}

export interface MapboxProviderConfig {
  accessToken: string;
  // Override for tests. Defaults to global fetch.
  fetchImpl?: typeof fetch;
}

export function createMapboxProvider(config: MapboxProviderConfig): AddressAutocompleteProvider {
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    name: 'mapbox',
    async autocomplete({ q, country }: AutocompleteQuery): Promise<AddressSuggestion[]> {
      const url = new URL(MAPBOX_FORWARD_URL);
      url.searchParams.set('q', q);
      url.searchParams.set('access_token', config.accessToken);
      url.searchParams.set('autocomplete', 'true');
      url.searchParams.set('types', 'address');
      url.searchParams.set('limit', '5');
      if (country) url.searchParams.set('country', country.toLowerCase());

      const res = await fetchImpl(url.toString());
      if (!res.ok) {
        throw new Error(`mapbox autocomplete failed: ${res.status}`);
      }
      const body = (await res.json()) as MapboxResponse;
      const features = body.features ?? [];
      return features.map(featureToSuggestion);
    },
  };
}

function featureToSuggestion(feature: MapboxFeature): AddressSuggestion {
  const props = feature.properties ?? {};
  const ctx = props.context ?? {};
  // address.name is the full house-number + street ("111 Main St"); fall
  // back to street.name + the top-level feature name when the address
  // component is missing (rare, but Mapbox can elide it for non-numbered
  // streets).
  const addressLine1 = ctx.address?.name ?? ctx.street?.name ?? props.name ?? '';
  const city = ctx.place?.name ?? '';
  // Prefer the 2-letter region_code ("NY") over the long-form name ("New
  // York") because the form's region field is single-line and short codes
  // render better; also matches US/CA convention.
  const region = ctx.region?.region_code ?? ctx.region?.name ?? '';
  const postalCode = ctx.postcode?.name ?? '';
  const country = (ctx.country?.country_code ?? '').toUpperCase();
  const label = props.full_address ?? props.place_formatted ?? addressLine1;
  return { label, addressLine1, city, region, postalCode, country };
}
