import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authUser, companies, contacts, estimates, invoices, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { type ApiDatabase, createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// The other half of TMC-226: what the provider tells us AFTER the send call
// returned 200.
//
// The send half already shipped — a mailer that throws marks the document
// failed. But the failures that actually cost a freelancer money are the quiet
// ones: the provider accepts the message, answers 200, and the far end rejects
// it thirty seconds later. Nothing in the request/response cycle can see that.
//
// Payloads come from apps/api/tests/fixtures/resend-webhook-events.json, which
// was captured off a live Resend account rather than written by hand.
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(
  readFileSync(resolve(here, 'fixtures/resend-webhook-events.json'), 'utf8'),
) as Record<string, { type: string; created_at: string; data: Record<string, unknown> }>;

const SECRET = 'whsec_dGhpcyBpcyBub3QgYSByZWFsIHNlY3JldCwgaXQgaXMgYSB0ZXN0';

const testEnv: Env = {
  nodeEnv: 'test',
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
  resendApiKey: undefined,
  emailFrom: 'Thalermark <test@thalermark.test>',
  stripeSecretKey: undefined,
  stripePublishableKey: undefined,
  stripeWebhookSecret: undefined,
  recurringSweepCron: '0 6 * * *',
};

function buildApp(opts: { secret?: string } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
    emailFrom: testEnv.emailFrom,
    resendWebhookSecret: opts.secret,
  });
  return { app, handle };
}

// Signs the way Svix does, which is the way Resend does: id, timestamp and the
// RAW body joined by dots.
function deliver(
  app: ReturnType<typeof createApp>,
  payload: unknown,
  opts: { secret?: string; skew?: number } = {},
) {
  const rawBody = JSON.stringify(payload);
  const id = 'msg_test';
  const timestamp = String(Math.floor(Date.now() / 1000) + (opts.skew ?? 0));
  const key = Buffer.from((opts.secret ?? SECRET).replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  return app.request('/api/webhooks/resend', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${sig}`,
    },
    body: rawBody,
  });
}

async function signUp(app: ReturnType<typeof createApp>, email: string) {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
}

// An invoice already sent, carrying the provider's id for the message — the
// state every one of these webhooks arrives into.
async function seedSentInvoice(opts: { messageId: string | null; sentAt: Date }) {
  const db = getTestDb();
  const email = `webhook-${uuidv7()}@example.com`;
  const { app, handle } = buildApp({ secret: SECRET });
  await signUp(app, email);

  const [user] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email));
  const [m] = await db
    .select({ accountId: memberships.accountId })
    .from(memberships)
    .where(eq(memberships.userId, user?.id as string));
  const accountId = m?.accountId as string;
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.accountId, accountId));
  const companyId = company?.id as string;

  const contactId = uuidv7();
  await db.insert(contacts).values({
    id: contactId,
    accountId,
    companyId,
    name: 'Acme Landscaping',
    email: 'customer@example.com',
  });

  const invoiceId = uuidv7();
  await db.insert(invoices).values({
    id: invoiceId,
    accountId,
    companyId,
    contactId,
    number: `INV-${invoiceId.slice(-12)}`,
    issueDate: '2026-06-01',
    dueDate: '2026-06-10',
    subtotal: '1000.00',
    tax: '0.00',
    total: '1000.00',
    status: 'sent',
    sentAt: opts.sentAt,
    deliveryStatus: 'sent',
    deliveryUpdatedAt: opts.sentAt,
    deliveryMessageId: opts.messageId,
  });

  return { app, handle, accountId, companyId, contactId, invoiceId };
}

function readInvoice(invoiceId: string) {
  return getTestDb()
    .select({
      deliveryStatus: invoices.deliveryStatus,
      deliveryDetail: invoices.deliveryDetail,
      deliveryUpdatedAt: invoices.deliveryUpdatedAt,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1)
    .then((rows) => rows[0]);
}

// Re-stamps a captured payload onto a message id and a time this test controls.
function eventFor(name: string, messageId: string, occurredAt: string) {
  const payload = structuredClone(FIXTURES[name]) as unknown as {
    data: { email_id: string; created_at: string };
  };
  payload.data.email_id = messageId;
  payload.data.created_at = occurredAt;
  return payload;
}

describe('POST /api/webhooks/resend', () => {
  let ctx: { app: ReturnType<typeof createApp>; handle: ApiDatabase } | null = null;

  beforeEach(async () => {
    await resetDb();
    ctx = null;
  });

  describe('before it will touch anything', () => {
    it('refuses outright when no signing secret is configured', async () => {
      const built = buildApp({ secret: undefined });
      ctx = built;
      const res = await deliver(built.app, FIXTURES['email.delivered']);
      // 503, not 200-and-ignore. An install with no secret cannot tell a real
      // delivery report from a forged one, and answering 200 would claim it
      // had handled something it did not even read.
      expect(res.status).toBe(503);
      await built.handle.close();
      ctx = null;
    });

    it('rejects a payload signed with the wrong secret', async () => {
      const seeded = await seedSentInvoice({
        messageId: 'msg-1',
        sentAt: new Date('2026-06-01T10:00:00Z'),
      });
      ctx = seeded;
      const res = await deliver(
        seeded.app,
        eventFor('email.bounced', 'msg-1', '2026-06-01T10:00:30Z'),
        { secret: 'whsec_c29tZXRoaW5nIGVsc2U=' },
      );
      expect(res.status).toBe(400);
      // And crucially, wrote nothing. A forged bounce that still lands on the
      // row would be worse than no webhook at all.
      expect((await readInvoice(seeded.invoiceId))?.deliveryStatus).toBe('sent');
    });

    it('rejects an unsigned request', async () => {
      const seeded = await seedSentInvoice({
        messageId: 'msg-1',
        sentAt: new Date('2026-06-01T10:00:00Z'),
      });
      ctx = seeded;
      const res = await seeded.app.request('/api/webhooks/resend', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(FIXTURES['email.delivered']),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('applying what the provider says', () => {
    it('records a delivery against the invoice it belongs to', async () => {
      const seeded = await seedSentInvoice({
        messageId: 'msg-d',
        sentAt: new Date('2026-06-01T10:00:00Z'),
      });
      ctx = seeded;
      const res = await deliver(
        seeded.app,
        eventFor('email.delivered', 'msg-d', '2026-06-01T10:00:20Z'),
      );
      expect(res.status).toBe(200);
      const row = await readInvoice(seeded.invoiceId);
      expect(row?.deliveryStatus).toBe('delivered');
      // Stamped with the provider's clock, so subsequent events compare against
      // the same timeline.
      expect(row?.deliveryUpdatedAt?.toISOString()).toBe('2026-06-01T10:00:20.000Z');
    });

    it('records a permanent bounce, with the far end’s reason', async () => {
      const seeded = await seedSentInvoice({
        messageId: 'msg-b',
        sentAt: new Date('2026-06-01T10:00:00Z'),
      });
      ctx = seeded;
      await deliver(seeded.app, eventFor('email.bounced', 'msg-b', '2026-06-01T10:00:30Z'));
      const row = await readInvoice(seeded.invoiceId);
      expect(row?.deliveryStatus).toBe('bounced');
      expect(row?.deliveryDetail).toContain('user unknown');
    });

    it('leaves a soft bounce alone', async () => {
      const seeded = await seedSentInvoice({
        messageId: 'msg-s',
        sentAt: new Date('2026-06-01T10:00:00Z'),
      });
      ctx = seeded;
      const soft = eventFor('email.bounced', 'msg-s', '2026-06-01T10:00:30Z') as unknown as {
        data: { bounce: { type: string } };
      };
      soft.data.bounce.type = 'Transient';
      const res = await deliver(seeded.app, soft);
      expect(res.status).toBe(200);
      // Still 'sent'. A transient bounce is usually retried and delivered; a
      // red banner here sends the user to re-key an address that was correct.
      expect((await readInvoice(seeded.invoiceId))?.deliveryStatus).toBe('sent');
    });

    it('finds estimates too, not only invoices', async () => {
      const seeded = await seedSentInvoice({
        messageId: 'msg-inv',
        sentAt: new Date('2026-06-01T10:00:00Z'),
      });
      ctx = seeded;
      const estimateId = uuidv7();
      await getTestDb()
        .insert(estimates)
        .values({
          id: estimateId,
          accountId: seeded.accountId,
          companyId: seeded.companyId,
          contactId: seeded.contactId,
          number: `EST-${estimateId.slice(-12)}`,
          issueDate: '2026-06-01',
          subtotal: '500.00',
          tax: '0.00',
          total: '500.00',
          status: 'sent',
          deliveryStatus: 'sent',
          deliveryUpdatedAt: new Date('2026-06-01T10:00:00Z'),
          deliveryMessageId: 'msg-est',
        });

      await deliver(seeded.app, eventFor('email.bounced', 'msg-est', '2026-06-01T10:00:30Z'));
      const [row] = await getTestDb()
        .select({ deliveryStatus: estimates.deliveryStatus })
        .from(estimates)
        .where(eq(estimates.id, estimateId));
      expect(row?.deliveryStatus).toBe('bounced');
      // And did not touch the invoice that shares the account.
      expect((await readInvoice(seeded.invoiceId))?.deliveryStatus).toBe('sent');
    });

    it('acknowledges an event for a message that is not a document', async () => {
      const seeded = await seedSentInvoice({
        messageId: 'msg-x',
        sentAt: new Date('2026-06-01T10:00:00Z'),
      });
      ctx = seeded;
      // The account's verification mail, password resets and statements all
      // produce these. 200 so the provider stops retrying something that will
      // never match.
      const res = await deliver(
        seeded.app,
        eventFor('email.delivered', 'not-a-document', '2026-06-01T10:00:20Z'),
      );
      expect(res.status).toBe(200);
      expect((await readInvoice(seeded.invoiceId))?.deliveryStatus).toBe('sent');
    });
  });

  describe('when events arrive out of order', () => {
    it('does not let a late "sent" overwrite a delivery', async () => {
      // NOT hypothetical. While capturing the fixtures for this work, an
      // email.delivered arrived before the email.sent for the same message.
      // Without the ordering guard the late 'sent' wins and the invoice
      // reports less than we actually know.
      const seeded = await seedSentInvoice({
        messageId: 'msg-o',
        sentAt: new Date('2026-06-01T10:00:00Z'),
      });
      ctx = seeded;

      await deliver(seeded.app, eventFor('email.delivered', 'msg-o', '2026-06-01T10:00:20Z'));
      expect((await readInvoice(seeded.invoiceId))?.deliveryStatus).toBe('delivered');

      // The earlier event, delivered second.
      const res = await deliver(
        seeded.app,
        eventFor('email.sent', 'msg-o', '2026-06-01T10:00:05Z'),
      );
      expect(res.status).toBe(200);
      expect((await readInvoice(seeded.invoiceId))?.deliveryStatus).toBe('delivered');
    });

    it('does not let a stale bounce reopen a document sent again since', async () => {
      // A re-send overwrites delivery_message_id, but the provider may still be
      // retrying a webhook for the previous attempt. The timestamp is what
      // keeps yesterday's bounce off today's send.
      const seeded = await seedSentInvoice({
        messageId: 'msg-r',
        sentAt: new Date('2026-06-02T09:00:00Z'),
      });
      ctx = seeded;
      const res = await deliver(
        seeded.app,
        eventFor('email.bounced', 'msg-r', '2026-06-01T10:00:30Z'),
      );
      expect(res.status).toBe(200);
      expect((await readInvoice(seeded.invoiceId))?.deliveryStatus).toBe('sent');
    });

    it('still applies a bounce that arrives after the send it belongs to', async () => {
      // The control for the test above — without this, a guard that rejected
      // everything would look identical.
      const seeded = await seedSentInvoice({
        messageId: 'msg-r2',
        sentAt: new Date('2026-06-01T10:00:00Z'),
      });
      ctx = seeded;
      await deliver(seeded.app, eventFor('email.bounced', 'msg-r2', '2026-06-01T10:00:30Z'));
      expect((await readInvoice(seeded.invoiceId))?.deliveryStatus).toBe('bounced');
    });
  });

  afterEach(async () => {
    await ctx?.handle.close();
  });
});
