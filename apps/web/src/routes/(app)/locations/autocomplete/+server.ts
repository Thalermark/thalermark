import { env as privateEnv } from '$env/dynamic/private';
import { error, json } from '@sveltejs/kit';
import { createAddressAutocompleteProvider } from '@thalermark/location';
import type { RequestHandler } from './$types.js';

// Same-origin browser proxy for address autocomplete. The user types into
// the customer form's AddressLookup, which calls this endpoint with `?q=...`
// and gets back a list of structured suggestions to fill the address fields.
// Lives on the web app rather than the Hono api because:
//   - Caddy routes /api/* to the api service; an /api endpoint on web would
//     be unreachable in prod. The web routes everything-but-/api/ to itself.
//   - The api currently has no browser-facing CORS surface; adding one for
//     this single helper would multiply the attack surface for no benefit.
//   - Auth is already gated by hooks.server.ts so reaching this handler
//     means the request has a valid session cookie.
//
// Construct-per-request is fine: provider construction is a couple of
// object literals; the heavy work is the network call.

const MAX_Q_LENGTH = 200;

export const GET: RequestHandler = async ({ url }) => {
  const q = url.searchParams.get('q')?.trim();
  if (!q) return json({ suggestions: [] });
  if (q.length > MAX_Q_LENGTH) {
    throw error(400, 'q too long');
  }
  const country = url.searchParams.get('country')?.trim().toUpperCase() || undefined;

  // Provider construction is inside the try/catch so a misconfigured env
  // (LOCATION_PROVIDER=mapbox with no token, unknown provider name) degrades
  // the same way an upstream outage does — empty suggestions + degraded flag
  // — instead of a 500 that bricks the address fields. Operators see the
  // misconfig via the console log; users see the "fill by hand" hint.
  // Structured logging belongs to the LogTape rollout (see
  // [[project_tool_decisions]]), not this slice.
  try {
    const provider = createAddressAutocompleteProvider({
      LOCATION_PROVIDER: privateEnv.LOCATION_PROVIDER,
      MAPBOX_ACCESS_TOKEN: privateEnv.MAPBOX_ACCESS_TOKEN,
      NOMINATIM_BASE_URL: privateEnv.NOMINATIM_BASE_URL,
      NOMINATIM_USER_AGENT: privateEnv.NOMINATIM_USER_AGENT,
    });
    const suggestions = await provider.autocomplete({ q, country });
    return json({ provider: provider.name, suggestions });
  } catch (err) {
    console.error('[locations/autocomplete]', err);
    return json({ suggestions: [], degraded: true });
  }
};
