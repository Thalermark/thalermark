import type { AddressSuggestion } from '@thalermark/location';
import { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// locations — address type-ahead for the mobile customer form. The web client
// hits its own same-origin SvelteKit proxy (/locations/autocomplete); mobile
// talks to the api, so it needs this route. A deps-taking sub-app: it closes
// over `deps.addressProvider` (cf. the deps-free items/tax-policies sub-apps).
// Account-agnostic (in the rls-context bootstrap allowlist → behind auth, but no
// x-account-id / tenant tx). A missing or misconfigured provider degrades to
// empty + degraded:true, matching the web proxy, so the address fields stay
// usable by hand. Mounted on createApp via .route() so its schema rides on its
// own LocationsAppType instead of bloating AppType past the TS7056 ceiling.
export function locationsRoutes(deps: AppDeps) {
  return new Hono<{ Variables: RlsVariables }>().get('/api/locations/autocomplete', async (c) => {
    const empty: AddressSuggestion[] = [];
    const q = c.req.query('q')?.trim();
    if (!q) return c.json({ suggestions: empty, degraded: false });
    if (q.length > 200) return c.json({ error: 'q_too_long' }, 400);
    const country = c.req.query('country')?.trim().toUpperCase() || undefined;
    if (!deps.addressProvider) return c.json({ suggestions: empty, degraded: true });
    try {
      const suggestions = await deps.addressProvider.autocomplete({ q, country });
      return c.json({ suggestions, degraded: false });
    } catch {
      return c.json({ suggestions: empty, degraded: true });
    }
  });
}

export type LocationsAppType = ReturnType<typeof locationsRoutes>;
