import { env } from '$env/dynamic/public';
import { createAuthClient } from 'better-auth/svelte';

const baseURL = env.PUBLIC_API_URL ?? 'http://localhost:3000';

export const authClient = createAuthClient({
  baseURL,
  fetchOptions: { credentials: 'include' },
});
