import type { AddressAutocompleteProvider, AddressSuggestion, AutocompleteQuery } from './types.js';

// US Census Bureau geocoder. Free, no API key, no signup — and backed by the
// Census TIGER/Line dataset, which has comprehensive US residential coverage
// including subdivision streets that OpenStreetMap (and therefore Nominatim /
// Photon) simply don't have. That coverage gap is the reason this is the
// no-config default for a US-first product: a typical suburban house OSM can't
// find resolves here. The trade-off is US-only and it's an address geocoder,
// not a per-keystroke typeahead engine — it wants a fairly complete
// house-number + street string before it matches (it tolerates a missing
// suffix / city, but not a bare street prefix).
//
// onelineaddress endpoint, "current" benchmark (the live TIGER vintage).
const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const BENCHMARK = 'Public_AR_Current';
const MAX_RESULTS = 5;

// The slice of the Census response we consume. The full schema also carries
// coordinates / tigerLine / a block range; we only need the canonical address
// + its city/state/zip components. addressComponents.city/state/zip are
// reliable; the house number lives in matchedAddress, NOT in fromAddress
// (that's the block range start, which can differ from the matched number).
interface CensusMatch {
  matchedAddress?: string;
  addressComponents?: {
    city?: string;
    state?: string;
    zip?: string;
  };
}

interface CensusResponse {
  result?: {
    addressMatches?: CensusMatch[];
  };
}

export interface CensusProviderConfig {
  // Override for tests. Defaults to global fetch.
  fetchImpl?: typeof fetch;
}

export function createCensusProvider(
  config: CensusProviderConfig = {},
): AddressAutocompleteProvider {
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    name: 'census',
    // country is ignored: the Census geocoder is US-only by construction, so
    // there's nothing to bias toward. International addresses return no match.
    async autocomplete({ q }: AutocompleteQuery): Promise<AddressSuggestion[]> {
      const url = new URL(CENSUS_URL);
      url.searchParams.set('address', q);
      url.searchParams.set('benchmark', BENCHMARK);
      url.searchParams.set('format', 'json');

      const res = await fetchImpl(url.toString());
      if (!res.ok) {
        throw new Error(`census autocomplete failed: ${res.status}`);
      }
      const body = (await res.json()) as CensusResponse;
      const matches = body.result?.addressMatches ?? [];
      return matches.slice(0, MAX_RESULTS).map(matchToSuggestion);
    },
  };
}

// Census returns ALL CAPS ("17483 W DARTMOOR DR"); title-case it so the form
// fields read naturally. Single-letter tokens (the "W" directional, state
// abbreviations) are left as-is by capitalizing the first letter and lowering
// the rest — "W" stays "W", "DARTMOOR" becomes "Dartmoor".
function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function matchToSuggestion(match: CensusMatch): AddressSuggestion {
  const full = match.matchedAddress ?? '';
  const comp = match.addressComponents ?? {};
  // matchedAddress is canonical "STREET, CITY, STATE, ZIP". The street line is
  // everything before the first comma; the structured components carry the
  // rest more reliably than re-splitting.
  const street = full.split(',')[0]?.trim() ?? '';
  const addressLine1 = titleCase(street);
  const city = titleCase(comp.city ?? '');
  // Census returns the 2-letter state code already (matches the short-code
  // convention the other providers normalize to).
  const region = comp.state ?? '';
  const postalCode = comp.zip ?? '';
  // Rebuild the label from the cleaned parts (rather than title-casing the raw
  // matchedAddress) so the state code stays "IL", not "Il".
  const label = [addressLine1, city, [region, postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return { label, addressLine1, city, region, postalCode, country: 'US' };
}
