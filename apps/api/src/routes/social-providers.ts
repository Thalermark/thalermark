import { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// social-providers — the public (pre-auth) list of configured social-login
// provider ids, used by the sign-in page to render only the buttons that work.
// A deps-taking sub-app: it closes over `deps.socialProviders` rather than the
// tenant tx (cf. the deps-free items/tax-policies sub-apps). Mounted on
// createApp via .route() so its schema rides on its own SocialProvidersAppType
// instead of bloating AppType past the TS7056 ceiling. Listed in rls-context's
// PUBLIC_PATH_PATTERNS, so the parent middleware skips the tenant context for
// it — no secrets, just the configured provider ids.
export function socialProvidersRoutes(deps: AppDeps) {
  return new Hono<{ Variables: RlsVariables }>().get('/api/social-providers', (c) =>
    c.json({ providers: deps.socialProviders ?? [] }),
  );
}

export type SocialProvidersAppType = ReturnType<typeof socialProvidersRoutes>;
