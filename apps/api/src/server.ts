// MUST be first: populates process.env from .env before any dependency (notably
// Better Auth) captures it at import time. See load-env.ts for the full why.
import './load-env.js';
import { serve } from '@hono/node-server';
import { runMigrations } from '@thalermark/db';
import { createAddressAutocompleteProvider } from '@thalermark/location';
import { configureLogger, getLogger } from '@thalermark/logger';
import { type StorageProvider, createStorageProvider } from '@thalermark/storage';
import { PgBoss } from 'pg-boss';
import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { communityAccountNotices } from './lib/account-notice.js';
import { createApiAuth, enabledSocialProviders } from './lib/auth.js';
import { deriveConnectionKey } from './lib/crypto.js';
import { createApiDatabase } from './lib/db.js';
import { communityEntitlements } from './lib/entitlement.js';
import { initErrorTracking } from './lib/error-tracking.js';
import { createLlmConnectionStore, settingsLlmCredentials } from './lib/llm-connection.js';
import { guardedFetchForPolicy } from './lib/llm-endpoint.js';
import { type Mailer, createConsoleMailer, createResendMailer } from './lib/mailer.js';
import { sweepRecurringInvoices } from './lib/recurring.js';
import { provisionAppRole, provisionPgBossRole } from './lib/role-provision.js';
import { createStripeBundle } from './lib/stripe.js';

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

// Same idempotent promote-to-LOGIN for the dedicated pg-boss role (migration
// 0052). Only when PGBOSS uses its own role (THALERMARK_PGBOSS_PASSWORD set);
// skipped on the superuser fallback. Must run after migrations create the role.
if (env.pgBossRolePassword) {
  log.info('provisioning thalermark_pgboss role');
  await provisionPgBossRole(env.databaseUrl, env.pgBossRolePassword);
}

const dbHandle = createApiDatabase(env.appDatabaseUrl, env.dbPoolMax);
// Superuser handle for the narrow bootstrap surface: the BA signup hook
// (creates accounts/companies/memberships before any tenant context exists)
// plus the reads in /api/me and rls-context's membership probe (both run
// before x-account-id, and the RLS policies on accounts/memberships gate
// visibility on `app.current_account_id`, which isn't set yet). Tenant
// routes still use dbHandle (thalermark_app) so RLS fires as designed.
const bootstrapDbHandle = createApiDatabase(env.databaseUrl, env.dbPoolMax);

// Resend when an API key is configured; console driver otherwise. The console
// driver is the dev / self-host fallback so operators can grab the message
// from stdout without provisioning SMTP. SMTP via nodemailer lands when a
// real self-host operator needs it. Built before auth so it can power Better
// Auth's verification-email sender.
const mailer: Mailer = env.resendApiKey
  ? createResendMailer({ apiKey: env.resendApiKey, from: env.emailFrom })
  : createConsoleMailer({ from: env.emailFrom });
if (!env.resendApiKey) {
  log.info('email transport: console (RESEND_API_KEY unset)');
}

const auth = createApiAuth(bootstrapDbHandle.db, env, mailer);

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

// AI credential resolution — the community root's default for the open-core seam
// (door #4). The LLM_* env is gone: an account's connection is a row it owns,
// written from Settings → AI, and the resolver reads it per call (null → the AI
// routes 503, exactly as a missing global key used to). The extractor/
// categorizer/advisor stay stateless — the model is resolved per call from the
// resolved credential. The commercial root swaps the resolver for a per-account
// BYOK/managed one; it may reuse this same store (see the commercial brief).
//
// The store's key-encryption master is DERIVED from BETTER_AUTH_SECRET (already
// required + prod-guarded), so no new env var and no restart to configure AI.
const llmStore = createLlmConnectionStore(
  dbHandle.db,
  deriveConnectionKey(env.betterAuthSecret),
  // Attaches a connect-time SSRF-guarded fetch to any credential with a
  // user-supplied endpoint, under the same operator policy the settings route
  // uses. This is the request-time half of the rebinding defense.
  guardedFetchForPolicy({
    allowPrivate: env.aiAllowPrivateEndpoints ?? false,
    allowedEndpoints: env.aiAllowedEndpoints,
  }),
);
const llmCredentials = settingsLlmCredentials(llmStore);
log.info(
  env.aiAllowPrivateEndpoints
    ? 'AI connections: private/LAN endpoints allowed (AI_ALLOW_PRIVATE_ENDPOINTS=true)'
    : 'AI connections: configure from Settings → AI (private endpoints blocked)',
);

// Address autocomplete (mobile customer form; web uses its own SvelteKit proxy).
// Powered by Google Places (New) when GOOGLE_PLACES_API_KEY is set; unset → null
// → the route degrades to empty suggestions and the field falls back to manual
// entry.
const addressProvider = createAddressAutocompleteProvider(process.env);
if (addressProvider) {
  log.info('address autocomplete: {provider}', { provider: addressProvider.name });
} else {
  log.info('address autocomplete disabled (no GOOGLE_PLACES_API_KEY)');
}

const app = createApp({
  auth,
  db: dbHandle.db,
  bootstrapDb: bootstrapDbHandle.db,
  // Public / self-host composition root: inject the always-yes community
  // provider explicitly. This is the open-core seam — the commercial entrypoint
  // (thalermark-cloud) swaps in a plan-aware provider right here. See
  // spikes/SAAS-AND-PRODUCTION.md §6.5.
  entitlement: communityEntitlements,
  // Account-notice provider — the open-core seam that renders a banner in web.
  // The community default returns null for every account (no banner, no extra
  // call); the commercial entrypoint swaps in a plan-aware provider that returns
  // the frozen → upgrade notice. See spikes/ACCOUNT-NOTICE-SEAM.md.
  accountNotice: communityAccountNotices,
  // AI credential resolver — the public root's global-key-for-every-account
  // default. The commercial root swaps in a per-account BYOK resolver. The
  // extractor/categorizer/advisor are no longer injected: they're stateless and
  // the routes build the default callers, resolving the model per call from this.
  llmCredentials,
  // The store behind the resolver, for Settings → AI. Same instance, so a saved
  // connection takes effect on the next resolve with no restart.
  llmConnections: llmStore,
  aiAllowPrivateEndpoints: env.aiAllowPrivateEndpoints,
  aiAllowedEndpoints: env.aiAllowedEndpoints,
  rateLimitEnabled: env.rateLimitEnabled,
  trustedOrigins: env.trustedOrigins,
  publicAppUrl: env.publicAppUrl,
  socialProviders: enabledSocialProviders(env),
  mailer,
  emailFrom: env.emailFrom,
  stripe,
  storage,
  localFileServe,
  addressProvider,
  // Legal-consent config (Terms/Privacy clickwrap). Undefined unless the
  // operator set LEGAL_CONSENT_REQUIRED=true — default self-host stays
  // byte-identical to no-consent. The commercial root can inject its own
  // (hosted terms + a richer, ip/UA-stamped record). See lib/legal-consent.ts.
  legalConsent: env.legalConsent,
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

// Background jobs (pg-boss). Our first and only scheduled job is the
// recurring-invoice sweep. pg-boss owns its own `pgboss` schema and manages the
// queue tables there; it connects on pgBossDatabaseUrl — the dedicated,
// least-privilege thalermark_pgboss role (migration 0052) when configured, the
// superuser fallback otherwise. createSchema:false because the migration already
// created the schema (owned by the role), so the role needs no CREATE-on-database
// privilege. The sweep itself scans all tenants via the bootstrap handle, then
// generates each schedule inside its own tenant context. A scheduler failure is
// logged but does NOT take the HTTP server down — recurring billing degrades,
// the rest of the app serves. Lives only here (not in createApp), so the
// integration-test suite never boots pg-boss.
const SWEEP_QUEUE = 'recurring-invoice-sweep';
let boss: PgBoss | null = null;
// JOBS_ENABLED gates the scheduler + worker. Default on, so a single-box install
// runs the sweep in the api process exactly as before. For a multi-replica
// deployment, run jobs on exactly ONE instance (or a dedicated worker) and set
// JOBS_ENABLED=false on the rest: pg-boss workers are SKIP-LOCKED safe to run
// many (a job is claimed + processed once), but keeping the scheduler on a
// single instance makes the once-per-tick cron unambiguous and isolates job
// load from request load. See DEPLOYMENT.md.
if (env.jobsEnabled !== false) {
  try {
    boss = new PgBoss({
      // loadEnv already falls back to databaseUrl; repeat it here so the type's
      // optional pgBossDatabaseUrl can't slip through as undefined.
      connectionString: env.pgBossDatabaseUrl ?? env.databaseUrl,
      schema: 'pgboss',
      createSchema: false,
    });
    boss.on('error', (err: unknown) =>
      log.error('pg-boss error: {msg}', {
        msg: err instanceof Error ? err.message : JSON.stringify(err),
      }),
    );
    await boss.start();
    await boss.createQueue(SWEEP_QUEUE);
    await boss.work(SWEEP_QUEUE, async () => {
      await sweepRecurringInvoices({
        bootstrapDb: bootstrapDbHandle.db,
        tenantDb: dbHandle.db,
        mail: { mailer, emailFrom: env.emailFrom, publicAppUrl: env.publicAppUrl },
        entitlement: communityEntitlements,
      });
    });
    await boss.schedule(SWEEP_QUEUE, env.recurringSweepCron, undefined, { tz: 'UTC' });
    log.info('recurring-invoice sweep scheduled ({cron} UTC)', { cron: env.recurringSweepCron });
  } catch (err) {
    log.error('failed to start pg-boss scheduler: {msg}', {
      msg: err instanceof Error ? err.message : String(err),
    });
    boss = null;
  }
} else {
  log.info('background jobs disabled (JOBS_ENABLED=false)');
}

// Graceful shutdown: stop the scheduler, stop accepting new connections, drain
// the DB pool, then exit. Idempotent in case both signals fire on a container
// stop.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('received {signal}, draining', { signal });
  server.close(() => {
    const bossStop = boss ? boss.stop().catch(() => {}) : Promise.resolve();
    Promise.all([bossStop, dbHandle.close(), bootstrapDbHandle.close()]).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
