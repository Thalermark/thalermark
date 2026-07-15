import { resolve } from 'node:path';
import { loadDotEnv } from './env-file.js';

// Loaded as the FIRST import in server.ts, on purpose. The project-root .env is
// the dev convention (see drizzle.config.ts), but it must populate process.env
// BEFORE any dependency reads it at module-evaluation time — and ESM evaluates
// every import in server.ts before server.ts's own body runs. Better Auth's
// @better-auth/core/env captures `process.env.NODE_ENV` into a module-level
// const the first time it's imported (transitively, via ./lib/auth.js); if the
// .env load happened in server.ts's body it would be too late, the capture
// would see "" instead of "development", and BA's rate limiter — which only
// falls back to a localhost client IP in dev/test — would silently skip
// throttling on local (proxy-less, no x-forwarded-for) requests. Doing the load
// in a first-imported side-effect module fixes the ordering for every reader.
//
// The actual file read lives in the auth-free ./env-file leaf so a downstream
// composition root can reuse it the same way (its own first-import shim, its own
// .env path) without dragging in the auth graph before env is populated.
loadDotEnv(resolve(import.meta.dirname, '../../../.env'));
