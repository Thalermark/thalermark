import type { IdpOptions } from '@thalermark/auth';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb } from './test-helper.js';

// Open-core identity-provider seam. Injecting `idp` turns on Better Auth's
// `mcp`/`oidc-provider` plugins so core becomes the OAuth2/OIDC authority for the
// commercial dashboard/admin surfaces + MCP clients; omitting it (the public
// build) loads neither plugin and leaves /api/auth exactly as it was. This proves
// both directions: the createApiAuth pass-through wires the plugins, and the
// discovery route (app.ts) reflects the auth instance — gated on the same switch.

const testEnv: Env = {
  nodeEnv: 'test',
  port: 3000,
  logLevel: 'info',
  errorTrackingDsn: undefined,
  release: undefined,
  databaseUrl: '',
  appDatabaseUrl: '',
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
};

// A commercial root injects this; the public build passes nothing.
const idp: IdpOptions = {
  loginPage: 'http://localhost:5173/login',
  trustedClients: [
    {
      clientId: 'test-dashboard',
      clientSecret: 'test-dashboard-secret',
      name: 'Test Dashboard',
      type: 'web',
      redirectUrls: ['http://localhost:5173/api/auth/callback'],
      skipConsent: true,
    },
  ],
  allowDynamicClientRegistration: true,
};

// idp omitted → createApiAuth loads no IdP plugins and createApp leaves the
// discovery route gated off, exactly like the public build.
function buildApp(seam?: IdpOptions) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(
    getTestDb(),
    { ...testEnv, databaseUrl: url },
    undefined,
    seam ? { idp: seam } : undefined,
  );
  const app = createApp({ auth, db: handle.db, bootstrapDb: getTestDb(), idpEnabled: !!seam });
  return { app, handle };
}

describe('IdP seam — createApiAuth wiring + discovery route', () => {
  it('seam OFF: no OIDC/MCP endpoints, discovery route 404s (byte-identical)', async () => {
    const ctx = buildApp();
    try {
      const wellKnown = await ctx.app.request('/.well-known/oauth-authorization-server');
      expect(wellKnown.status).toBe(404);
      // The MCP authorize endpoint isn't registered either — /api/auth/* is still
      // handled by Better Auth, but the plugin that adds this route is off.
      const authorize = await ctx.app.request('/api/auth/mcp/authorize');
      expect(authorize.status).toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });

  it('seam ON: core advertises itself as the OAuth authorization server', async () => {
    const ctx = buildApp(idp);
    try {
      const res = await ctx.app.request('/.well-known/oauth-authorization-server');
      expect(res.status).toBe(200);
      const meta = (await res.json()) as {
        issuer?: string;
        authorization_endpoint?: string;
        token_endpoint?: string;
      };
      // Better Auth's mcp plugin serves the OAuth flow under /api/auth/mcp/*
      // (that's what MCP clients discover here); the issuer is core's own origin.
      expect(meta.issuer).toBeTruthy();
      expect(meta.authorization_endpoint).toContain('/api/auth/mcp/authorize');
      expect(meta.token_endpoint).toContain('/api/auth/mcp/token');

      // And the advertised authorize endpoint is now a live route, not the generic
      // 404 the off case returns (no params → the plugin's own 4xx / redirect, not
      // "unknown route"). Drive the exact path the metadata just advertised.
      const authorizePath = new URL(meta.authorization_endpoint ?? '').pathname;
      const authorize = await ctx.app.request(authorizePath);
      expect(authorize.status).not.toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });
});
