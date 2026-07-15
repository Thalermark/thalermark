import type {
  AddressAutocompleteProvider,
  AddressPrediction,
  AddressSuggestion,
  AutocompleteQuery,
  RetrieveQuery,
} from './types.js';

// Google Places API (New). Two-phase by design: places:autocomplete returns
// cheap predictions (placeId + a formatted label) on each keystroke, then a
// single Place Details GET resolves the structured components when the user
// picks one. A client-minted sessionToken threads through both calls so Google
// bills the pair as one autocomplete session rather than per request. The key
// is used server-side only (this runs in the api boot + the SvelteKit proxy),
// so it never reaches the browser and needs no HTTP-referrer restriction.
const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const DETAILS_BASE_URL = 'https://places.googleapis.com/v1/places';
const MAX_RESULTS = 5;

// The slices of the Google responses we consume. Pinning narrow types means a
// Google field addition can't break our parse, and a rename fails the unit
// test rather than silently shipping empty results to users.
interface GooglePrediction {
  placePrediction?: {
    placeId?: string;
    text?: { text?: string };
  };
}

interface GoogleAutocompleteResponse {
  suggestions?: GooglePrediction[];
}

interface GoogleAddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

interface GooglePlace {
  formattedAddress?: string;
  addressComponents?: GoogleAddressComponent[];
}

export interface GooglePlacesProviderConfig {
  apiKey: string;
  // Override for tests. Defaults to global fetch.
  fetchImpl?: typeof fetch;
}

export function createGooglePlacesProvider(
  config: GooglePlacesProviderConfig,
): AddressAutocompleteProvider {
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    name: 'google',
    async autocomplete({
      q,
      country,
      sessionToken,
    }: AutocompleteQuery): Promise<AddressPrediction[]> {
      const body: Record<string, unknown> = { input: q };
      if (sessionToken) body.sessionToken = sessionToken;
      // includedRegionCodes biases (not filters) toward a country; Google wants
      // lowercase region codes.
      if (country) body.includedRegionCodes = [country.toLowerCase()];

      const res = await fetchImpl(AUTOCOMPLETE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': config.apiKey,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`google autocomplete failed: ${res.status}`);
      }
      const data = (await res.json()) as GoogleAutocompleteResponse;
      const suggestions = data.suggestions ?? [];
      return suggestions
        .slice(0, MAX_RESULTS)
        .map(predictionToAddress)
        .filter((p): p is AddressPrediction => p !== null);
    },

    async retrieve({ placeId, sessionToken }: RetrieveQuery): Promise<AddressSuggestion | null> {
      const url = new URL(`${DETAILS_BASE_URL}/${encodeURIComponent(placeId)}`);
      if (sessionToken) url.searchParams.set('sessionToken', sessionToken);

      const res = await fetchImpl(url.toString(), {
        headers: {
          'X-Goog-Api-Key': config.apiKey,
          // The details endpoint requires a field mask; keep it minimal
          // (addressComponents drives the structured fields, formattedAddress
          // the label) so we're billed at the cheapest data tier.
          'X-Goog-FieldMask': 'formattedAddress,addressComponents',
        },
      });
      if (!res.ok) {
        throw new Error(`google place details failed: ${res.status}`);
      }
      const place = (await res.json()) as GooglePlace;
      return placeToSuggestion(place);
    },
  };
}

function predictionToAddress(prediction: GooglePrediction): AddressPrediction | null {
  const p = prediction.placePrediction;
  // Query predictions (no placeId) can't be retrieved; drop them.
  if (!p?.placeId) return null;
  return { placeId: p.placeId, label: p.text?.text ?? '' };
}

function placeToSuggestion(place: GooglePlace): AddressSuggestion {
  const comps = place.addressComponents ?? [];
  const find = (type: string) => comps.find((c) => c.types?.includes(type));
  const streetNumber = find('street_number')?.longText ?? '';
  const route = find('route')?.longText ?? '';
  const addressLine1 = [streetNumber, route].filter(Boolean).join(' ');
  // locality is the city; postal_town (UK) and sublocality are fallbacks Google
  // uses where locality is absent.
  const city =
    find('locality')?.longText ??
    find('postal_town')?.longText ??
    find('sublocality')?.longText ??
    '';
  // administrative_area_level_1 shortText is the 2-letter state/province code
  // ("NY"), matching the short-code convention the form's region field wants.
  const region = find('administrative_area_level_1')?.shortText ?? '';
  const postalCode = find('postal_code')?.longText ?? '';
  // country shortText is the ISO 3166-1 alpha-2 code — satisfies the contact
  // schema's country max-2 validation.
  const country = (find('country')?.shortText ?? '').toUpperCase();
  const label = place.formattedAddress ?? addressLine1;
  return { label, addressLine1, city, region, postalCode, country };
}
