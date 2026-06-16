// Transport configuration sourced from the environment.
//
// Two-key model (intentional):
//   - TELEMETRY_TRANSPORT_ENABLED   — deployment-wide kill switch (default off).
//   - accounts.telemetry_enabled    — per-account opt-in (default off, see emit).
// Both must be true for events to leave the host. The deployment switch lets
// us flip an endpoint URL or schema version in config without a redeploy;
// the per-account toggle is the user-visible consent.
//
// TELEMETRY_ENDPOINT_URL has no default. If the deployment switch is on but
// the URL is unset, flushTelemetry no-ops (and logs once). This prevents
// any chance of self-hosters accidentally pointing at our hosted endpoint.

export type TransportConfig = {
  enabled: boolean;
  endpointUrl: string | undefined;
  signingKey: string | undefined;
  batchSize: number;
  retryCap: number;
};

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_RETRY_CAP = 5;

export function loadTransportConfig(env: NodeJS.ProcessEnv = process.env): TransportConfig {
  return {
    enabled: env.TELEMETRY_TRANSPORT_ENABLED === 'true',
    endpointUrl: env.TELEMETRY_ENDPOINT_URL || undefined,
    signingKey: env.TELEMETRY_SIGNING_KEY || undefined,
    batchSize: parsePositiveInt(env.TELEMETRY_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    retryCap: parsePositiveInt(env.TELEMETRY_RETRY_CAP, DEFAULT_RETRY_CAP),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Hard kill switch independent of the transport keys. When TELEMETRY_DISABLED
// is set, the consent prompt never shows, the settings toggle is hidden, and
// emit() refuses to stage anything — even for an account whose opt-in flag is
// somehow still true. Lets a self-host operator forbid telemetry outright (the
// TELEMETRY_DISABLED contract documented in TELEMETRY.md), distinct from the
// deployment transport switch which only governs whether staged events leave.
export function isTelemetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TELEMETRY_DISABLED === 'true';
}
