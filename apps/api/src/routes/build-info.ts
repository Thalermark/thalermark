import { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// build-info — what build is this api process running? Answers the question the
// web app can't answer for itself: web's version is compiled into its bundle at
// build time, the api's is read from its own image, and the two can disagree
// (a half-finished rollout, a rolled-back api leg, a stale cached web image).
// Settings → About fetches this and shows both numbers side by side so the
// disagreement is visible in-product rather than inferred from a registry.
//
// Session-gated but NOT account-scoped: the version belongs to the deployment,
// not to a tenant, so this is a bootstrap path in rls-context (no x-account-id,
// no tenant tx). Deliberately not on /health or /ready — those are probe-
// reachable and DB-independent by design, and the build a box is running is not
// something to hand an unauthenticated caller.
//
// A deps-taking sub-app: it closes over deps.appVersion rather than the tenant
// tx (cf. social-providers). Mounted on createApp via .route() so its schema
// rides on BuildInfoAppType instead of bloating AppType past the TS7056 ceiling.
export function buildInfoRoutes(deps: AppDeps) {
  return new Hono<{ Variables: RlsVariables }>().get('/api/build-info', (c) =>
    // Falls back to 'dev' for test/embedder deps that omit it, matching what
    // loadEnv resolves when APP_VERSION is unset.
    c.json({ version: deps.appVersion ?? 'dev' }),
  );
}

export type BuildInfoAppType = ReturnType<typeof buildInfoRoutes>;
