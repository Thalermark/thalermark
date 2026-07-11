import type { LlmCredential, ProbeResult } from '@thalermark/ai';
import { authUser, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { deriveConnectionKey } from '../src/lib/crypto.js';
import { createApiDatabase } from '../src/lib/db.js';
import { type LlmConnectionStore, createLlmConnectionStore } from '../src/lib/llm-connection.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Settings → AI, end-to-end through RLS: configure a connection, verify it, and
// watch the health gate turn AI on and off. The verify probe is stubbed (no live
// model) so CI exercises the full route + store + resolver path deterministically.

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

const masterKey = deriveConnectionKey(testEnv.betterAuthSecret);
// Preset-realistic: a preset probe omits `structured` (the row keeps tracking the
// preset in code). A custom-endpoint probe measures it — covered separately.
const okProbe = async (): Promise<ProbeResult> => ({ ok: true, latencyMs: 5 });
const failProbe = async (): Promise<ProbeResult> => ({
  ok: false,
  latencyMs: 3,
  error: 'invalid x-api-key',
});

function extractSessionCookie(res: Response): string {
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

type BuildOpts = {
  withStore?: boolean; // default true
  probe?: (c: LlmCredential) => Promise<ProbeResult>;
  allowPrivate?: boolean;
};

function buildApp(opts: BuildOpts = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const store: LlmConnectionStore | undefined =
    opts.withStore === false ? undefined : createLlmConnectionStore(handle.db, masterKey);
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
    llmConnections: store,
    llmProbe: opts.probe ?? okProbe,
    aiAllowPrivateEndpoints: opts.allowPrivate ?? false,
  });
  return { app, store, handle };
}

async function signUp(app: ReturnType<typeof createApp>, email: string) {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`);
  return extractSessionCookie(res);
}

async function accountFor(email: string): Promise<string> {
  const db = getTestDb();
  const [user] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email));
  if (!user) throw new Error(`user ${email} not seeded`);
  const [m] = await db
    .select({ accountId: memberships.accountId })
    .from(memberships)
    .where(eq(memberships.userId, user.id));
  if (!m) throw new Error(`membership for ${email} not seeded`);
  return m.accountId;
}

function req(
  app: ReturnType<typeof createApp>,
  method: string,
  cookie: string,
  accountId: string,
  body?: Record<string, unknown>,
  path = '/api/settings/ai',
) {
  return app.request(path, {
    method,
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('Settings → AI', () => {
  beforeEach(resetDb);

  it('503s when no store is wired (embedder / omitted dep)', async () => {
    const ctx = buildApp({ withStore: false });
    try {
      const cookie = await signUp(ctx.app, 'nostore@example.com');
      const accountId = await accountFor('nostore@example.com');
      const res = await req(ctx.app, 'GET', cookie, accountId);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'ai_not_available' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('starts unconfigured and lists the provider presets', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'fresh@example.com');
      const accountId = await accountFor('fresh@example.com');
      const res = await req(ctx.app, 'GET', cookie, accountId);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        connection: unknown;
        presets: { id: string }[];
        allowPrivate: boolean;
      };
      expect(body.connection).toBeNull();
      expect(body.presets.map((p) => p.id)).toEqual(
        expect.arrayContaining(['anthropic', 'openai', 'ollama', 'custom']),
      );
      expect(body.allowPrivate).toBe(false);
    } finally {
      await ctx.handle.close();
    }
  });

  it('save → verify → ready is the flow that turns AI on', async () => {
    const ctx = buildApp();
    if (!ctx.store) throw new Error('store expected');
    try {
      const cookie = await signUp(ctx.app, 'flow@example.com');
      const accountId = await accountFor('flow@example.com');

      // Save. Stored, masked, and AI still OFF — the health gate holds until verify.
      const put = await req(ctx.app, 'PUT', cookie, accountId, {
        provider: 'anthropic',
        apiKey: 'sk-ant-secret1234',
      });
      expect(put.status).toBe(200);
      const saved = (await put.json()) as { connection: Record<string, unknown> };
      expect(saved.connection).toMatchObject({
        provider: 'anthropic',
        status: 'unverified',
        hasKey: true,
        keyHint: '••••1234',
      });
      expect(await ctx.store.getUsable(accountId)).toBeNull();

      // Verify. Now ready, and the resolver hands back the decrypted credential.
      const verify = await req(ctx.app, 'POST', cookie, accountId, {}, '/api/settings/ai/verify');
      expect(verify.status).toBe(200);
      const verified = (await verify.json()) as {
        result: { ok: boolean; structured?: boolean };
        connection: { status: string };
      };
      expect(verified.result).toMatchObject({ ok: true });
      expect(verified.connection.status).toBe('ready');
      // A preset keeps `structured` NULL, so the credential omits it (resolve
      // falls back to the preset's value in code).
      expect(await ctx.store.getUsable(accountId)).toEqual({
        provider: 'anthropic',
        apiKey: 'sk-ant-secret1234',
      });
    } finally {
      await ctx.handle.close();
    }
  });

  it('is sticky: a once-healthy connection keeps serving after a later error', async () => {
    const ctx = buildApp();
    if (!ctx.store) throw new Error('store expected');
    try {
      const cookie = await signUp(ctx.app, 'sticky@example.com');
      const accountId = await accountFor('sticky@example.com');
      await req(ctx.app, 'PUT', cookie, accountId, { provider: 'anthropic', apiKey: 'sk-a-1234' });
      await req(ctx.app, 'POST', cookie, accountId, {}, '/api/settings/ai/verify');

      // A live call fails later (revoked key). Status flips to error, but the
      // connection still OWNS the account — the resolver does NOT fall back to null.
      await ctx.store.recordError(accountId, 'overloaded');
      const get = await req(ctx.app, 'GET', cookie, accountId);
      const body = (await get.json()) as { connection: { status: string; lastError: string } };
      expect(body.connection.status).toBe('error');
      expect(body.connection.lastError).toBe('overloaded');
      expect(await ctx.store.getUsable(accountId)).not.toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('records live-call health only on a state change (no per-call churn)', async () => {
    const ctx = buildApp();
    if (!ctx.store) throw new Error('store expected');
    try {
      const cookie = await signUp(ctx.app, 'churn@example.com');
      const accountId = await accountFor('churn@example.com');
      await req(ctx.app, 'PUT', cookie, accountId, { provider: 'anthropic', apiKey: 'sk-a-1234' });
      await req(ctx.app, 'POST', cookie, accountId, {}, '/api/settings/ai/verify');

      // ready → recordOk is a no-op: already healthy, so nothing is written (the
      // "last ok" timestamp doesn't advance on every successful call).
      const ready = await ctx.store.getDisplay(accountId);
      await ctx.store.recordOk(accountId);
      expect((await ctx.store.getDisplay(accountId))?.lastOkAt).toBe(ready?.lastOkAt);

      // ready → error flips (a permanent failure reddens the chip).
      await ctx.store.recordError(accountId, 'invalid x-api-key');
      const err1 = await ctx.store.getDisplay(accountId);
      expect(err1?.status).toBe('error');
      expect(err1?.lastError).toBe('invalid x-api-key');

      // error → error is a no-op: a second failure doesn't churn the row.
      await ctx.store.recordError(accountId, 'a different message');
      const err2 = await ctx.store.getDisplay(accountId);
      expect(err2?.lastErrorAt).toBe(err1?.lastErrorAt);
      expect(err2?.lastError).toBe('invalid x-api-key');

      // error → ready recovers, and AI was sticky (served) the whole time.
      await ctx.store.recordOk(accountId);
      const recovered = await ctx.store.getDisplay(accountId);
      expect(recovered?.status).toBe('ready');
      expect(recovered?.lastError).toBeNull();
      expect(await ctx.store.getUsable(accountId)).not.toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('re-saving resets health — a changed connection must be re-verified', async () => {
    const ctx = buildApp();
    if (!ctx.store) throw new Error('store expected');
    try {
      const cookie = await signUp(ctx.app, 'resave@example.com');
      const accountId = await accountFor('resave@example.com');
      await req(ctx.app, 'PUT', cookie, accountId, { provider: 'anthropic', apiKey: 'sk-a-1234' });
      await req(ctx.app, 'POST', cookie, accountId, {}, '/api/settings/ai/verify');
      expect(await ctx.store.getUsable(accountId)).not.toBeNull();

      const put = await req(ctx.app, 'PUT', cookie, accountId, {
        provider: 'anthropic',
        apiKey: 'sk-a-9999',
      });
      expect(((await put.json()) as { connection: { status: string } }).connection.status).toBe(
        'unverified',
      );
      expect(await ctx.store.getUsable(accountId)).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('surfaces the provider error on a failed verify, and AI stays off', async () => {
    const ctx = buildApp({ probe: failProbe });
    if (!ctx.store) throw new Error('store expected');
    try {
      const cookie = await signUp(ctx.app, 'badkey@example.com');
      const accountId = await accountFor('badkey@example.com');
      await req(ctx.app, 'PUT', cookie, accountId, {
        provider: 'anthropic',
        apiKey: 'sk-bad-1234',
      });
      const verify = await req(ctx.app, 'POST', cookie, accountId, {}, '/api/settings/ai/verify');
      const body = (await verify.json()) as {
        result: { ok: boolean; error: string };
        connection: { status: string };
      };
      expect(body.result).toMatchObject({ ok: false, error: 'invalid x-api-key' });
      expect(body.connection.status).toBe('error');
      expect(await ctx.store.getUsable(accountId)).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('persists the DETECTED structured value for a custom endpoint', async () => {
    // A custom endpoint has no preset default, so the probe measures structured
    // and the store persists it (unlike a preset, which stays NULL). Literal-IP
    // baseUrl + allowPrivate so the SSRF guard does no DNS.
    const ctx = buildApp({
      allowPrivate: true,
      probe: async () => ({ ok: true, latencyMs: 2, structured: false }),
    });
    if (!ctx.store) throw new Error('store expected');
    try {
      const cookie = await signUp(ctx.app, 'custom@example.com');
      const accountId = await accountFor('custom@example.com');
      await req(ctx.app, 'PUT', cookie, accountId, {
        provider: 'custom',
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: 'sk-x',
        modelVision: 'm',
        modelReasoning: 'm',
        modelFast: 'm',
      });
      const verify = await req(ctx.app, 'POST', cookie, accountId, {}, '/api/settings/ai/verify');
      expect(
        ((await verify.json()) as { connection: { structured: boolean | null } }).connection
          .structured,
      ).toBe(false);
      // The resolved credential carries the measured value.
      expect(await ctx.store.getUsable(accountId)).toMatchObject({ structured: false });
    } finally {
      await ctx.handle.close();
    }
  });

  it('deletes the connection', async () => {
    const ctx = buildApp();
    if (!ctx.store) throw new Error('store expected');
    try {
      const cookie = await signUp(ctx.app, 'del@example.com');
      const accountId = await accountFor('del@example.com');
      // No baseUrl → the SSRF guard does no DNS, so this stays offline-safe.
      await req(ctx.app, 'PUT', cookie, accountId, { provider: 'anthropic', apiKey: 'sk-a-1234' });
      const del = await req(ctx.app, 'DELETE', cookie, accountId);
      expect(del.status).toBe(200);
      expect(await ctx.store.getDisplay(accountId)).toBeNull();
      expect(await ctx.store.getUsable(accountId)).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects an unknown provider and a custom endpoint with no base url', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'bad@example.com');
      const accountId = await accountFor('bad@example.com');

      const unknown = await req(ctx.app, 'PUT', cookie, accountId, { provider: 'gemini' });
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toEqual({ error: 'unknown_provider' });

      const noUrl = await req(ctx.app, 'PUT', cookie, accountId, {
        provider: 'custom',
        apiKey: 'sk-x',
        modelVision: 'm',
        modelReasoning: 'm',
        modelFast: 'm',
      });
      expect(noUrl.status).toBe(400);
      expect(await noUrl.json()).toEqual({ error: 'base_url_required' });
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('Settings → AI — SSRF guard on the write path', () => {
  beforeEach(resetDb);

  it('blocks the cloud metadata endpoint and private addresses by default', async () => {
    const ctx = buildApp({ allowPrivate: false });
    try {
      const cookie = await signUp(ctx.app, 'ssrf@example.com');
      const accountId = await accountFor('ssrf@example.com');

      const metadata = await req(ctx.app, 'PUT', cookie, accountId, {
        provider: 'custom',
        baseUrl: 'http://169.254.169.254/latest/meta-data/',
      });
      expect(metadata.status).toBe(400);
      expect(await metadata.json()).toEqual({
        error: 'endpoint_rejected',
        reason: 'blocked_address',
      });

      const priv = await req(ctx.app, 'PUT', cookie, accountId, {
        provider: 'custom',
        baseUrl: 'http://127.0.0.1:11434/v1',
      });
      expect(await priv.json()).toEqual({ error: 'endpoint_rejected', reason: 'private_address' });
    } finally {
      await ctx.handle.close();
    }
  });

  it('allows a private endpoint when the operator opts in (the Ollama path)', async () => {
    const ctx = buildApp({ allowPrivate: true });
    try {
      const cookie = await signUp(ctx.app, 'ollama@example.com');
      const accountId = await accountFor('ollama@example.com');
      const res = await req(ctx.app, 'PUT', cookie, accountId, {
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelVision: 'llama3.2-vision',
        modelReasoning: 'llama3.2',
        modelFast: 'llama3.2',
      });
      expect(res.status).toBe(200);
      // metadata is still blocked even with the flag on.
      const metadata = await req(ctx.app, 'PUT', cookie, accountId, {
        provider: 'custom',
        baseUrl: 'http://169.254.169.254/',
      });
      expect(await metadata.json()).toEqual({
        error: 'endpoint_rejected',
        reason: 'blocked_address',
      });
    } finally {
      await ctx.handle.close();
    }
  });
});
