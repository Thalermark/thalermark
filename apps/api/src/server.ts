import { serve } from '@hono/node-server';
import { configureLogger, getLogger } from '@thalermark/logger';
import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { initErrorTracking } from './lib/error-tracking.js';

const env = loadEnv();

// Sentry must be initialised before anything else so its global hooks
// (unhandled rejection, uncaught exception) are armed for the rest of boot.
initErrorTracking({
  dsn: env.errorTrackingDsn,
  environment: env.nodeEnv,
  release: env.release,
});

configureLogger({ level: env.logLevel });
const log = getLogger(['api', 'server']);

const app = createApp();

const server = serve(
  {
    fetch: app.fetch,
    port: env.port,
  },
  (info) => {
    log.info('listening on http://localhost:{port} ({nodeEnv})', {
      port: info.port,
      nodeEnv: env.nodeEnv,
    });
  },
);

// Graceful shutdown: stop accepting new connections, then exit. Idempotent
// in case both signals fire on a container stop.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('received {signal}, draining', { signal });
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
