import { createHash, randomBytes } from 'node:crypto';
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
  // Custom scopes the MCP layer gates on, ON TOP of the OIDC defaults. Proves
  // the seam forwards IdpOptions.scopes into the mcp plugin's oidcConfig.
  scopes: ['read', 'contacts:write'],
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

// Same session-cookie pattern the other integration suites use (e.g.
// accounting-reports.integration.test.ts) — sign-up returns a live session so
// we can reach the /mcp/authorize scope gate, which redirects unauthenticated
// callers to the login page *before* it ever validates scopes.
function extractSessionCookie(res: Response): string {
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

async function signUp(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return extractSessionCookie(res);
}

// The MCP authorize endpoint resolves its client from the oauth_application
// table (RFC 7591 dynamic registration), NOT from trustedClients — so we
// register one first. A valid S256 PKCE pair + registered redirect_uri get us
// past every other check, leaving `scope` as the only variable between the two
// requests below.
const REDIRECT_URI = 'http://localhost:5173/api/auth/callback';
const pkceVerifier = randomBytes(32).toString('base64url');
const pkceChallenge = createHash('sha256').update(pkceVerifier).digest().toString('base64url');

async function registerMcpClient(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request('/api/auth/mcp/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      client_name: 'idp-seam-test-client',
    }),
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`mcp register failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { client_id: string }).client_id;
}

async function authorize(
  app: ReturnType<typeof createApp>,
  cookie: string,
  clientId: string,
  scope: string,
): Promise<Response> {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope,
    code_challenge: pkceChallenge,
    code_challenge_method: 'S256',
  });
  return app.request(`/api/auth/mcp/authorize?${q.toString()}`, { headers: { cookie } });
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
      const res2 = await ctx.app.request(authorizePath);
      expect(res2.status).not.toBe(404);
    } finally {
      await ctx.handle.close();
    }
  });

  it('seam ON: /mcp/authorize honors the forwarded custom scopes', async () => {
    // The real proof that IdpOptions.scopes reaches the AS: the mcp plugin's
    // authorize endpoint rejects any requested scope not in its scope set
    // (better-auth oidc authorize: invalidScopes = requestScope − opts.scopes →
    // invalid_scope). `scopes_supported` in discovery is hardcoded to the OIDC
    // defaults, so it can't show this — the authorize gate is where it's visible.
    const ctx = buildApp(idp);
    try {
      const cookie = await signUp(ctx.app, 'idp-scopes@example.com');
      const clientId = await registerMcpClient(ctx.app);

      // Same request in every respect except the scope, so the only thing that
      // can differ in the outcome is whether the AS knows the scope.
      const forwarded = await authorize(ctx.app, cookie, clientId, 'contacts:write');
      const unknown = await authorize(ctx.app, cookie, clientId, 'totally:bogus');

      // The unregistered scope is bounced back with invalid_scope...
      expect(unknown.headers.get('location') ?? '').toContain('invalid_scope');
      // ...while the forwarded one clears the gate (it does NOT come back as
      // invalid_scope — proving options.idp.scopes was threaded into oidcConfig).
      expect(forwarded.headers.get('location') ?? '').not.toContain('invalid_scope');
    } finally {
      await ctx.handle.close();
    }
  });
});
