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
  });
}

// Reports uncaught client errors to Sentry (a no-op while uninitialised), then
// falls back to SvelteKit's default error shape shown to the user.
export const handleError = Sentry.handleErrorWithSentry();
