import { createAuthClient } from 'better-auth/svelte';
import { publicApiBaseUrl } from './public-api-url.js';

// Exported so the sign-in page can reconstruct core's own OIDC authorize URL
// when it's acting as the identity authority (TMCLD-99). Empty on the app
// service (PUBLIC_API_URL=""), i.e. same-origin; an absolute cross-origin URL
// in dev.
export const baseURL = publicApiBaseUrl;

export const authClient = createAuthClient({
  baseURL,
  fetchOptions: { credentials: 'include' },
});
