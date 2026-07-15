import type {
  AddressAutocompleteProvider,
  AddressPrediction,
  AddressSuggestion,
  AutocompleteQuery,
  RetrieveQuery,
} from '@thalermark/location';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Address autocomplete (GET /api/locations/autocomplete + /details) — the routes
// the mobile customer form uses (web has its own SvelteKit proxy). Two-phase,
// matching Google Places: autocomplete returns predictions, details resolves the
// structured address on pick. Exercises the happy paths against a stub provider,
// the empty-query short-circuit, the q-too-long 400, the details place_id 400,
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

const samplePrediction: AddressPrediction = {
  placeId: 'ChIJplace123',
  label: '123 Main St, Brooklyn, NY 11201, United States',
};

const sampleSuggestion: AddressSuggestion = {
  label: '123 Main St, Brooklyn, NY 11201, United States',
  addressLine1: '123 Main St',
  city: 'Brooklyn',
  region: 'NY',
  postalCode: '11201',
  country: 'US',
};

// Capture the queries the routes hand the provider so a test can assert q, the
// country bias, and the session token/placeId were passed through.
let lastQuery: AutocompleteQuery | null = null;
let lastRetrieve: RetrieveQuery | null = null;

function okProvider(
  predictions: AddressPrediction[] = [samplePrediction],
): AddressAutocompleteProvider {
  return {
    name: 'google',
    async autocomplete(query) {
      lastQuery = query;
      return predictions;
    },
    async retrieve(query) {
      lastRetrieve = query;
      return sampleSuggestion;
    },
  };
}

const throwingProvider: AddressAutocompleteProvider = {
  name: 'google',
  async autocomplete(query) {
    lastQuery = query;
    throw new Error('upstream down');
  },
  async retrieve(query) {
    lastRetrieve = query;
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

function get(app: ReturnType<typeof createApp>, headers: Record<string, string>, path: string) {
  return app.request(path, { headers });
}

beforeEach(async () => {
  await resetDb();
  lastQuery = null;
  lastRetrieve = null;
});

describe('address autocomplete', () => {
  it('returns provider predictions (cookie only, no x-account-id)', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'addr@example.com');
      const res = await get(
        ctx.app,
        { cookie },
        '/api/locations/autocomplete?q=123%20Main&country=us&sessionToken=sess-1',
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { predictions: AddressPrediction[]; degraded: boolean };
      expect(body.degraded).toBe(false);
      expect(body.predictions).toHaveLength(1);
      expect(body.predictions[0]?.placeId).toBe('ChIJplace123');
      // q is trimmed/passed through; country is upper-cased; token forwarded.
      expect(lastQuery?.q).toBe('123 Main');
      expect(lastQuery?.country).toBe('US');
      expect(lastQuery?.sessionToken).toBe('sess-1');
    } finally {
      await ctx.handle.close();
    }
  });

  it('resolves details for a picked prediction', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'addr-details@example.com');
      const res = await get(
        ctx.app,
        { cookie },
        '/api/locations/details?placeId=ChIJplace123&sessionToken=sess-1',
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        suggestion: AddressSuggestion | null;
        degraded: boolean;
      };
      expect(body.degraded).toBe(false);
      expect(body.suggestion?.addressLine1).toBe('123 Main St');
      expect(lastRetrieve?.placeId).toBe('ChIJplace123');
      expect(lastRetrieve?.sessionToken).toBe('sess-1');
    } finally {
      await ctx.handle.close();
    }
  });

  it('short-circuits an empty query without calling the provider', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'addr-empty@example.com');
      const res = await get(ctx.app, { cookie }, '/api/locations/autocomplete?q=%20%20');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { predictions: AddressPrediction[]; degraded: boolean };
      expect(body.predictions).toEqual([]);
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
      const res = await get(
        ctx.app,
        { cookie },
        `/api/locations/autocomplete?q=${'a'.repeat(201)}`,
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('q_too_long');
    } finally {
      await ctx.handle.close();
    }
  });

  it('400s on details without a place id', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'addr-noplace@example.com');
      const res = await get(ctx.app, { cookie }, '/api/locations/details?placeId=%20');
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('place_id_required');
      expect(lastRetrieve).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('degrades to empty when no provider is configured', async () => {
    const ctx = buildApp({ addressProvider: null });
    try {
      const cookie = await signUp(ctx.app, 'addr-off@example.com');
      const res = await get(ctx.app, { cookie }, '/api/locations/autocomplete?q=123%20Main');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { predictions: AddressPrediction[]; degraded: boolean };
      expect(body.predictions).toEqual([]);
      expect(body.degraded).toBe(true);
    } finally {
      await ctx.handle.close();
    }
  });

  it('degrades to empty when the provider throws', async () => {
    const ctx = buildApp({ addressProvider: throwingProvider });
    try {
      const cookie = await signUp(ctx.app, 'addr-throw@example.com');
      const res = await get(ctx.app, { cookie }, '/api/locations/autocomplete?q=123%20Main');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { predictions: AddressPrediction[]; degraded: boolean };
      expect(body.predictions).toEqual([]);
      expect(body.degraded).toBe(true);
    } finally {
      await ctx.handle.close();
    }
  });

  it('401s without a session', async () => {
    const ctx = buildApp();
    try {
      const res = await get(ctx.app, {}, '/api/locations/autocomplete?q=123%20Main');
      expect(res.status).toBe(401);
      expect(lastQuery).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });
});
