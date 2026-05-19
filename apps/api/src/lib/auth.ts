import { createAuth } from '@thalermark/auth';
import type { Database } from '@thalermark/db';
import type { Env } from '../env.js';

// Thin wrapper around @thalermark/auth's createAuth: pulls config out of the
// loaded env. server.ts holds the resulting handle and passes it into the
// Hono factory.
export function createApiAuth(db: Database, env: Env) {
  return createAuth(db, {
    secret: env.betterAuthSecret,
    baseURL: env.betterAuthUrl,
  });
}

export type ApiAuth = ReturnType<typeof createApiAuth>;
