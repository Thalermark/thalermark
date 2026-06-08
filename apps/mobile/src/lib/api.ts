import type { AppType } from '@thalermark/api-contract';
import { hc } from 'hono/client';
import { getActiveAccountId, getAuthToken } from './secure-store';

const baseUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

// Mobile-side mirror of apps/web's `src/lib/api.ts`. The web client uses
// cookies (`credentials: 'include'`); mobile uses the bearer token written
// to expo-secure-store by `auth-client.ts` on sign-in/sign-up. Origin is
// pinned to the app scheme for parity with the auth-client — apps/api's
// TRUSTED_ORIGINS allowlist + BA's formCsrfMiddleware both require it.
const APP_ORIGIN = 'thalermark://';

export const api = hc<AppType>(baseUrl, {
  headers: async () => {
    const token = await getAuthToken();
    const base: Record<string, string> = { Origin: APP_ORIGIN };
    if (token) base.Authorization = `Bearer ${token}`;
    // `x-account-id` scopes every tenant route to the active membership — the
    // mobile equivalent of web's `active_account_id` cookie → `x-account-id`
    // stamping (apps/web/src/lib/api.server.ts). Bootstrap routes (/api/me,
    // invite-accept) ignore it; tenant routes 400 without it. Absent until an
    // active account is resolved (see active-account.ts) — the only call before
    // that is /api/me, which is a bootstrap route.
    const accountId = await getActiveAccountId();
    if (accountId) base['x-account-id'] = accountId;
    return base;
  },
});
