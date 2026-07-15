// Address autocomplete is powered by Google Places (New), the one provider we
// support. The interface is deliberately two-phase to match Google's model:
// cheap `autocomplete` predictions on each keystroke, then a single `retrieve`
// (Place Details) lookup when the user actually picks a suggestion. A
// client-minted session token threads through both so Google bills one session
// per address rather than per keystroke. Keeping the shapes provider-shaped
// (not Google-shaped) means the routes and UI never learn Google's field names.

export interface AddressPrediction {
  // Opaque provider place id, fed back to retrieve() when the user picks this.
  placeId: string;
  // Display label for the dropdown — Google's already-formatted address line.
  label: string;
}

export interface AddressSuggestion {
  // Display label (the resolved place's formatted address).
  label: string;
  // Structured fields, mapped 1:1 onto the flat columns on contacts
  // (addressLine1 / city / region / postalCode / country). Each may be empty
  // when the provider didn't return a component for that slot.
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
  // ISO 3166-1 alpha-2 uppercase. Empty when the provider didn't classify.
  country: string;
}

export interface AutocompleteQuery {
  q: string;
  // Optional bias to a country (ISO alpha-2). A hint, not a filter — passing
  // "US" weights results toward the US without excluding others.
  country?: string;
  // Google Places session token (a client-minted UUID). Threaded through the
  // per-keystroke autocomplete calls and the final retrieve so the whole
  // interaction bills as one session.
  sessionToken?: string;
}

export interface RetrieveQuery {
  placeId: string;
  // The same session token the autocomplete calls used, closing the session.
  sessionToken?: string;
}

export interface AddressAutocompleteProvider {
  readonly name: 'google';
  autocomplete(query: AutocompleteQuery): Promise<AddressPrediction[]>;
  retrieve(query: RetrieveQuery): Promise<AddressSuggestion | null>;
}
