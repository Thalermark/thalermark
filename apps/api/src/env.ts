// Typed environment loader for the API process. Reads from process.env once
// at boot and exposes a frozen, validated config object. Anything missing or
// malformed throws synchronously — we want the process to refuse to start
// rather than degrade.
//
// Add fields here as upstream slices need them (DB, auth, telemetry, etc.).
// The skeleton only needs PORT + NODE_ENV.

export type Env = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
};

const DEFAULT_PORT = 3000;
const VALID_NODE_ENVS: Env['nodeEnv'][] = ['development', 'test', 'production'];

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const nodeEnv = source.NODE_ENV ?? 'development';
  if (!VALID_NODE_ENVS.includes(nodeEnv as Env['nodeEnv'])) {
    throw new Error(`NODE_ENV must be one of ${VALID_NODE_ENVS.join(', ')}; got '${nodeEnv}'`);
  }
  return Object.freeze({
    nodeEnv: nodeEnv as Env['nodeEnv'],
    port: parsePort(source.API_PORT),
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
