import * as Sentry from '@sentry/node';
import { getLogger } from '@thalermark/logger';

const log = getLogger(['api', 'error-tracking']);

// Initialise Sentry — inert when ERROR_TRACKING_DSN is unset.
//
// Self-host gets a no-op by default: operators have to opt in by setting
// the DSN. On SaaS, our deploy environment sets the DSN to point at our
// GlitchTip instance (per `project_tool_decisions.md`). The same SDK API
// works against either backend; only the DSN changes.
//
// Call exactly once at process boot, before serving traffic.
export function initErrorTracking(opts: {
  dsn: string | undefined;
  environment: string;
  release?: string;
}): void {
  if (!opts.dsn) {
    log.info('error tracking disabled (ERROR_TRACKING_DSN unset)');
    return;
  }
  Sentry.init({
    dsn: opts.dsn,
    environment: opts.environment,
    release: opts.release,
    // No performance traces in 3.2 — we have nothing to trace yet. Turn on
    // when real request handlers + a DB pool exist (3.5+).
    tracesSampleRate: 0,
  });
  log.info('error tracking initialised', { environment: opts.environment });
}
