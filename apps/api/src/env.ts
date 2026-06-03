// Typed environment loader for the API process. Reads from process.env once
// at boot and exposes a frozen, validated config object. Anything missing or
// malformed throws synchronously — we want the process to refuse to start
// rather than degrade.
//
// Add fields here as upstream slices need them (DB, auth, telemetry, etc.).
// The skeleton only needs PORT + NODE_ENV.

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
  // When set, server.ts runs `ALTER ROLE thalermark_app WITH LOGIN PASSWORD`
  // at boot. Leave blank if the role is provisioned out-of-band.
  appRolePassword: string | undefined;
  migrateOnBoot: boolean;
  betterAuthSecret: string;
  betterAuthUrl: string;
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
};

const DEFAULT_PORT = 3000;
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
  return Object.freeze({
    nodeEnv: nodeEnv as Env['nodeEnv'],
    port: parsePort(source.API_PORT),
    logLevel: logLevel as LogLevel,
    errorTrackingDsn: source.ERROR_TRACKING_DSN || undefined,
    release: source.RELEASE || undefined,
    databaseUrl,
    appDatabaseUrl,
    appRolePassword: source.THALERMARK_APP_PASSWORD || undefined,
    migrateOnBoot: parseBool(source.MIGRATE_ON_BOOT),
    betterAuthSecret,
    betterAuthUrl,
    trustedOrigins: parseOrigins(source.TRUSTED_ORIGINS),
    publicAppUrl: source.PUBLIC_APP_URL ?? '',
    resendApiKey: source.RESEND_API_KEY || undefined,
    emailFrom: source.EMAIL_FROM ?? 'Thalermark <hello@thalermark.com>',
    stripeSecretKey: source.STRIPE_SECRET_KEY || undefined,
    stripePublishableKey: source.STRIPE_PUBLISHABLE_KEY || undefined,
    stripeWebhookSecret: source.STRIPE_WEBHOOK_SECRET || undefined,
    recurringSweepCron: source.RECURRING_SWEEP_CRON || '0 6 * * *',
  });
}

function parsePort(raw: string | undefined): number {
  if (!raw) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    throw new Error(`API_PORT must be a positive integer ≤ 65535; got '${raw}'`);
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
