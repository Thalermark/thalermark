// MUST be first: populates process.env from .env before any dependency (notably
// Better Auth) captures it at import time. See load-env.ts for the full why.
import './load-env.js';
import { serve } from '@hono/node-server';
import { getLogger } from '@thalermark/logger';
import { PgBoss } from 'pg-boss';
import { createApp } from './app.js';
import {
  createDefaultAppDeps,
  initObservability,
  installShutdown,
  registerCoreJobs,
  runBootMigrations,
} from './bootstrap.js';
import { loadEnv } from './env.js';
import { communityEntitlements } from './lib/entitlement.js';

// The community / self-host composition root. It loads env, runs the boot DDL,
// builds the default (community) deps via the shared factory, mounts them with
// createApp, and owns the runtime lifecycle (serve + pg-boss + shutdown). All
// provider construction lives in bootstrap.ts's createDefaultAppDeps, so a core
// provider swap never touches this file — and a downstream commercial root reuses
// the same factory + helpers and overrides only the seams it swaps.
const env = loadEnv();
initObservability(env);
const log = getLogger(['api', 'server']);

// MIGRATE_ON_BOOT + idempotent role provisioning. Production deploys generally
// want a dedicated migrate step ahead of the rollout (MIGRATE_ON_BOOT=false).
await runBootMigrations(env);

const { deps, handles } = createDefaultAppDeps(env);
const app = createApp(deps);

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

// Background jobs (pg-boss). The scheduler + worker lifecycle lives here (not in
// createApp / the shared factory), so the integration-test suite never boots
// pg-boss, and a multi-replica deploy can set JOBS_ENABLED=false on the extra
// replicas to run jobs on exactly one instance. The queue/worker/schedule wiring
// itself is shared via registerCoreJobs. pg-boss owns its own `pgboss` schema
// (createSchema:false — migration 0052 created it, owned by the least-privilege
// thalermark_pgboss role). A scheduler failure is logged but does NOT take the
// HTTP server down — recurring billing degrades, the rest of the app serves.
let boss: PgBoss | null = null;
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
    await registerCoreJobs(
      boss,
      {
        bootstrapDb: handles.bootstrapDb.db,
        tenantDb: handles.tenantDb.db,
        mailer: handles.mailer,
        emailFrom: env.emailFrom,
        publicAppUrl: env.publicAppUrl,
        entitlement: communityEntitlements,
      },
      env,
    );
  } catch (err) {
    log.error('failed to start pg-boss scheduler: {msg}', {
      msg: err instanceof Error ? err.message : String(err),
    });
    boss = null;
  }
} else {
  log.info('background jobs disabled (JOBS_ENABLED=false)');
}

installShutdown({ server, handles, boss: () => boss });
