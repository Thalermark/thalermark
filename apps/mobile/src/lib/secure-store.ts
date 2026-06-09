import * as SecureStore from 'expo-secure-store';

const AUTH_TOKEN_KEY = 'thalermark.auth.session-token';
// The active account id is the mobile equivalent of web's `active_account_id`
// cookie — which of the user's memberships every tenant request is scoped to
// (stamped as `x-account-id` by `api.ts`). Not a secret, but stored here too so
// we don't pull in a second persistence dependency for one value.
const ACTIVE_ACCOUNT_KEY = 'thalermark.active-account-id';
// The API base URL this install talks to. Defaults to the build-time
// EXPO_PUBLIC_API_URL (the SaaS cloud in a published build); self-hosters
// override it in the pre-sign-in server picker. Not a secret — stored here to
// avoid a second persistence dependency for one value. See server-url.ts for
// the cache + hydration that make it readable synchronously by the API client.
const SERVER_URL_KEY = 'thalermark.server-url';

export async function getAuthToken(): Promise<string | null> {
  return SecureStore.getItemAsync(AUTH_TOKEN_KEY);
}

export async function setAuthToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
}

export async function clearAuthToken(): Promise<void> {
  await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
}

export async function getActiveAccountId(): Promise<string | null> {
  return SecureStore.getItemAsync(ACTIVE_ACCOUNT_KEY);
}

export async function setActiveAccountId(accountId: string): Promise<void> {
  await SecureStore.setItemAsync(ACTIVE_ACCOUNT_KEY, accountId);
}

export async function clearActiveAccountId(): Promise<void> {
  await SecureStore.deleteItemAsync(ACTIVE_ACCOUNT_KEY);
}

export async function getStoredServerUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(SERVER_URL_KEY);
}

export async function setStoredServerUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(SERVER_URL_KEY, url);
}

export async function clearStoredServerUrl(): Promise<void> {
  await SecureStore.deleteItemAsync(SERVER_URL_KEY);
}
