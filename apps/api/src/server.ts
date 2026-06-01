import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { serve } from '@hono/node-server';
import { runMigrations } from '@thalermark/db';
import { configureLogger, getLogger } from '@thalermark/logger';
import { type StorageProvider, createStorageProvider } from '@thalermark/storage';
import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { createApiAuth } from './lib/auth.js';
import { createApiDatabase } from './lib/db.js';
import { initErrorTracking } from './lib/error-tracking.js';
import { type Mailer, createConsoleMailer, createResendMailer } from './lib/mailer.js';
import { provisionAppRole } from './lib/role-provision.js';
import { createStripeBundle } from './lib/stripe.js';

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

// Stripe is opt-in: bundle is null when any of the three env vars is unset,
// in which case the public invoice view hides Pay and the webhook 503s. Lets
// dev / self-host without a Stripe account boot and exercise everything
// except payment.
const stripe = createStripeBundle({
  secretKey: env.stripeSecretKey,
  publishableKey: env.stripePublishableKey,
  webhookSecret: env.stripeWebhookSecret,
});
if (!stripe) {
  log.info('Stripe disabled (STRIPE_SECRET_KEY / PUBLISHABLE_KEY / WEBHOOK_SECRET incomplete)');
}

// Object storage is opt-in like Stripe: createStorageProvider throws when the
// chosen driver is misconfigured (e.g. local with no STORAGE_URL_SECRET), in
// which case storage stays null and the receipt endpoints 503. localFileServe
// carries the secret + base dir the /api/files token route needs; only
// meaningful for the local driver (s3 signed URLs hit the object store direct).
let storage: StorageProvider | null = null;
let localFileServe: { secret: string; baseDir: string } | null = null;
try {
  storage = createStorageProvider(process.env);
  const driver = (process.env.STORAGE_DRIVER ?? 'local').trim().toLowerCase();
  if (driver === 'local') {
    localFileServe = {
      secret: (process.env.STORAGE_URL_SECRET ?? '').trim(),
      baseDir: (process.env.STORAGE_LOCAL_PATH ?? './data/storage').trim(),
    };
  }
  log.info('object storage: {driver}', { driver: storage.name });
} catch (err) {
  log.info('storage disabled: {msg}', { msg: err instanceof Error ? err.message : String(err) });
}

const app = createApp({
  auth,
  db: dbHandle.db,
  bootstrapDb: bootstrapDbHandle.db,
  trustedOrigins: env.trustedOrigins,
  publicAppUrl: env.publicAppUrl,
  mailer,
  emailFrom: env.emailFrom,
  stripe,
  storage,
  localFileServe,
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
