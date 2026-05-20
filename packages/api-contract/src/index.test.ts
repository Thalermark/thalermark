import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import type { AppType } from './index.js';

// This test exists for its type-check side effect, not the runtime assertion.
// If `apps/api/src/app.ts` ever breaks the chained Hono builder (e.g. by
// reverting to `app.get(...); app.get(...)`), AppType erases to an empty
// `Hono<…, {}>` and `client.api.me.$get` becomes `never` — `tsc` then errors
// on the property access below before vitest ever runs.
describe('@thalermark/api-contract', () => {
  it('AppType carries the chained route schema', () => {
    const client = hc<AppType>('http://localhost');
    expect(typeof client.api.me.$get).toBe('function');
  });
});
