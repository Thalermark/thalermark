import { describe, expect, it } from 'vitest';
import { createDefaultAppDeps } from '../src/bootstrap.js';
import type { Env } from '../src/env.js';
import { communityAccountNotices } from '../src/lib/account-notice.js';
import { communityEntitlements } from '../src/lib/entitlement.js';
import { appDatabaseUrl } from './test-helper.js';

// The boot factory that both composition roots call. This proves the extracted
// createDefaultAppDeps wires the SAME community defaults server.ts used to build
// inline, and hands back the disposable handles a root needs — the coverage the
// server.ts script never had (integration tests boot createApp, never server.ts).

function testEnv(overrides: Partial<Env> = {}): Env {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL not set — global-setup.ts should have set it');
  return {
    nodeEnv: 'test',
    port: 3000,
    logLevel: 'info',
    errorTrackingDsn: undefined,
    release: undefined,
    databaseUrl,
    appDatabaseUrl: appDatabaseUrl(),
    appRolePassword: undefined,
    migrateOnBoot: false,
    betterAuthSecret: 'test-secret-at-least-32-characters-long',
    betterAuthUrl: 'http://localhost:3000',
    trustedOrigins: [],
    publicAppUrl: 'http://localhost:5173',
    resendApiKey: undefined,
    emailFrom: 'Thalermark <test@thalermark.test>',
    stripeSecretKey: undefined,
    stripePublishableKey: undefined,
    stripeWebhookSecret: undefined,
    recurringSweepCron: '0 6 * * *',
    ...overrides,
  };
}

describe('createDefaultAppDeps — the boot factory', () => {
  it('returns fully-wired community deps + disposable handles', async () => {
    const { deps, handles } = createDefaultAppDeps(testEnv());
    try {
      // The disposable resources a root needs for teardown + handle-dependent
      // overrides (a commercial BYOK resolver reuses llmStore; a plan provider
      // reads tenantDb.db).
      expect(handles.tenantDb).toBeDefined();
      expect(handles.bootstrapDb).toBeDefined();
      expect(handles.llmStore).toBeDefined();
      expect(handles.mailer).toBeDefined();

      // Community seam defaults are selected inside the factory — this is what
      // keeps the public build byte-identical / unrestricted.
      expect(deps.entitlement).toBe(communityEntitlements);
      expect(deps.accountNotice).toBe(communityAccountNotices);

      // The Settings → AI store on deps is the SAME instance returned in handles,
      // so a commercial root can build its resolver over core's store.
      expect(deps.llmConnections).toBe(handles.llmStore);

      // The required deps are present and point at the constructed pools.
      expect(deps.auth).toBeDefined();
      expect(deps.db).toBe(handles.tenantDb.db);
      expect(deps.bootstrapDb).toBe(handles.bootstrapDb.db);

      // No provider env configured in tests → the opt-in providers degrade to
      // null exactly as they do on a bare self-host boot.
      expect(deps.stripe).toBeNull();
      expect(deps.addressProvider).toBeNull();
    } finally {
      await handles.tenantDb.close();
      await handles.bootstrapDb.close();
    }
  });

  it('aiEndpointPolicy overrides BOTH env knobs — seals tenant BYOK SSRF at both layers', async () => {
    // env would allow private endpoints AND allowlist a host; the forced policy must
    // win at BOTH the connect-time store guard and the request-time settings check —
    // so both deps fields must reflect the policy, not env.
    const env = testEnv({ aiAllowPrivateEndpoints: true, aiAllowedEndpoints: ['http://x:9000'] });
    const { deps, handles } = createDefaultAppDeps(env, {
      aiEndpointPolicy: { allowPrivate: false, allowedEndpoints: [] },
    });
    try {
      expect(deps.aiAllowPrivateEndpoints).toBe(false);
      expect(deps.aiAllowedEndpoints).toEqual([]);
    } finally {
      await handles.tenantDb.close();
      await handles.bootstrapDb.close();
    }
  });

  it('without the opt, the AI policy falls back to env (byte-identical)', async () => {
    const env = testEnv({ aiAllowPrivateEndpoints: true, aiAllowedEndpoints: ['http://x:9000'] });
    const { deps, handles } = createDefaultAppDeps(env);
    try {
      expect(deps.aiAllowPrivateEndpoints).toBe(true);
      expect(deps.aiAllowedEndpoints).toEqual(['http://x:9000']);
    } finally {
      await handles.tenantDb.close();
      await handles.bootstrapDb.close();
    }
  });
});
