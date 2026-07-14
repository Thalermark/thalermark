import { authUser, legalAcceptances } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import type { LegalConsentConfig } from '../src/lib/legal-consent.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Legal-consent seam: server-side state + persistence for the Terms/Privacy
// clickwrap. The web/mobile wall reads GET /api/legal and posts to
// /api/legal/accept; this proves the record is per-USER + per-VERSION, idempotent,
// and that the whole feature is OFF (byte-identical) when no config is injected —
// the default self-host build. See lib/legal-consent.ts + spikes/SIGN-UP-ACK-TOS.md.

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

const V1: LegalConsentConfig = {
  termsUrl: '/legal/terms',
  privacyUrl: '/legal/privacy',
  termsVersion: '1',
  privacyVersion: '1',
};

type LegalState = {
  required: boolean;
  version: string | null;
  accepted: boolean;
  termsUrl: string | null;
  privacyUrl: string | null;
};

function extractSessionCookie(res: Response): string {
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

async function signUp(app: ReturnType<typeof createApp>, email: string) {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return extractSessionCookie(res);
}

async function userId(email: string): Promise<string> {
  const [user] = await getTestDb()
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email));
  if (!user) throw new Error(`user ${email} not seeded`);
  return user.id;
}

async function acceptanceRows(uid: string) {
  return getTestDb()
    .select({
      termsVersion: legalAcceptances.termsVersion,
      privacyVersion: legalAcceptances.privacyVersion,
      accountId: legalAcceptances.accountId,
    })
    .from(legalAcceptances)
    .where(eq(legalAcceptances.userId, uid));
}

function buildApp(opts: { legalConsent?: LegalConsentConfig } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    legalConsent: opts.legalConsent,
  });
  return { app, handle };
}

const getLegal = (app: ReturnType<typeof createApp>, cookie: string) =>
  app.request('/api/legal', { headers: { cookie } });

describe('legal consent — /api/legal + /api/legal/accept', () => {
  beforeEach(resetDb);

  it('is OFF by default: no config → required:false and accept is a no-op', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'off@example.com');

      const state = (await (await getLegal(app, cookie)).json()) as LegalState;
      expect(state.required).toBe(false);
      expect(state.accepted).toBe(false);

      // A stale client posting anyway must not error or write a row.
      const accept = await app.request('/api/legal/accept', {
        method: 'POST',
        headers: { cookie },
      });
      expect(accept.status).toBe(200);
      expect(await acceptanceRows(await userId('off@example.com'))).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });

  it('gate on: unaccepted → accept writes one row → accepted, idempotent', async () => {
    const { app, handle } = buildApp({ legalConsent: V1 });
    try {
      const cookie = await signUp(app, 'user@example.com');
      const uid = await userId('user@example.com');

      const before = (await (await getLegal(app, cookie)).json()) as LegalState;
      expect(before).toMatchObject({
        required: true,
        accepted: false,
        version: '1',
        termsUrl: '/legal/terms',
        privacyUrl: '/legal/privacy',
      });

      const accept = await app.request('/api/legal/accept', {
        method: 'POST',
        headers: { cookie },
      });
      expect(accept.status).toBe(200);

      const after = (await (await getLegal(app, cookie)).json()) as LegalState;
      expect(after.accepted).toBe(true);

      const rows = await acceptanceRows(uid);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ termsVersion: '1', privacyVersion: '1' });

      // Idempotent: a second accept is a no-op (unique index), still one row.
      await app.request('/api/legal/accept', { method: 'POST', headers: { cookie } });
      expect(await acceptanceRows(uid)).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  it('bumping the version re-prompts: accepted v1 reads unaccepted against v2', async () => {
    // First app on v1 — accept.
    const a = buildApp({ legalConsent: V1 });
    let cookie: string;
    try {
      cookie = await signUp(a.app, 'bump@example.com');
      await a.app.request('/api/legal/accept', { method: 'POST', headers: { cookie } });
      expect((await (await getLegal(a.app, cookie)).json()).accepted).toBe(true);
    } finally {
      await a.handle.close();
    }

    // Same user, a deployment that bumped the terms version → unaccepted again.
    const b = buildApp({ legalConsent: { ...V1, termsVersion: '2' } });
    try {
      const state = (await (await getLegal(b.app, cookie)).json()) as LegalState;
      expect(state).toMatchObject({ required: true, accepted: false, version: '2' });

      await b.app.request('/api/legal/accept', { method: 'POST', headers: { cookie } });
      // Now two rows for the person — one per accepted version.
      const rows = await acceptanceRows(await userId('bump@example.com'));
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.termsVersion).sort()).toEqual(['1', '2']);
    } finally {
      await b.handle.close();
    }
  });

  it('per-user: one person accepting does not mark another as accepted', async () => {
    const { app, handle } = buildApp({ legalConsent: V1 });
    try {
      const aCookie = await signUp(app, 'alice@example.com');
      const bCookie = await signUp(app, 'bob@example.com');

      await app.request('/api/legal/accept', { method: 'POST', headers: { cookie: aCookie } });

      expect((await (await getLegal(app, aCookie)).json()).accepted).toBe(true);
      // Bob is untouched — acceptance is keyed on the person, not the deployment.
      expect((await (await getLegal(app, bCookie)).json()).accepted).toBe(false);
      expect(await acceptanceRows(await userId('bob@example.com'))).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });
});
