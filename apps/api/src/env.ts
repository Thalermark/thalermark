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
  databaseUrl: string;
  migrateOnBoot: boolean;
  betterAuthSecret: string;
  betterAuthUrl: string;
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
    migrateOnBoot: parseBool(source.MIGRATE_ON_BOOT),
    betterAuthSecret,
    betterAuthUrl,
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
