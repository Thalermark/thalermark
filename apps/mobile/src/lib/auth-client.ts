import { createAuthClient } from 'better-auth/client';
import { clearActiveAccountId, clearAuthToken, getAuthToken, setAuthToken } from './secure-store';

const baseURL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

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

export const authClient = createAuthClient({
  baseURL,
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
  }
}
