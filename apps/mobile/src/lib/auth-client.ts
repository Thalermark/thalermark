import { createAuthClient } from 'better-auth/client';
import { clearAuthToken, getAuthToken, setAuthToken } from './secure-store';

const baseURL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

// Mobile auth flow: BA's bearer plugin (server) echoes the session token in
// the `set-auth-token` response header on sign-in/sign-up. We persist that
// to expo-secure-store (Keychain on iOS, EncryptedSharedPreferences on
// Android) and feed it back on every subsequent request via
// `Authorization: Bearer <token>`. No cookies — RN's fetch has no cookie jar
// we want to rely on, and bearer is the contract we promised mobile clients
// in TECH-STACK.md.
export const authClient = createAuthClient({
  baseURL,
  fetchOptions: {
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
// session.
export async function signOut(): Promise<void> {
  try {
    await authClient.signOut();
  } finally {
    await clearAuthToken();
  }
}
