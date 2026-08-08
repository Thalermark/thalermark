// Boot building blocks — the construct-from-env wiring that used to live inline
// in server.ts's top-level script, factored into named, testable, importable
// functions. This module is SIDE-EFFECT-FREE: importing it constructs nothing
// and starts no server; every function must be called explicitly.
//
// Two composition roots consume these: the community root (this app's
// server.ts) and a downstream commercial root that reuses core byte-for-byte
// and swaps plan-aware providers. The high-value pieces are createDefaultAppDeps
// (kills the "cloud re-derives provider construction" fork) and registerCoreJobs
// (kills the same fork for the recurring-invoice sweep). The small boot helpers
// keep both roots' boot short and non-duplicated. What stays per-root by design:
// serve(), the pg-boss lifecycle (new/start/stop + the JOBS_ENABLED gate), and
// any commercial admin/billing mounts — the divergent orchestration, not the
// shared construction.
import type { AccountCreatedContext, IdpOptions, SessionRevokedContext } from '@thalermark/auth';
import { type Database, runMigrations } from '@thalermark/db';
import { createAddressAutocompleteProvider } from '@thalermark/location';
import { configureLogger, getLogger } from '@thalermark/logger';
import { type StorageProvider, createStorageProvider } from '@thalermark/storage';
import type { PgBoss } from 'pg-boss';
import type { AppDeps } from './app.js';
import {
  DEFAULT_DEPRECIATION_SWEEP_CRON,
  DEFAULT_REMINDER_SWEEP_CRON,
  DEFAULT_SEARCH_REINDEX_CRON,
  type Env,
} from './env.js';
import { communityAccountNotices } from './lib/account-notice.js';
import { createApiAuth, enabledSocialProviders } from './lib/auth.js';
import { deriveConnectionKey } from './lib/crypto.js';
import { type ApiDatabase, createApiDatabase } from './lib/db.js';
import { sweepDepreciation } from './lib/depreciation.js';
import { type EntitlementProvider, communityEntitlements } from './lib/entitlement.js';
import { initErrorTracking } from './lib/error-tracking.js';
import {
  type LlmConnectionStore,
  createLlmConnectionStore,
  settingsLlmCredentials,
} from './lib/llm-connection.js';
import { guardedFetchForPolicy } from './lib/llm-endpoint.js';
import { type Mailer, createConsoleMailer, createResendMailer } from './lib/mailer.js';
import { sweepRecurringInvoices } from './lib/recurring.js';
import { sweepInvoiceReminders } from './lib/reminders.js';
import { provisionAppRole, provisionPgBossRole } from './lib/role-provision.js';
import { sweepSearchReindex } from './lib/search/sweep.js';
import { createStripeBundle } from './lib/stripe.js';

const log = getLogger(['api', 'bootstrap']);

// Sentry + logger. Sentry must be initialised before anything else so its global
// hooks (unhandled rejection, uncaught exception) are armed for the rest of boot,
// so a root calls this right after loadEnv, before building deps.
export function initObservability(env: Env): void {
  initErrorTracking({
    dsn: env.errorTrackingDsn,
    environment: env.nodeEnv,
    release: env.release,
  });
  configureLogger({ level: env.logLevel });
}

// A downstream migration pack (door #5): the folder of additive SQL a commercial
// root runs after core's migrations, in the same Postgres. `folder` is what
// runMigrations() takes; `name` is for the boot log only.
export type MigrationPack = { name: string; folder: string };

// Boot-time DDL prep: migrate-on-boot (a self-host docker-compose convenience —
// production generally wants a dedicated migrate step ahead of the rollout) plus
// the idempotent LOGIN-password provisioning for the app + pg-boss roles.
// extraPacks lets a commercial root run its own migration pack through the same
// gate without forking this head.
export async function runBootMigrations(
  env: Env,
  opts: { extraPacks?: MigrationPack[] } = {},
): Promise<void> {
  if (env.migrateOnBoot) {
    log.info('MIGRATE_ON_BOOT=true, running migrations');
    await runMigrations(env.databaseUrl);
    for (const pack of opts.extraPacks ?? []) {
      log.info('running migration pack: {name}', { name: pack.name });
      await runMigrations(env.databaseUrl, pack.folder);
    }
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
}

// The constructed, disposable resources a root needs beyond the AppDeps record:
// the two pool handles (to drain on shutdown, and to build handle-dependent
// overrides — e.g. a plan-aware provider reading tenantDb.db), the LLM store
// (a commercial BYOK resolver reuses this exact instance), and the mailer (the
// recurring-sweep job wiring needs it). AppDeps carries `db`/`bootstrapDb` as
// bare Database objects, which aren't closable — hence the handles here.
export type BootHandles = {
  tenantDb: ApiDatabase;
  bootstrapDb: ApiDatabase;
  llmStore: LlmConnectionStore;
  mailer: Mailer;
};

export type CreateDefaultAppDepsOptions = {
  // The account-lifecycle seam (door #3). Threaded into createApiAuth because it
  // fires inside the Better Auth signup transaction, so it can't be a post-hoc
  // spread onto AppDeps the way the other seams are — `auth` is itself a dep
  // built here. Undefined (community) → signup is byte-identical to no hook.
  onAccountCreated?: (ctx: AccountCreatedContext) => Promise<void>;
  // The single-logout seam (TMCLD-98). Threaded into createApiAuth for the same
  // reason as onAccountCreated — it's a Better Auth session hook, fired when a
  // session ends so a commercial root can end the same user's sessions on
  // sibling OIDC clients (dashboard/admin). Undefined (community) → no
  // notification, byte-identical to today.
  onSessionRevoked?: (ctx: SessionRevokedContext) => Promise<void>;
  // Forces the AI SSRF endpoint policy, overriding BOTH env knobs
  // (AI_ALLOW_PRIVATE_ENDPOINTS + AI_ALLOWED_ENDPOINTS). A managed multi-tenant root
  // passes { allowPrivate: false, allowedEndpoints: [] } so a stray env value can't
  // let a tenant BYOK URL reach loopback/RFC1918/metadata. Unset → env fallback,
  // byte-identical to today. Structurally an EndpointPolicy (lib/llm-endpoint.ts).
  aiEndpointPolicy?: { allowPrivate: boolean; allowedEndpoints?: string[] };
  // The identity-provider seam (single-login for dashboard/admin + MCP). A
  // commercial root injects trusted clients + a login/consent page, turning core
  // into the OAuth2/OIDC + MCP authority; it's threaded into createApiAuth
  // because the plugins are wired when the Better Auth instance is built. Unset
  // (community) → no IdP plugins, no discovery route, byte-identical to today.
  idp?: IdpOptions;
};

// Builds the fully-wired community AppDeps from env — the exact block that used
// to sit inline in server.ts. The community root calls createApp(deps) with zero
// overrides and stays byte-identical; a commercial root spreads its plan-aware
// overrides on top (createApp({ ...deps, entitlement, llmCredentials, ... })) and
// so never re-derives construction. When core swaps a provider (the Google Places
// example), the change lands here and every root inherits it for free.
//
// Synchronous: nothing in the construction is async today. The async boot steps
// (migrations, role provisioning, boss.start) are lifecycle, and stay in the root.
export function createDefaultAppDeps(
  env: Env,
  opts: CreateDefaultAppDepsOptions = {},
): { deps: AppDeps; handles: BootHandles } {
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
  // from stdout without provisioning SMTP. Built before auth so it can power
  // Better Auth's verification-email sender.
  const mailer: Mailer = env.resendApiKey
    ? createResendMailer({ apiKey: env.resendApiKey, from: env.emailFrom })
    : createConsoleMailer({ from: env.emailFrom });
  if (!env.resendApiKey) {
    log.info('email transport: console (RESEND_API_KEY unset)');
  }

  const auth = createApiAuth(bootstrapDbHandle.db, env, mailer, {
    onAccountCreated: opts.onAccountCreated,
    onSessionRevoked: opts.onSessionRevoked,
    idp: opts.idp,
  });

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
  // Reads process.env directly (not env) — the storage vars live outside the
  // central Env schema; kept as-is so behaviour is byte-identical.
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
  // (door #4). An account's connection is a row it owns, written from Settings →
  // AI, and the resolver reads it per call (null → the AI routes 503). The
  // extractor/categorizer/advisor stay stateless — the model is resolved per call
  // from the resolved credential. A commercial root swaps the resolver for a
  // per-account BYOK/managed one; it may reuse this same store (returned in
  // handles.llmStore). The store's key-encryption master is DERIVED from
  // BETTER_AUTH_SECRET (already required + prod-guarded), so no new env var.
  // Resolve the AI SSRF endpoint policy once. A commercial root can force it via
  // opts.aiEndpointPolicy, overriding BOTH env knobs, so a stray AI_ALLOW_PRIVATE_
  // ENDPOINTS / AI_ALLOWED_ENDPOINTS can't unblock a tenant BYOK URL to internal
  // hosts. Unset → env fallback (byte-identical self-host). Drives all three
  // consumers: the store's connect-time guard here, plus both deps.ai* fields below
  // that the settings route reads at request time.
  const aiPolicy = opts.aiEndpointPolicy ?? {
    allowPrivate: env.aiAllowPrivateEndpoints ?? false,
    allowedEndpoints: env.aiAllowedEndpoints,
  };
  const llmStore = createLlmConnectionStore(
    dbHandle.db,
    deriveConnectionKey(env.betterAuthSecret),
    // Attaches a connect-time SSRF-guarded fetch to any credential with a
    // user-supplied endpoint, under the same operator policy the settings route
    // uses. This is the request-time half of the rebinding defense.
    guardedFetchForPolicy(aiPolicy),
  );
  const llmCredentials = settingsLlmCredentials(llmStore);
  log.info(
    aiPolicy.allowPrivate
      ? 'AI connections: private/LAN endpoints allowed (AI_ALLOW_PRIVATE_ENDPOINTS=true)'
      : 'AI connections: configure from Settings → AI (private endpoints blocked)',
  );

  // Address autocomplete (mobile customer form; web uses its own SvelteKit proxy).
  // Powered by Google Places (New) when GOOGLE_PLACES_API_KEY is set; unset → null
  // → the route degrades to empty suggestions and the field falls back to manual
  // entry. Reads process.env directly for the same reason as storage above.
  const addressProvider = createAddressAutocompleteProvider(process.env);
  if (addressProvider) {
    log.info('address autocomplete: {provider}', { provider: addressProvider.name });
  } else {
    log.info('address autocomplete disabled (no GOOGLE_PLACES_API_KEY)');
  }

  const deps: AppDeps = {
    auth,
    db: dbHandle.db,
    bootstrapDb: bootstrapDbHandle.db,
    // Community defaults for the open-core seams — the commercial root swaps
    // these by spreading its own onto createApp({ ...deps, ... }).
    entitlement: communityEntitlements,
    accountNotice: communityAccountNotices,
    llmCredentials,
    // The store behind the resolver, for Settings → AI. Same instance, so a saved
    // connection takes effect on the next resolve with no restart.
    llmConnections: llmStore,
    // Both driven by aiPolicy (not env) so a forced policy also seals the request-
    // time settings check (routes/settings-ai.ts reads both of these).
    aiAllowPrivateEndpoints: aiPolicy.allowPrivate,
    aiAllowedEndpoints: aiPolicy.allowedEndpoints ?? [],
    rateLimitEnabled: env.rateLimitEnabled,
    trustedOrigins: env.trustedOrigins,
    publicAppUrl: env.publicAppUrl,
    socialProviders: enabledSocialProviders(env),
    mailer,
    emailFrom: env.emailFrom,
    stripe,
    requireConnectedAccount: env.stripeRequireConnectedAccount ?? false,
    storage,
    localFileServe,
    addressProvider,
    legalConsent: env.legalConsent,
    // Gates the OAuth-authorization-server discovery route in app.ts. On when the
    // IdP seam was injected (the mcp/oidc plugins are loaded on `auth`); off →
    // the /.well-known route 404s, byte-identical to today.
    idpEnabled: !!opts.idp,
  };

  return {
    deps,
    handles: {
      tenantDb: dbHandle,
      bootstrapDb: bootstrapDbHandle,
      llmStore,
      mailer,
    },
  };
}

const SWEEP_QUEUE = 'recurring-invoice-sweep';
const DEPRECIATION_QUEUE = 'depreciation-sweep';
const REMINDER_QUEUE = 'invoice-reminder-sweep';
const SEARCH_REINDEX_QUEUE = 'search-reindex';

// The per-call inputs the recurring-invoice sweep needs. `entitlement` is passed
// in (not baked) so a commercial root's plan-aware provider makes the sweep
// respect freeze with no change here.
export type SweepJobDeps = {
  bootstrapDb: Database;
  tenantDb: Database;
  mailer: Mailer;
  emailFrom: string;
  publicAppUrl: string;
  entitlement: EntitlementProvider;
};

// Registers core's scheduled jobs on an already-started pg-boss instance: the
// recurring-invoice sweep queue + worker + cron schedule. This is the shared,
// don't-re-derive unit. The boss lifecycle (new PgBoss / start / stop / the
// JOBS_ENABLED gate / the resilient try-catch) stays in each root, so a
// commercial root registers its own extra queues on the SAME boss right after
// calling this. The sweep scans all tenants via the bootstrap handle, then
// generates each schedule inside its own tenant context.
export async function registerCoreJobs(boss: PgBoss, deps: SweepJobDeps, env: Env): Promise<void> {
  await boss.createQueue(SWEEP_QUEUE);
  await boss.work(SWEEP_QUEUE, async () => {
    await sweepRecurringInvoices({
      bootstrapDb: deps.bootstrapDb,
      tenantDb: deps.tenantDb,
      mail: { mailer: deps.mailer, emailFrom: deps.emailFrom, publicAppUrl: deps.publicAppUrl },
      entitlement: deps.entitlement,
    });
  });
  await boss.schedule(SWEEP_QUEUE, env.recurringSweepCron, undefined, { tz: 'UTC' });
  log.info('recurring-invoice sweep scheduled ({cron} UTC)', { cron: env.recurringSweepCron });

  // Yearly depreciation for "spread it out" purchases (TMC-123). Takes no
  // entitlement provider on purpose — see sweepDepreciation: freezing a lapsed
  // account's depreciation would put a wrong number on its Schedule C rather
  // than withhold a feature.
  await boss.createQueue(DEPRECIATION_QUEUE);
  await boss.work(DEPRECIATION_QUEUE, async () => {
    await sweepDepreciation({ bootstrapDb: deps.bootstrapDb, tenantDb: deps.tenantDb });
  });
  const depreciationCron = env.depreciationSweepCron ?? DEFAULT_DEPRECIATION_SWEEP_CRON;
  await boss.schedule(DEPRECIATION_QUEUE, depreciationCron, undefined, { tz: 'UTC' });
  log.info('depreciation sweep scheduled ({cron} UTC)', { cron: depreciationCron });

  // Payment reminders (TMC-189). THE ONLY SWEEP THAT MAILS A THIRD PARTY — the
  // customer of the person using this software, in that person's name.
  //
  // Registering it does NOT start anyone's reminders: companies.reminders_enabled
  // is false for every existing company and every new one, so this scheduler
  // wakes up daily and finds nothing until an owner deliberately switches it on.
  // That is the intended shape of shipping a feature that sends mail on someone
  // else's behalf.
  //
  // Takes the entitlement provider, unlike depreciation: withholding a chase
  // from a lapsed account is withholding a FEATURE, where withholding
  // depreciation would put a wrong number on a tax return. Different kinds of
  // thing, hence the different answer.
  await boss.createQueue(REMINDER_QUEUE);
  await boss.work(REMINDER_QUEUE, async () => {
    await sweepInvoiceReminders({
      bootstrapDb: deps.bootstrapDb,
      tenantDb: deps.tenantDb,
      mail: { mailer: deps.mailer, emailFrom: deps.emailFrom, publicAppUrl: deps.publicAppUrl },
      entitlement: deps.entitlement,
    });
  });
  const reminderCron = env.reminderSweepCron ?? DEFAULT_REMINDER_SWEEP_CRON;
  await boss.schedule(REMINDER_QUEUE, reminderCron, undefined, { tz: 'UTC' });
  log.info('invoice-reminder sweep scheduled ({cron} UTC)', { cron: reminderCron });

  // Search index backfill + reap (TMC-198). Repair, not production: the request
  // path keeps search_documents current inside each mutation's own transaction,
  // so this exists to fill a fresh deploy and to reap anything a mutation path
  // forgot to reindex. Takes no entitlement provider, same reasoning as
  // depreciation — a stale index is a correctness problem, not a feature.
  await boss.createQueue(SEARCH_REINDEX_QUEUE);
  await boss.work(SEARCH_REINDEX_QUEUE, async () => {
    await sweepSearchReindex({ bootstrapDb: deps.bootstrapDb, tenantDb: deps.tenantDb });
  });
  const searchReindexCron = env.searchReindexCron ?? DEFAULT_SEARCH_REINDEX_CRON;
  await boss.schedule(SEARCH_REINDEX_QUEUE, searchReindexCron, undefined, { tz: 'UTC' });

  // One-shot on boot, so a deploy that introduces the table does not serve an
  // empty search box until Sunday. singletonKey collapses duplicates, so a crash
  // loop or a multi-replica rollout enqueues one job rather than one per start.
  await boss.send(SEARCH_REINDEX_QUEUE, {}, { singletonKey: 'search-reindex-all' });
  log.info('search reindex scheduled ({cron} UTC), one-shot enqueued', {
    cron: searchReindexCron,
  });
}

// A started server handle with a drain-then-callback close — structurally what
// @hono/node-server's serve() returns (a Node http.Server), typed narrowly so
// this module needn't depend on the http server package.
type ServerHandle = { close(onClosed: () => void): void };

// Graceful shutdown: on SIGTERM/SIGINT stop accepting new connections, then stop
// the scheduler and drain both DB pools (plus any commercial-owned resources via
// extraClose), then exit. Idempotent in case both signals fire on a container
// stop. `boss` is a getter because the root may still be assigning it when this
// is installed, and it can end up null if the scheduler failed to start.
export function installShutdown(opts: {
  server: ServerHandle;
  handles: BootHandles;
  boss: () => PgBoss | null;
  extraClose?: Array<() => Promise<void>>;
}): void {
  let shuttingDown = false;
  function shutdown(signal: NodeJS.Signals) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('received {signal}, draining', { signal });
    opts.server.close(() => {
      const boss = opts.boss();
      const bossStop = boss ? boss.stop().catch(() => {}) : Promise.resolve();
      const extra = (opts.extraClose ?? []).map((fn) => fn().catch(() => {}));
      Promise.all([
        bossStop,
        opts.handles.tenantDb.close(),
        opts.handles.bootstrapDb.close(),
        ...extra,
      ]).then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
