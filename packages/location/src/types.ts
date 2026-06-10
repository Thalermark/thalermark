// Address autocomplete is intentionally provider-agnostic so the SaaS host
// (Mapbox: cheap + good quality) and self-hosters (Nominatim: zero cost, run
// it yourself) can swap behind a single env flag with no code change. The
// suggestion shape is the lowest-common-denominator structured address — the
// fields the customer form actually writes — so neither provider's extras
// (Mapbox feature ids, Nominatim place hierarchies) leak into UI code.

export interface AddressSuggestion {
  // Display label used in the dropdown. Provider's already-localized
  // "111 Main St, Brooklyn, NY 11201, United States" string.
  label: string;
  // Structured fields, mapped 1:1 onto the flat columns on customers
  // (addressLine1 / city / region / postalCode / country). Each may be
  // empty when the provider didn't return a component for that slot.
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
  // ISO 3166-1 alpha-2 uppercase. Empty when the provider didn't classify.
  country: string;
}

export interface AutocompleteQuery {
  q: string;
  // Optional bias to a country (ISO alpha-2). Both providers accept this
  // as a hint, not a filter — passing "US" weights results toward the US
  // without excluding others.
  country?: string;
}

export interface AddressAutocompleteProvider {
  readonly name: 'mapbox' | 'census' | 'nominatim';
  autocomplete(query: AutocompleteQuery): Promise<AddressSuggestion[]>;
}
