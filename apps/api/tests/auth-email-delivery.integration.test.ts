import { authVerification } from '@thalermark/db';
import { like } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { type MailMessage, type Mailer, createConsoleMailer } from '../src/lib/mailer.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// TMC-239 — the two auth emails must key on DELIVERY, not on a mailer merely
// existing or on an env var merely being set.
//
// bootstrap.ts ALWAYS wires a mailer (the console driver is the fallback when
// RESEND_API_KEY is unset), so the old `mailer ? … : undefined` guards in
// lib/auth.ts were never false: Better Auth's RESET_PASSWORD_DISABLED was
// unreachable, password reset "succeeded" into stdout, and a live reset token
// was written to the log. The verification half was worse — it keyed on
// `!!env.resendApiKey`, so a key that was set but broken meant verification was
// REQUIRED while no verification mail could arrive: sign-in refused
// EMAIL_NOT_VERIFIED and password reset (the way out) failed the same way.
// Permanent lockout, and silent, because every Better Auth send goes through
// `runInBackgroundOrAwait`, which catches and logs.
//
// Every case below that stands for "cannot deliver" builds the app with the
// REAL `createConsoleMailer` — the driver that actually ships — not a
// hand-rolled stand-in with `logsOnly` bolted on, which would only prove this
// file can set a flag. Each is paired with a plain delivering recorder, so a
// fix that simply breaks email for everyone cannot pass.
//
// THE `nodeEnv === 'test'` PROBLEM: createApiAuth short-circuits
// `requireEmailVerification` to false whenever `env.nodeEnv === 'test'`, so the
// verification rules are unreachable under the suite's usual Env literal. The
// Env handed to createApiAuth is a plain object owned by the caller and is
// entirely separate from `process.env.NODE_ENV` — so this file simply declares
// `nodeEnv: 'development'` in its literal and changes nothing about the
// process. `process.env.NODE_ENV` stays 'test', so vitest, Better Auth's own
// isTest() behaviour, and the testcontainer are untouched. That is safe because
// `env.nodeEnv` has exactly one other reader in the api (bootstrap's Sentry
// environment tag and a server.ts log line), and neither runs here.

const EMAIL_FROM = 'Thalermark <test@thalermark.test>';
const RESET_SUBJECT = 'Reset your Thalermark password';
const VERIFY_SUBJECT = 'Confirm your email for Thalermark';
const PASSWORD = 'correct horse battery staple';

// nodeEnv 'development', not 'test' — see the header note.
const baseEnv: Env = {
  nodeEnv: 'development',
  port: 3000,
  logLevel: 'error',
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
  // Deliberately unset: the whole point is that the DEFAULT is derived from the
  // mailer. The override cases below pass it explicitly.
  requireEmailVerification: undefined,
  resendApiKey: undefined,
  emailFrom: EMAIL_FROM,
  stripeSecretKey: undefined,
  stripePublishableKey: undefined,
  stripeWebhookSecret: undefined,
  recurringSweepCron: '0 6 * * *',
};

// The shipped fallback driver, exactly as bootstrap.ts wires it when
// RESEND_API_KEY is unset. `logsOnly: true` lives on the driver itself.
function consoleMailer(): Mailer {
  return createConsoleMailer({ from: EMAIL_FROM });
}

// A mailer with no `logsOnly` marker — what every real transport looks like.
// The control side of each assertion below.
function recorderMailer(): { mailer: Mailer; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    async send(msg) {
      sent.push(msg);
    },
  };
  return { mailer, sent };
}

function buildApp(mailer: Mailer, overrides: Partial<Env> = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...baseEnv, databaseUrl: url, ...overrides }, mailer);
  const app = createApp({ auth, db: handle.db, bootstrapDb: getTestDb() });
  return { app, handle };
}

type App = ReturnType<typeof createApp>;

function signUp(app: App, email: string) {
  return app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, name: email }),
  });
}

function signIn(app: App, email: string) {
  return app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
}

function requestReset(app: App, email: string) {
  return app.request('/api/auth/request-password-reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

// Better Auth stores the one-time reset token in auth_verification under the
// identifier `reset-password:<token>` (api/routes/password.mjs). Its presence is
// the durable evidence that a live credential was minted — which is exactly what
// the console driver used to print to stdout.
async function resetTokenRows() {
  return getTestDb()
    .select()
    .from(authVerification)
    .where(like(authVerification.identifier, 'reset-password:%'));
}

describe('auth email delivery gates (TMC-239)', () => {
  beforeEach(resetDb);

  describe('password reset', () => {
    it('is disabled outright when the mailer cannot deliver', async () => {
      const ctx = buildApp(consoleMailer());
      try {
        const email = 'reset-console@example.com';
        expect((await signUp(ctx.app, email)).status).toBe(200);

        // Not the neutral 200 it used to give. Better Auth throws before it
        // reaches the user lookup, so /forgot-password can say so honestly.
        const res = await requestReset(ctx.app, email);
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('RESET_PASSWORD_DISABLED');
      } finally {
        await ctx.handle.close();
      }
    });

    it('mints no reset token when the mailer cannot deliver', async () => {
      const ctx = buildApp(consoleMailer());
      try {
        const email = 'reset-console-token@example.com';
        expect((await signUp(ctx.app, email)).status).toBe(200);
        await requestReset(ctx.app, email);

        // The old behaviour created this row and then logged the link built
        // from it. A valid reset credential in the server log is the bug.
        expect(await resetTokenRows()).toHaveLength(0);
      } finally {
        await ctx.handle.close();
      }
    });

    it('still works when the mailer delivers', async () => {
      const { mailer, sent } = recorderMailer();
      const ctx = buildApp(mailer);
      try {
        const email = 'reset-delivering@example.com';
        expect((await signUp(ctx.app, email)).status).toBe(200);

        const res = await requestReset(ctx.app, email);
        expect(res.status).toBe(200);

        // The recorder actually received it — without this, the two cases above
        // would pass on a fix that broke reset for everyone. (Verification is
        // also on with a delivering mailer, so `sent` holds the sign-up
        // verification message too; match on subject rather than length.)
        const reset = sent.filter((m) => m.subject === RESET_SUBJECT);
        expect(reset).toHaveLength(1);
        expect(reset[0]?.to).toBe(email);
        expect(reset[0]?.text).toContain('/reset-password?token=');

        // And the token exists — the control for the no-token assertion above.
        expect(await resetTokenRows()).toHaveLength(1);
      } finally {
        await ctx.handle.close();
      }
    });
  });

  describe('email verification', () => {
    it('is NOT required when the mailer cannot deliver', async () => {
      const ctx = buildApp(consoleMailer());
      try {
        // The lockout pin. Requiring verification an install cannot deliver
        // leaves a correctly-signed-up user with no way in and no way out.
        const email = 'verify-console@example.com';
        expect((await signUp(ctx.app, email)).status).toBe(200);

        const res = await signIn(ctx.app, email);
        expect(res.status).toBe(200);
        expect(await res.text()).not.toContain('EMAIL_NOT_VERIFIED');
      } finally {
        await ctx.handle.close();
      }
    });

    it('IS required when the mailer delivers', async () => {
      const { mailer, sent } = recorderMailer();
      const ctx = buildApp(mailer);
      try {
        const email = 'verify-delivering@example.com';
        expect((await signUp(ctx.app, email)).status).toBe(200);
        expect(sent.map((m) => m.subject)).toContain(VERIFY_SUBJECT);

        // Control for the case above: the gate is real, it just doesn't fire
        // when the mail can't arrive.
        const res = await signIn(ctx.app, email);
        expect(res.status).toBe(403);
        expect(await res.text()).toContain('EMAIL_NOT_VERIFIED');
      } finally {
        await ctx.handle.close();
      }
    });
  });

  // The operator escape hatch has to survive the change: an SMTP self-host that
  // core can't see still needs to force verification ON, and an operator who
  // verifies out-of-band still needs to force it OFF.
  describe('REQUIRE_EMAIL_VERIFICATION override', () => {
    it('forces verification ON even when the mailer cannot deliver', async () => {
      const ctx = buildApp(consoleMailer(), { requireEmailVerification: true });
      try {
        const email = 'override-on@example.com';
        expect((await signUp(ctx.app, email)).status).toBe(200);

        const res = await signIn(ctx.app, email);
        expect(res.status).toBe(403);
        expect(await res.text()).toContain('EMAIL_NOT_VERIFIED');
      } finally {
        await ctx.handle.close();
      }
    });

    it('forces verification OFF even when the mailer delivers', async () => {
      const { mailer, sent } = recorderMailer();
      const ctx = buildApp(mailer, { requireEmailVerification: false });
      try {
        const email = 'override-off@example.com';
        expect((await signUp(ctx.app, email)).status).toBe(200);
        expect(sent.map((m) => m.subject)).not.toContain(VERIFY_SUBJECT);

        expect((await signIn(ctx.app, email)).status).toBe(200);
      } finally {
        await ctx.handle.close();
      }
    });
  });
});
