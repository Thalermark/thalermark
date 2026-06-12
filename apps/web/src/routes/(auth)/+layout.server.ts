import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import type { LayoutServerLoad } from './$types';

// Same api-URL resolution as hooks.server.ts: behind Caddy the browser uses
// relative /api/*, so SSR resolves INTERNAL_API_URL (the api container host).
const apiUrl = privateEnv.INTERNAL_API_URL || publicEnv.PUBLIC_API_URL || 'http://localhost:3000';

// Which social-login buttons the sign-in / sign-up pages should render. The api
// is the single source of truth (it only reports a provider when its creds are
// set), so there's no separate web flag to drift out of sync. Best-effort: a
// fetch failure just hides the buttons — email/password still works.
export const load: LayoutServerLoad = async ({ fetch }) => {
  try {
    const res = await fetch(`${apiUrl}/api/social-providers`);
    if (!res.ok) return { socialProviders: [] as string[] };
    const { providers } = (await res.json()) as { providers: string[] };
    return { socialProviders: providers };
  } catch {
    return { socialProviders: [] as string[] };
  }
};
