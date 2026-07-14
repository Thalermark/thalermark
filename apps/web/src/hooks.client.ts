import { dev } from '$app/environment';
import { env } from '$env/dynamic/public';
import * as Sentry from '@sentry/sveltekit';

// Browser-side error tracking. Inert unless PUBLIC_ERROR_TRACKING_DSN is set —
// the same opt-in posture as the api (apps/api/src/lib/error-tracking.ts), so
// self-host stays silent by default. The DSN is a write-only public key, so
// shipping it in the client bundle is expected. GlitchTip and Sentry share the
// ingest protocol; only the DSN host differs (backend decided: GlitchTip).
if (env.PUBLIC_ERROR_TRACKING_DSN) {
  Sentry.init({
    dsn: env.PUBLIC_ERROR_TRACKING_DSN,
    environment: dev ? 'development' : 'production',
    release: env.PUBLIC_RELEASE || undefined,
    // No performance tracing yet — mirror the api (tracesSampleRate: 0).
    tracesSampleRate: 0,
    // Route envelopes through a same-origin path (see routes/monitoring) instead
    // of POSTing straight to the GlitchTip host. Ad / privacy blockers match the
    // well-known `…/envelope/` tracker URL and silently drop a meaningful share
    // of real users' client error reports (net::ERR_BLOCKED_BY_CLIENT); a
    // first-party path isn't on those filter lists. The server route forwards
    // the envelope to the configured DSN host (TMC-131).
    tunnel: '/monitoring',
  });
}

// Reports uncaught client errors to Sentry (a no-op while uninitialised), then
// falls back to SvelteKit's default error shape shown to the user.
export const handleError = Sentry.handleErrorWithSentry();
