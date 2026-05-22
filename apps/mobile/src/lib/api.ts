import type { AppType } from '@thalermark/api-contract';
import { hc } from 'hono/client';
import { getAuthToken } from './secure-store';

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
    return base;
  },
});
