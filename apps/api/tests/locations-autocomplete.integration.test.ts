import type {
  AddressAutocompleteProvider,
  AddressSuggestion,
  AutocompleteQuery,
} from '@thalermark/location';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Address autocomplete (GET /api/locations/autocomplete) — the route the mobile
// customer form uses (web has its own SvelteKit proxy). Exercises the happy path
// against a stub provider, the empty-query short-circuit, the q-too-long 400,
// the degrade-to-empty paths (no provider / provider throws), and auth gating.
// It's account-agnostic (a bootstrap path in rls-context), so a session cookie
// alone authenticates — no x-account-id, and the requests below deliberately
// omit it to prove that.

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

function extractSessionCookie(res: Response): string {
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

const sampleSuggestion: AddressSuggestion = {
  label: '123 Main St, Brooklyn, NY 11201, United States',
  addressLine1: '123 Main St',
  city: 'Brooklyn',
  region: 'NY',
  postalCode: '11201',
  country: 'US',
};

// Captures the query the route hands the provider so a test can assert q + the
// country bias were passed through.
let lastQuery: AutocompleteQuery | null = null;

function okProvider(
  suggestions: AddressSuggestion[] = [sampleSuggestion],
): AddressAutocompleteProvider {
  return {
    name: 'census',
    async autocomplete(query) {
      lastQuery = query;
      return suggestions;
    },
  };
}

const throwingProvider: AddressAutocompleteProvider = {
  name: 'census',
  async autocomplete(query) {
    lastQuery = query;
    throw new Error('upstream down');
  },
};

function buildApp(opts: { addressProvider?: AddressAutocompleteProvider | null } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
    addressProvider: opts.addressProvider === undefined ? okProvider() : opts.addressProvider,
  });
  return { app, handle };
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

function lookup(app: ReturnType<typeof createApp>, headers: Record<string, string>, qs: string) {
  return app.request(`/api/locations/autocomplete${qs}`, { headers });
}

beforeEach(async () => {
  await resetDb();
  lastQuery = null;
});

describe('address autocomplete', () => {
  it('returns provider suggestions (cookie only, no x-account-id)', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'addr@example.com');
      const res = await lookup(ctx.app, { cookie }, '?q=123%20Main&country=us');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { suggestions: AddressSuggestion[]; degraded: boolean };
      expect(body.degraded).toBe(false);
      expect(body.suggestions).toHaveLength(1);
      expect(body.suggestions[0]?.addressLine1).toBe('123 Main St');
      // q is trimmed/passed through; country is upper-cased to the ISO bias.
      expect(lastQuery?.q).toBe('123 Main');
      expect(lastQuery?.country).toBe('US');
    } finally {
      await ctx.handle.close();
    }
  });

  it('short-circuits an empty query without calling the provider', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'addr-empty@example.com');
      const res = await lookup(ctx.app, { cookie }, '?q=%20%20');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { suggestions: AddressSuggestion[]; degraded: boolean };
      expect(body.suggestions).toEqual([]);
      expect(body.degraded).toBe(false);
      expect(lastQuery).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('400s on an over-long query', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'addr-long@example.com');
      const res = await lookup(ctx.app, { cookie }, `?q=${'a'.repeat(201)}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('q_too_long');
    } finally {
      await ctx.handle.close();
    }
  });

  it('degrades to empty when no provider is configured', async () => {
    const ctx = buildApp({ addressProvider: null });
    try {
      const cookie = await signUp(ctx.app, 'addr-off@example.com');
      const res = await lookup(ctx.app, { cookie }, '?q=123%20Main');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { suggestions: AddressSuggestion[]; degraded: boolean };
      expect(body.suggestions).toEqual([]);
      expect(body.degraded).toBe(true);
    } finally {
      await ctx.handle.close();
    }
  });

  it('degrades to empty when the provider throws', async () => {
    const ctx = buildApp({ addressProvider: throwingProvider });
    try {
      const cookie = await signUp(ctx.app, 'addr-throw@example.com');
      const res = await lookup(ctx.app, { cookie }, '?q=123%20Main');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { suggestions: AddressSuggestion[]; degraded: boolean };
      expect(body.suggestions).toEqual([]);
      expect(body.degraded).toBe(true);
    } finally {
      await ctx.handle.close();
    }
  });

  it('401s without a session', async () => {
    const ctx = buildApp();
    try {
      const res = await lookup(ctx.app, {}, '?q=123%20Main');
      expect(res.status).toBe(401);
      expect(lastQuery).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });
});
