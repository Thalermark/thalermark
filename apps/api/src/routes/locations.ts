import type { AddressPrediction, AddressSuggestion } from '@thalermark/location';
import { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// locations — address type-ahead for the mobile customer form (web hits its own
// same-origin SvelteKit proxy). Two-phase, matching Google Places:
// /autocomplete returns lightweight predictions (placeId + label) per keystroke;
// /details resolves the structured address when the user picks one. A
// client-minted sessionToken threads through both so Google bills one session
// per address. A deps-taking sub-app: it closes over `deps.addressProvider` (cf.
// the deps-free items/tax-policies sub-apps). Account-agnostic (in the
// rls-context bootstrap allowlist → behind auth, but no x-account-id / tenant
// tx). A missing or misconfigured provider degrades to empty + degraded:true,
// matching the web proxy, so the address fields stay usable by hand. Mounted on
// createApp via .route() so its schema rides on its own LocationsAppType instead
// of bloating AppType past the TS7056 ceiling.
export function locationsRoutes(deps: AppDeps) {
  return new Hono<{ Variables: RlsVariables }>()
    .get('/api/locations/autocomplete', async (c) => {
      const empty: AddressPrediction[] = [];
      const q = c.req.query('q')?.trim();
      if (!q) return c.json({ predictions: empty, degraded: false });
      if (q.length > 200) return c.json({ error: 'q_too_long' }, 400);
      const country = c.req.query('country')?.trim().toUpperCase() || undefined;
      const sessionToken = c.req.query('sessionToken')?.trim() || undefined;
      if (!deps.addressProvider) return c.json({ predictions: empty, degraded: true });
      try {
        const predictions = await deps.addressProvider.autocomplete({ q, country, sessionToken });
        return c.json({ predictions, degraded: false });
      } catch {
        return c.json({ predictions: empty, degraded: true });
      }
    })
    .get('/api/locations/details', async (c) => {
      const none: AddressSuggestion | null = null;
      const placeId = c.req.query('placeId')?.trim();
      if (!placeId) return c.json({ error: 'place_id_required' }, 400);
      const sessionToken = c.req.query('sessionToken')?.trim() || undefined;
      if (!deps.addressProvider) return c.json({ suggestion: none, degraded: true });
      try {
        const suggestion = await deps.addressProvider.retrieve({ placeId, sessionToken });
        return c.json({ suggestion, degraded: false });
      } catch {
        return c.json({ suggestion: none, degraded: true });
      }
    });
}

export type LocationsAppType = ReturnType<typeof locationsRoutes>;
