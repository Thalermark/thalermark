import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { serve } from '@hono/node-server';
import { runMigrations } from '@thalermark/db';
import { configureLogger, getLogger } from '@thalermark/logger';
import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { createApiAuth } from './lib/auth.js';
import { createApiDatabase } from './lib/db.js';
import { initErrorTracking } from './lib/error-tracking.js';
import { type Mailer, createConsoleMailer, createResendMailer } from './lib/mailer.js';
import { provisionAppRole } from './lib/role-provision.js';

// Project-root .env is the dev convention (see drizzle.config.ts). Resolved
// from this file because pnpm --filter runs with cwd=apps/api/, not the root.
// Container deploys pass env vars directly and won't have a file present.
try {
  loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
} catch {
  // No .env on disk — fall back to process.env as-is.
}

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

// Promote thalermark_app to LOGIN with the configured password before the
// runtime pool opens against it. Idempotent — re-runs on every boot, so
// rotating the secret is just a redeploy. Skipped when the operator manages
// the role's credentials out-of-band (no THALERMARK_APP_PASSWORD set).
if (env.appRolePassword) {
  log.info('provisioning thalermark_app role');
  await provisionAppRole(env.databaseUrl, env.appRolePassword);
}

const dbHandle = createApiDatabase(env.appDatabaseUrl);
// Superuser handle for the narrow bootstrap surface: the BA signup hook
// (creates accounts/companies/memberships before any tenant context exists)
// plus the reads in /api/me and rls-context's membership probe (both run
// before x-account-id, and the RLS policies on accounts/memberships gate
// visibility on `app.current_account_id`, which isn't set yet). Tenant
// routes still use dbHandle (thalermark_app) so RLS fires as designed.
const bootstrapDbHandle = createApiDatabase(env.databaseUrl);
const auth = createApiAuth(bootstrapDbHandle.db, env);

// Resend when an API key is configured; console driver otherwise. The console
// driver is the dev / self-host fallback so operators can grab the message
// from stdout without provisioning SMTP. SMTP via nodemailer lands when a
// real self-host operator needs it.
const mailer: Mailer = env.resendApiKey
  ? createResendMailer({ apiKey: env.resendApiKey, from: env.emailFrom })
  : createConsoleMailer({ from: env.emailFrom });
if (!env.resendApiKey) {
  log.info('email transport: console (RESEND_API_KEY unset)');
}

const app = createApp({
  auth,
  db: dbHandle.db,
  bootstrapDb: bootstrapDbHandle.db,
  trustedOrigins: env.trustedOrigins,
  publicAppUrl: env.publicAppUrl,
  mailer,
  emailFrom: env.emailFrom,
});

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
    Promise.all([dbHandle.close(), bootstrapDbHandle.close()]).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
