// Typed environment loader for the API process. Reads from process.env once
// at boot and exposes a frozen, validated config object. Anything missing or
// malformed throws synchronously — we want the process to refuse to start
// rather than degrade.
//
// Add fields here as upstream slices need them (DB, auth, telemetry, etc.).
// The skeleton only needs PORT + NODE_ENV.

import type { LegalConsentConfig } from './lib/legal-consent.js';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error' | 'fatal';

export type Env = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: LogLevel;
  errorTrackingDsn: string | undefined;
  release: string | undefined;
  // Superuser connection. Used for DDL only — migrations on boot and
  // app-role provisioning. Not for runtime traffic.
  databaseUrl: string;
  // Runtime connection — must point at the non-BYPASSRLS thalermark_app role
  // (created in migration 0005). RLS policies fire as the primary tenancy
  // fence; the explicit account_id filter in every SELECT is the second.
  appDatabaseUrl: string;
  // Max connections per runtime pool (the api opens two: tenant + bootstrap).
  // Defaults to pg's historical 10; raise for a bigger box, but keep the total
  // across both pools + pg-boss under the server's max_connections. The pool
  // timeouts that go with it are fixed in lib/db.ts. Optional on the type so
  // test/embedder Env literals needn't list it (loadEnv always resolves it; the
  // createApiDatabase default absorbs undefined).
  dbPoolMax?: number;
  // When set, server.ts runs `ALTER ROLE thalermark_app WITH LOGIN PASSWORD`
  // at boot. Leave blank if the role is provisioned out-of-band.
  appRolePassword: string | undefined;
  // Connection for the pg-boss background-job queue. Points at the dedicated,
  // least-privilege thalermark_pgboss role (migration 0052) so the job runner no
  // longer holds superuser creds at runtime. loadEnv falls back to databaseUrl
  // when PGBOSS_DATABASE_URL is unset, preserving the old single-superuser
  // behaviour. Optional on the type so test/embedder Env literals needn't list
  // it (server.ts re-applies the databaseUrl fallback for safety).
  pgBossDatabaseUrl?: string;
  // When set, server.ts runs `ALTER ROLE thalermark_pgboss WITH LOGIN PASSWORD`
  // at boot (mirrors appRolePassword). Leave blank if provisioned out-of-band or
  // when pg-boss still uses the superuser fallback. Optional on the type as above.
  pgBossRolePassword?: string;
  migrateOnBoot: boolean;
  betterAuthSecret: string;
  betterAuthUrl: string;
  // Social sign-in credentials (Google / Facebook / X). For each provider, both
  // halves must be set for it to be wired (createApiAuth checks); leave blank
  // for email/password-only installs. Optional on the type so test/embedder Env
  // literals needn't list them.
  googleClientId?: string;
  googleClientSecret?: string;
  facebookClientId?: string;
  facebookClientSecret?: string;
  twitterClientId?: string;
  twitterClientSecret?: string;
  // Force email verification on/off. Unset (the default) = on only when a real
  // mailer is configured (resendApiKey) — so a self-host install without email
  // isn't locked out, while SaaS gets it automatically. Set REQUIRE_EMAIL_
  // VERIFICATION=true to force it (e.g. dev testing with the console mailer, or
  // a self-host using SMTP). Tri-state: undefined means "use the default".
  requireEmailVerification?: boolean;
  // Turn Better Auth's login/credential rate limiting on. Defaults to on in
  // production and off everywhere else; RATE_LIMIT_ENABLED overrides either way
  // (e.g. =true to exercise it locally). loadEnv resolves it to a concrete bool;
  // optional on the type only so test/embedder Env literals needn't list it.
  rateLimitEnabled?: boolean;
  trustedOrigins: string[];
  publicAppUrl: string;
  // Email transport. When resendApiKey is set, server.ts wires the Resend
  // driver; otherwise it falls back to the console driver (logs the message
  // — fine for dev / self-host without SMTP). emailFrom is the From header
  // on every outbound message.
  resendApiKey: string | undefined;
  emailFrom: string;
  // Stripe credentials for the pay-link flow. All three must be set for
  // Stripe to be wired in — server.ts builds the bundle lazily and the
  // pay-button hides itself when null. Keeps dev / self-host runnable
  // without a Stripe account.
  stripeSecretKey: string | undefined;
  stripePublishableKey: string | undefined;
  stripeWebhookSecret: string | undefined;
  // Cron expression for the recurring-invoice sweep (pg-boss). Defaults to
  // 06:00 UTC daily. Override via RECURRING_SWEEP_CRON for a different cadence
  // (e.g. more frequent in dev to exercise the path).
  recurringSweepCron: string;
  // Cron expression for the yearly-depreciation sweep (pg-boss). Defaults to
  // 07:00 UTC daily — an hour after the recurring sweep so the two don't
  // contend. Daily, not yearly: the backfill has to fire on the first run after
  // deploy whatever the date, and it no-ops once every year owing is posted.
  //
  // Optional on the type for the same reason as jobsEnabled: the ~35 hand-built
  // test Env literals shouldn't have to grow a field for a scheduler that only
  // ever boots in server.ts. loadEnv always resolves it.
  depreciationSweepCron?: string;
  // Run the pg-boss scheduler + worker in this process. Default true, so a
  // single-box install runs the recurring-invoice sweep in the api. For a
  // multi-replica deploy, set JOBS_ENABLED=false on the extra replicas so jobs
  // run on exactly one instance. Optional on the type so test/embedder Env
  // literals needn't list it (loadEnv always resolves it; pg-boss boots only in
  // server.ts, never in tests).
  jobsEnabled?: boolean;
  // AI_ALLOW_PRIVATE_ENDPOINTS — operator SSRF policy for a user-supplied AI base
  // URL (Settings → AI). Default false: private + link-local addresses are
  // rejected. A self-hoster pointing at Ollama or a LAN model server sets it
  // true. A host-level security control, not AI config.
  aiAllowPrivateEndpoints?: boolean;
  // AI_ALLOWED_ENDPOINTS — the precise alternative to the blunt boolean above: a
  // comma-separated list of scheme://host:port endpoints that may resolve
  // private (e.g. http://ollama:11434). Opens exactly those, not the whole LAN.
  // Metadata/link-local stay blocked regardless.
  aiAllowedEndpoints?: string[];
  // Legal consent (Terms/Privacy clickwrap) — the SERVER side of the sign-up
  // gate. Undefined (the default) = not required: /api/legal reports
  // required:false, the web wall never shows, and a default self-host is
  // byte-identical to no-consent. Set LEGAL_CONSENT_REQUIRED=true to enable;
  // the URLs default to the bundled /legal/* template pages and the versions to
  // '1' (bump either version to re-prompt everyone). This is the server-side
  // counterpart to the web-only PUBLIC_TERMS_URL / PUBLIC_PRIVACY_URL that
  // render the sign-up checkbox. Optional on the type so test/embedder Env
  // literals needn't list it.
  legalConsent?: LegalConsentConfig;
};

const DEFAULT_PORT = 3000;
// Shared so bootstrap's fallback for an Env literal that omitted the field
// (tests, embedders) can't drift from what loadEnv resolves.
export const DEFAULT_DEPRECIATION_SWEEP_CRON = '0 7 * * *';
const VALID_NODE_ENVS: Env['nodeEnv'][] = ['development', 'test', 'production'];
const VALID_LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warning', 'error', 'fatal'];

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const nodeEnv = source.NODE_ENV ?? 'development';
  if (!VALID_NODE_ENVS.includes(nodeEnv as Env['nodeEnv'])) {
    throw new Error(`NODE_ENV must be one of ${VALID_NODE_ENVS.join(', ')}; got '${nodeEnv}'`);
  }
  const logLevel = source.LOG_LEVEL ?? 'info';
  if (!VALID_LOG_LEVELS.includes(logLevel as LogLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${VALID_LOG_LEVELS.join(', ')}; got '${logLevel}'`);
  }
  const databaseUrl = source.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const appDatabaseUrl = source.APP_DATABASE_URL;
  if (!appDatabaseUrl) throw new Error('APP_DATABASE_URL is required');
  const betterAuthSecret = source.BETTER_AUTH_SECRET;
  if (!betterAuthSecret) throw new Error('BETTER_AUTH_SECRET is required');
  const betterAuthUrl = source.BETTER_AUTH_URL;
  if (!betterAuthUrl) throw new Error('BETTER_AUTH_URL is required');
  assertNoWeakSecretsInProduction(source);
  return Object.freeze({
    nodeEnv: nodeEnv as Env['nodeEnv'],
    port: parsePort(source.API_PORT),
    logLevel: logLevel as LogLevel,
    errorTrackingDsn: source.ERROR_TRACKING_DSN || undefined,
    release: source.RELEASE || undefined,
    databaseUrl,
    appDatabaseUrl,
    dbPoolMax: parsePositiveInt(source.DB_POOL_MAX, 10, 'DB_POOL_MAX'),
    appRolePassword: source.THALERMARK_APP_PASSWORD || undefined,
    pgBossDatabaseUrl: source.PGBOSS_DATABASE_URL || databaseUrl,
    pgBossRolePassword: source.THALERMARK_PGBOSS_PASSWORD || undefined,
    migrateOnBoot: parseBool(source.MIGRATE_ON_BOOT),
    betterAuthSecret,
    betterAuthUrl,
    googleClientId: source.GOOGLE_CLIENT_ID || undefined,
    googleClientSecret: source.GOOGLE_CLIENT_SECRET || undefined,
    facebookClientId: source.FACEBOOK_CLIENT_ID || undefined,
    facebookClientSecret: source.FACEBOOK_CLIENT_SECRET || undefined,
    twitterClientId: source.TWITTER_CLIENT_ID || undefined,
    twitterClientSecret: source.TWITTER_CLIENT_SECRET || undefined,
    // Empty-string env vars (a bare `KEY=` in .env / compose env_file) arrive as
    // "" not undefined — treat them as unset so the fallbacks below fire. Without
    // this, `REQUIRE_EMAIL_VERIFICATION=` collapsed to a hard false and defeated
    // the "mailer configured ⇒ require verification" default (and the same trap
    // sat under RATE_LIMIT_ENABLED). Explicit true/false/1/0 still parse normally.
    requireEmailVerification: source.REQUIRE_EMAIL_VERIFICATION
      ? parseBool(source.REQUIRE_EMAIL_VERIFICATION)
      : undefined,
    rateLimitEnabled: source.RATE_LIMIT_ENABLED
      ? parseBool(source.RATE_LIMIT_ENABLED)
      : nodeEnv === 'production',
    trustedOrigins: parseOrigins(source.TRUSTED_ORIGINS),
    publicAppUrl: source.PUBLIC_APP_URL ?? '',
    resendApiKey: source.RESEND_API_KEY || undefined,
    emailFrom: source.EMAIL_FROM ?? 'Thalermark <hello@thalermark.com>',
    stripeSecretKey: source.STRIPE_SECRET_KEY || undefined,
    stripePublishableKey: source.STRIPE_PUBLISHABLE_KEY || undefined,
    stripeWebhookSecret: source.STRIPE_WEBHOOK_SECRET || undefined,
    recurringSweepCron: source.RECURRING_SWEEP_CRON || '0 6 * * *',
    depreciationSweepCron: source.DEPRECIATION_SWEEP_CRON || DEFAULT_DEPRECIATION_SWEEP_CRON,
    // Empty string (a bare JOBS_ENABLED= in compose env_file) → unset → default
    // true, same tri-state trap handled above for the other boolean flags.
    jobsEnabled: source.JOBS_ENABLED ? parseBool(source.JOBS_ENABLED) : true,
    // Default false (fail closed): reject private/link-local AI endpoints unless
    // the operator opts in. `? : false` so a bare `AI_ALLOW_PRIVATE_ENDPOINTS=`
    // reads as unset, not as an accidental enable.
    aiAllowPrivateEndpoints: source.AI_ALLOW_PRIVATE_ENDPOINTS
      ? parseBool(source.AI_ALLOW_PRIVATE_ENDPOINTS)
      : false,
    // Comma-separated; blank/unset → []. Entries are trimmed and empties dropped
    // so a trailing comma is harmless.
    aiAllowedEndpoints: (source.AI_ALLOWED_ENDPOINTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    // parseBool treats unset / "" as false, so the default is off and no
    // tri-state trap here. When on, URLs default to the bundled template pages
    // and versions to '1'.
    legalConsent: parseBool(source.LEGAL_CONSENT_REQUIRED)
      ? {
          termsUrl: source.LEGAL_TERMS_URL || '/legal/terms',
          privacyUrl: source.LEGAL_PRIVACY_URL || '/legal/privacy',
          termsVersion: source.LEGAL_TERMS_VERSION || '1',
          privacyVersion: source.LEGAL_PRIVACY_VERSION || '1',
        }
      : undefined,
  });
}

// The dev/self-host defaults that `.env.example` and docker-compose.yml ship so a
// bare `docker compose up` runs locally. In production these same values are an
// account-takeover risk — a known BETTER_AUTH_SECRET lets an attacker forge
// sessions, a known DB password hands them the database — so we refuse to boot on
// them (audit S5). No escape hatch by design: a bypass flag would undo the guard.
// install.sh generates strong secrets and passes cleanly.
const WEAK_BETTER_AUTH_SECRET = 'replace-me-with-a-long-random-string';
const WEAK_DB_PASSWORDS = new Set(['thalermark', 'thalermark_app', 'thalermark_pgboss']);

function passwordFromUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw).password || undefined;
  } catch {
    // Malformed URL — loadEnv's callers will surface the real connection error;
    // we just can't inspect a password we can't parse.
    return undefined;
  }
}

export function assertNoWeakSecretsInProduction(source: NodeJS.ProcessEnv): void {
  if (source.NODE_ENV !== 'production') return;

  const violations: string[] = [];

  if (source.BETTER_AUTH_SECRET === WEAK_BETTER_AUTH_SECRET) {
    violations.push('BETTER_AUTH_SECRET (shipped placeholder)');
  }
  for (const name of ['DATABASE_URL', 'APP_DATABASE_URL', 'PGBOSS_DATABASE_URL'] as const) {
    const pw = passwordFromUrl(source[name]);
    if (pw && WEAK_DB_PASSWORDS.has(pw)) {
      violations.push(`${name} (default password '${pw}')`);
    }
  }
  for (const name of ['THALERMARK_APP_PASSWORD', 'THALERMARK_PGBOSS_PASSWORD'] as const) {
    const pw = source[name];
    if (pw && WEAK_DB_PASSWORDS.has(pw)) {
      violations.push(`${name} (default value '${pw}')`);
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Refusing to start in production with weak default secrets: ${violations.join('; ')}. These ship for local dev only and enable account takeover in production. Set strong values (install.sh generates these).`,
    );
  }
}

function parsePort(raw: string | undefined): number {
  if (!raw) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    throw new Error(`API_PORT must be a positive integer ≤ 65535; got '${raw}'`);
  }
  return n;
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer; got '${raw}'`);
  }
  return n;
}

function parseBool(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.toLowerCase();
  return v === 'true' || v === '1';
}

// Comma-separated origin allowlist. Used both by Better Auth (CSRF check on
// auth endpoints) and Hono's cors middleware (RPC endpoints). Empty list is
// fine in test/migration contexts where no browser traffic ever arrives.
function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
