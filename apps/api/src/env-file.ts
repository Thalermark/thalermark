import { loadEnvFile } from 'node:process';

// The auth-free leaf that actually reads the .env file. Deliberately imports
// ONLY node builtins — nothing that transitively pulls in Better Auth, whose
// @better-auth/core/env captures process.env.NODE_ENV at module-evaluation time.
// A composition root (this app's load-env.ts, or a downstream one) can import
// this and call loadDotEnv() from its FIRST-imported side-effect module to
// populate process.env before the auth graph is ever evaluated. See load-env.ts
// for the full ordering rationale.
//
// Container deploys pass env vars directly and won't have a file present, so a
// missing file is not an error — we just fall back to process.env as-is.
export function loadDotEnv(absEnvPath: string): void {
  try {
    loadEnvFile(absEnvPath);
  } catch {
    // No .env on disk — fall back to process.env as-is.
  }
}
