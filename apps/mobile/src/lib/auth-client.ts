import { expoClient } from '@better-auth/expo/client';
import { createAuthClient } from 'better-auth/client';
import * as SecureStore from 'expo-secure-store';
import {
  clearActiveAccountId,
  clearActiveCompanyId,
  clearAuthToken,
  getAuthToken,
  setAuthToken,
} from './secure-store';
import { getServerUrl } from './server-url';

// Mobile auth flow: BA's bearer plugin (server) echoes the session token in
// the `set-auth-token` response header on sign-in/sign-up. We persist that
// to expo-secure-store (Keychain on iOS, EncryptedSharedPreferences on
// Android) and feed it back on every subsequent request via
// `Authorization: Bearer <token>`. No cookies — RN's fetch has no cookie jar
// we want to rely on, and bearer is the contract we promised mobile clients
// in TECH-STACK.md.
// React Native's fetch sends `Sec-Fetch-*` headers, which trips BA's
// formCsrfMiddleware into demanding an Origin header — but RN doesn't send
// Origin by default. We send our app scheme as a stable Origin so the server
// has something to validate. The matching entry must appear in
// TRUSTED_ORIGINS on apps/api.
const APP_ORIGIN = 'thalermark://';

function buildAuthClient(baseURL: string) {
  return createAuthClient({
    baseURL,
    // The expo plugin powers OAuth social sign-in: it opens the provider flow in
    // a system browser, deep-links back via the app scheme, and stores the
    // session cookie in SecureStore. It needs a *synchronous* storage, which
    // expo-secure-store's getItem/setItem provide. Email/password still rides the
    // bearer path below; social is bridged into the same bearer token (see
    // signInWithProvider), so api.ts is unchanged.
    plugins: [
      expoClient({
        scheme: 'thalermark',
        storage: { getItem: SecureStore.getItem, setItem: SecureStore.setItem },
      }),
    ],
    fetchOptions: {
      headers: { Origin: APP_ORIGIN },
      auth: {
        type: 'Bearer',
        token: async () => (await getAuthToken()) ?? undefined,
      },
      onSuccess: async (ctx) => {
        const token = ctx.response.headers.get('set-auth-token');
        if (token) await setAuthToken(token);
      },
    },
  });
}

// Same runtime-URL story as api.ts: the server is chosen in the pre-sign-in
// picker (server-url.ts), but createAuthClient captures baseURL at
// construction. Memoize + rebuild when the configured URL changes; export a
// stable Proxy so screens keep importing `authClient` unchanged.
let auth = buildAuthClient(getServerUrl());
let builtFor = getServerUrl();

function liveAuth() {
  const url = getServerUrl();
  if (url !== builtFor) {
    auth = buildAuthClient(url);
    builtFor = url;
  }
  return auth;
}

export const authClient = new Proxy({} as ReturnType<typeof buildAuthClient>, {
  get: (_target, prop) => liveAuth()[prop as keyof ReturnType<typeof buildAuthClient>],
});

// Sign-out: BA invalidates the session server-side, then we drop the local
// token so the next request starts fresh. Order matters — clearing first
// would strip the Bearer header the sign-out endpoint needs to identify the
// session. Also drop the active account id so the next user doesn't inherit a
// stale tenant scope.
export async function signOut(): Promise<void> {
  try {
    await authClient.signOut();
  } finally {
    await clearAuthToken();
    await clearActiveAccountId();
    await clearActiveCompanyId();
  }
}

// Social provider ids the api may report as configured (GET /api/social-providers).
export type SocialProvider = 'google' | 'facebook' | 'twitter';

// Native social sign-in. The expo plugin opens the provider's OAuth in a system
// browser, deep-links back to the app scheme, and stores the session cookie in
// SecureStore. The rest of the app speaks bearer (api.ts), so we then lift the
// session token out of that cookie — its value IS the bearer token (better-auth's
// bearer plugin emits exactly the session-cookie value) — and persist it where
// api.ts reads it. Email/password and api.ts are untouched. New social users flow
// through the same signup provisioning hook as email/password (account + company
// seeded), so they land in the onboarding wizard just like a fresh email signup.
export async function signInWithProvider(
  provider: SocialProvider,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await authClient.signIn.social({ provider, callbackURL: '/' });
  if (result.error) {
    return { ok: false, error: result.error.message ?? 'Sign-in failed' };
  }
  const token = sessionTokenFromCookie(authClient.getCookie());
  if (!token) return { ok: false, error: 'Could not establish a session.' };
  await setAuthToken(token);
  return { ok: true };
}

// Pull the session-token value out of the cookie header the expo plugin stores
// (e.g. "better-auth.session_token=<value>; ..."). Default better-auth cookie
// name; the __Secure- prefix appears behind TLS.
function sessionTokenFromCookie(cookie: string): string | null {
  const match = cookie.match(/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/);
  return match?.[1] ?? null;
}
