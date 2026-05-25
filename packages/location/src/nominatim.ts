import type { AddressAutocompleteProvider, AddressSuggestion, AutocompleteQuery } from './types.js';

// Nominatim is the self-host default — same provider that powers
// openstreetmap.org. The public instance at nominatim.openstreetmap.org has
// a 1 req/sec fair-use policy that production traffic will trip; operators
// running real load should host their own (docker pull mediagis/nominatim)
// and point NOMINATIM_BASE_URL at it.
const DEFAULT_BASE_URL = 'https://nominatim.openstreetmap.org';

interface NominatimItem {
  display_name?: string;
  address?: {
    house_number?: string;
    road?: string;
    pedestrian?: string;
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    suburb?: string;
    state?: string;
    state_district?: string;
    postcode?: string;
    country_code?: string;
  };
}

export interface NominatimProviderConfig {
  // Optional. Defaults to the public OSM instance — fine for dev and tiny
  // self-host; not appropriate for production traffic (see comment above).
  baseUrl?: string;
  // Nominatim's usage policy requires a meaningful User-Agent so operators
  // can be contacted if a deployment misbehaves. Default identifies as
  // Thalermark; self-hosters typically override.
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export function createNominatimProvider(
  config: NominatimProviderConfig = {},
): AddressAutocompleteProvider {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const userAgent = config.userAgent ?? 'Thalermark/1.0 (https://thalermark.com)';
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    name: 'nominatim',
    async autocomplete({ q, country }: AutocompleteQuery): Promise<AddressSuggestion[]> {
      const url = new URL(`${baseUrl}/search`);
      url.searchParams.set('q', q);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('addressdetails', '1');
      url.searchParams.set('limit', '5');
      if (country) url.searchParams.set('countrycodes', country.toLowerCase());

      const res = await fetchImpl(url.toString(), {
        headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`nominatim autocomplete failed: ${res.status}`);
      }
      const body = (await res.json()) as NominatimItem[];
      return body.map(itemToSuggestion);
    },
  };
}

function itemToSuggestion(item: NominatimItem): AddressSuggestion {
  const a = item.address ?? {};
  // House number prefix is locale-aware (some countries write it after the
  // street); Nominatim doesn't expose the order, so we follow the
  // English-speaking norm and prefix it. Users in trailing-number locales
  // can edit after pick.
  const street = a.road ?? a.pedestrian ?? '';
  const addressLine1 = [a.house_number, street].filter(Boolean).join(' ').trim();
  // Nominatim returns the city/town/village under whichever tag the source
  // OSM data used. Walk through them in descending populated-place size.
  const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.suburb ?? '';
  const region = a.state ?? a.state_district ?? '';
  const postalCode = a.postcode ?? '';
  const country = (a.country_code ?? '').toUpperCase();
  const label = item.display_name ?? addressLine1;
  return { label, addressLine1, city, region, postalCode, country };
}
