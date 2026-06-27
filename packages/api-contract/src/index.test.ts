import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { AppType } from './index.js';

// This test exists for its type-check side effect, not the runtime assertion.
// If `apps/api/src/app.ts` ever breaks the chained Hono builder (e.g. by
// reverting to `app.get(...); app.get(...)`), AppType erases to an empty
// `Hono<…, {}>` and the property access below becomes `never` — `tsc` then
// errors before vitest ever runs.
//
// Canary route: the Better Auth mount (`.on(['GET','POST'], '/api/auth/*')`).
// The modular sub-apps refactor steadily empties AppType as domains move onto
// their own XAppType, so the canary must be a route that STAYS in createMainApp
// — the auth handler is never extracted, unlike `/api/me` (now AccountAppType).
describe('@thalermark/api-contract', () => {
  it('AppType carries the chained route schema', () => {
    const client = hc<AppType>('http://localhost');
    expect(typeof client.api.auth['*'].$post).toBe('function');
  });
});
