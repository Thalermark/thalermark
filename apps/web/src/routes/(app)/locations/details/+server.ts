import { env as privateEnv } from '$env/dynamic/private';
import { error, json } from '@sveltejs/kit';
import { createAddressAutocompleteProvider } from '@thalermark/location';
import type { RequestHandler } from './$types.js';

// Same-origin browser proxy for address autocomplete (phase 2: details). The
// AddressLookup calls this when the user picks a prediction — one Place Details
// lookup that resolves the structured address (line1 / city / region /
// postalCode / country) and closes the Google billing session. Companion to
// /locations/autocomplete; see that file for why this proxying is load-bearing
// under the CSP and why it lives on web rather than the api.

export const GET: RequestHandler = async ({ url }) => {
  const placeId = url.searchParams.get('placeId')?.trim();
  if (!placeId) throw error(400, 'placeId required');
  const sessionToken = url.searchParams.get('sessionToken')?.trim() || undefined;

  const provider = createAddressAutocompleteProvider({
    GOOGLE_PLACES_API_KEY: privateEnv.GOOGLE_PLACES_API_KEY,
  });
  if (!provider) return json({ suggestion: null, degraded: true });

  try {
    const suggestion = await provider.retrieve({ placeId, sessionToken });
    return json({ suggestion });
  } catch (err) {
    console.error('[locations/details]', err);
    return json({ suggestion: null, degraded: true });
  }
};
