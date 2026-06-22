import { authAccount, authUser } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import type { MailMessage, Mailer } from '../src/lib/mailer.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// End-to-end password reset through the real Hono app → Better Auth → Drizzle →
// Postgres. Covers the happy path, the social-only (no credential) exit, and
// the non-enumerating behaviour for an unknown email.

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

// In-memory mailer recorder so the test can read the reset link the api would
// have emailed (the same injection point production uses for Resend/console).
function recorderMailer() {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    async send(msg) {
      sent.push(msg);
    },
  };
  return { mailer, sent };
}

function buildApp(mailer?: Mailer) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url }, mailer);
  const app = createApp({ auth, db: handle.db, bootstrapDb: getTestDb() });
  return { app, handle };
}

function signUp(app: ReturnType<typeof createApp>, email: string, password: string) {
  return app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name: email }),
  });
}

function signIn(app: ReturnType<typeof createApp>, email: string, password: string) {
  return app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

function requestReset(app: ReturnType<typeof createApp>, email: string) {
  return app.request('/api/auth/request-password-reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

function resetPassword(app: ReturnType<typeof createApp>, token: string, newPassword: string) {
  return app.request('/api/auth/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, newPassword }),
  });
}

// The api builds the link as `${publicAppUrl}/reset-password?token=...`.
function tokenFromEmail(msg: MailMessage): string {
  const token = msg.text.match(/reset-password\?token=([^\s&]+)/)?.[1];
  if (!token) throw new Error(`no reset token in email: ${msg.text}`);
  return decodeURIComponent(token);
}

// Pull a recorded message by index with a guard, so strict index access stays
// happy after a length assertion.
function emailAt(sent: MailMessage[], i: number): MailMessage {
  const msg = sent[i];
  if (!msg) throw new Error(`expected an email at index ${i}, got ${sent.length}`);
  return msg;
}

describe('password reset', () => {
  beforeEach(resetDb);

  it('resets the password and the old one stops working', async () => {
    const { mailer, sent } = recorderMailer();
    const ctx = buildApp(mailer);
    try {
      const email = 'reset-happy@example.com';
      const oldPassword = 'correct horse battery staple';
      const newPassword = 'a brand new passphrase 9000';

      expect((await signUp(ctx.app, email, oldPassword)).status).toBe(200);

      const reqRes = await requestReset(ctx.app, email);
      expect(reqRes.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(emailAt(sent, 0).to).toBe(email);

      const token = tokenFromEmail(emailAt(sent, 0));
      const resetRes = await resetPassword(ctx.app, token, newPassword);
      expect(resetRes.status).toBe(200);

      // New password works, old one is rejected.
      expect((await signIn(ctx.app, email, newPassword)).status).toBe(200);
      expect((await signIn(ctx.app, email, oldPassword)).ok).toBe(false);
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a reset to a weak/common password and keeps the old one', async () => {
    const { mailer, sent } = recorderMailer();
    const ctx = buildApp(mailer);
    try {
      const email = 'reset-weak@example.com';
      const oldPassword = 'correct horse battery staple';
      expect((await signUp(ctx.app, email, oldPassword)).status).toBe(200);

      expect((await requestReset(ctx.app, email)).status).toBe(200);
      const token = tokenFromEmail(emailAt(sent, 0));

      // 'usuckballz1' clears the length rule (11 chars) but is on the breach
      // list, so the gate must reject it — the same policy as signup, now at
      // reset (NIST 800-63B "establish AND change").
      expect((await resetPassword(ctx.app, token, 'usuckballz1')).status).not.toBe(200);

      // The reset was blocked, not partially applied: the old password still works.
      expect((await signIn(ctx.app, email, oldPassword)).status).toBe(200);
    } finally {
      await ctx.handle.close();
    }
  });

  it('lets a social-only user (no credential) set a password via reset', async () => {
    const { mailer, sent } = recorderMailer();
    const ctx = buildApp(mailer);
    try {
      const email = 'reset-social@example.com';
      const db = getTestDb();

      // Sign up, then delete the credential account to mimic a social-only user
      // (Google/FB/X signup never creates a `credential` row).
      expect((await signUp(ctx.app, email, 'temp horse battery staple')).status).toBe(200);
      const user = await db.select().from(authUser).where(eq(authUser.email, email));
      const userId = user[0]?.id;
      if (!userId) throw new Error('signed-up user not found');
      await db
        .delete(authAccount)
        .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, 'credential')));

      // Reset establishes a credential cleanly (BA creates one when missing).
      expect((await requestReset(ctx.app, email)).status).toBe(200);
      const newPassword = 'social user sets a password';
      expect(
        (await resetPassword(ctx.app, tokenFromEmail(emailAt(sent, 0)), newPassword)).status,
      ).toBe(200);

      const cred = await db
        .select()
        .from(authAccount)
        .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, 'credential')));
      expect(cred).toHaveLength(1);
      expect((await signIn(ctx.app, email, newPassword)).status).toBe(200);
    } finally {
      await ctx.handle.close();
    }
  });

  it('does not send (or leak) for an unknown email', async () => {
    const { mailer, sent } = recorderMailer();
    const ctx = buildApp(mailer);
    try {
      // Neutral 200, identical to the known-account response, and no email sent.
      const res = await requestReset(ctx.app, 'nobody-here@example.com');
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(0);
    } finally {
      await ctx.handle.close();
    }
  });
});
