import { env as privateEnv } from '$env/dynamic/private';
import * as Sentry from '@sentry/sveltekit';
import { error, json } from '@sveltejs/kit';
import { createAddressAutocompleteProvider } from '@thalermark/location';
import type { RequestHandler } from './$types.js';

// Same-origin browser proxy for address autocomplete (phase 1: predictions).
// The contact form's AddressLookup calls this with `?q=...` and gets back
// lightweight predictions (placeId + label); picking one calls the sibling
// /locations/details proxy to resolve the structured address. Lives on the web
// app rather than the Hono api because:
//   - Caddy routes /api/* to the api service; an /api endpoint on web would be
//     unreachable in prod. Web routes everything-but-/api/ to itself.
//   - The api has no browser-facing CORS surface; adding one for this single
//     helper would multiply the attack surface for no benefit.
//   - Auth is already gated by hooks.server.ts, so reaching this handler means
//     the request has a valid session cookie.
// Proxying is also load-bearing under the CSP: the browser can't call
// places.googleapis.com directly (connect-src blocks it), and the Google key
// stays server-side. Construct-per-request is fine — provider construction is a
// couple of object literals; the heavy work is the network call.

const MAX_Q_LENGTH = 200;

export const GET: RequestHandler = async ({ url }) => {
  const q = url.searchParams.get('q')?.trim();
  if (!q) return json({ predictions: [] });
  if (q.length > MAX_Q_LENGTH) {
    throw error(400, 'q too long');
  }
  const country = url.searchParams.get('country')?.trim().toUpperCase() || undefined;
  const sessionToken = url.searchParams.get('sessionToken')?.trim() || undefined;

  const provider = createAddressAutocompleteProvider({
    GOOGLE_PLACES_API_KEY: privateEnv.GOOGLE_PLACES_API_KEY,
  });
  // No key configured → degrade to empty so the address fields stay usable by
  // hand instead of erroring.
  if (!provider) return json({ predictions: [], degraded: true });

  try {
    const predictions = await provider.autocomplete({ q, country, sessionToken });
    return json({ predictions });
  } catch (err) {
    // Sentry, not console: this is the only error path in the app that a
    // failing address provider produces, and on console it reaches nobody's
    // dashboard. The request still degrades gracefully — the caller gets an
    // empty list and a `degraded` flag — so the operator would otherwise never
    // learn their geocoder is down (TMC-237).
    Sentry.captureException(err, { tags: { route: 'locations/autocomplete' } });
    return json({ predictions: [], degraded: true });
  }
};
