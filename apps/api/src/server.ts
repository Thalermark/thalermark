import { serve } from '@hono/node-server';
import { runMigrations } from '@thalermark/db';
import { configureLogger, getLogger } from '@thalermark/logger';
import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { createApiAuth } from './lib/auth.js';
import { createApiDatabase } from './lib/db.js';
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

// MIGRATE_ON_BOOT is a self-host docker-compose convenience. Production
// deploys generally want a dedicated migrate step ahead of the rollout.
if (env.migrateOnBoot) {
  log.info('MIGRATE_ON_BOOT=true, running migrations');
  await runMigrations(env.databaseUrl);
}

const dbHandle = createApiDatabase(env.databaseUrl);
const auth = createApiAuth(dbHandle.db, env);

const app = createApp({ auth, db: dbHandle.db });

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

// Graceful shutdown: stop accepting new connections, drain the DB pool,
// then exit. Idempotent in case both signals fire on a container stop.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('received {signal}, draining', { signal });
  server.close(() => {
    dbHandle.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
