import { env } from '$env/dynamic/public';
import { createAuthClient } from 'better-auth/svelte';

// Exported so the sign-in page can reconstruct core's own OIDC authorize URL
// when it's acting as the identity authority (TMCLD-99). Empty on the app
// service (PUBLIC_API_URL=""), i.e. same-origin; an absolute cross-origin URL
// in dev.
export const baseURL = env.PUBLIC_API_URL ?? 'http://localhost:3000';

export const authClient = createAuthClient({
  baseURL,
  fetchOptions: { credentials: 'include' },
});
