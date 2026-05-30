import {
  SYSTEM_USER_ID,
  accounts,
  auditEvents,
  authUser,
  companies,
  customers,
  invoices,
  journalEntries,
  journalLines,
  memberships,
  seedChartOfAccounts,
} from '@thalermark/db';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { createStripeBundle } from '../src/lib/stripe.js';
import { getTestDb, resetDb } from './test-helper.js';

const TEST_WEBHOOK_SECRET = 'whsec_test_secret_for_signature_helper';

// Stripe SDK is built with a real client (not a network mock) because we only
// use its sync signature helpers — generateTestHeaderString + constructEvent
// — which run entirely in-process. The fake secret key never hits stripe.com.
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
  stripeSecretKey: 'sk_test_fake_for_signature_only',
  stripePublishableKey: 'pk_test_fake',
  stripeWebhookSecret: TEST_WEBHOOK_SECRET,
};

function buildApp() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(url);
  const auth = createApiAuth(handle.db, { ...testEnv, databaseUrl: url });
  const stripe = createStripeBundle({
    secretKey: testEnv.stripeSecretKey,
    publishableKey: testEnv.stripePublishableKey,
    webhookSecret: testEnv.stripeWebhookSecret,
  });
  const app = createApp({
    auth,
    db: handle.db,
    publicAppUrl: testEnv.publicAppUrl,
    stripe,
  });
  return { app, handle, stripe };
}

// Direct DB seed bypassing the sign-up + invoice-create chain — the webhook
// handler runs on bootstrapDb (RLS-bypass) so seeding with the same handle
// matches its read path.
async function seedSentInvoice(): Promise<{
  invoiceId: string;
  accountId: string;
  companyId: string;
}> {
  const db = getTestDb();
  const userId = uuidv7();
  const accountId = uuidv7();
  const companyId = uuidv7();
  const customerId = uuidv7();
  const invoiceId = uuidv7();
  await db
    .insert(authUser)
    .values({ id: userId, email: `${userId}@test.com`, emailVerified: false, name: 'Test' });
  await db.insert(accounts).values({ id: accountId, name: 'Test Acc' });
  await db.insert(memberships).values({ id: uuidv7(), accountId, userId });
  await db.insert(companies).values({ id: companyId, accountId, name: 'Test Co' });
  await db.insert(customers).values({ id: customerId, accountId, companyId, name: 'Bob' });
  await db.insert(invoices).values({
    id: invoiceId,
    accountId,
    companyId,
    customerId,
    number: 'INV-1',
    status: 'sent',
    issueDate: '2026-05-25',
    dueDate: '2026-06-24',
    currency: 'USD',
    subtotal: '100.00',
    tax: '0.00',
    total: '100.00',
    publicToken: `tok_${invoiceId}`,
    sentAt: new Date(),
  });
  // L2: the webhook posts a journal entry on mark-paid, which requires
  // the company's COA to be seeded. Production seeds via the signup hook;
  // this test bypasses signup, so seed directly to match.
  await seedChartOfAccounts(db, { accountId, companyId });
  return { invoiceId, accountId, companyId };
}

function signEvent(stripeClient: Stripe, payload: string): string {
  return stripeClient.webhooks.generateTestHeaderString({
    payload,
    secret: TEST_WEBHOOK_SECRET,
  });
}

function checkoutCompletedPayload(invoiceId: string): string {
  return JSON.stringify({
    id: 'evt_test_completed',
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_session',
        object: 'checkout.session',
        payment_status: 'paid',
        client_reference_id: invoiceId,
      },
    },
  });
}

describe('Stripe webhook', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('rejects an invalid signature with 400', async () => {
    const { app, handle } = buildApp();
    try {
      const res = await app.request('/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': 'not-a-real-signature' },
        body: '{}',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_signature' });
    } finally {
      await handle.close();
    }
  });

  it('rejects a missing signature with 400', async () => {
    const { app, handle } = buildApp();
    try {
      const res = await app.request('/api/webhooks/stripe', {
        method: 'POST',
        body: '{}',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'missing_signature' });
    } finally {
      await handle.close();
    }
  });

  it('marks the invoice paid + writes an audit row on checkout.session.completed', async () => {
    const { invoiceId, companyId } = await seedSentInvoice();
    const { app, handle, stripe } = buildApp();
    if (!stripe) throw new Error('stripe bundle not configured');
    try {
      const payload = checkoutCompletedPayload(invoiceId);
      const sig = signEvent(stripe.client, payload);
      const res = await app.request('/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': sig },
        body: payload,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ received: true });

      const db = getTestDb();
      const [updated] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(updated?.status).toBe('paid');
      expect(updated?.paidAt).toBeInstanceOf(Date);

      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, invoiceId));
      const stripeAudit = audits.find((a) => a.action === 'stripe-paid');
      expect(stripeAudit).toBeDefined();
      expect(stripeAudit?.actorUserId).toBe(SYSTEM_USER_ID);
      expect(stripeAudit?.companyId).toBe(companyId);
      expect(stripeAudit?.before).toMatchObject({ status: 'sent' });
      expect(stripeAudit?.after).toMatchObject({ status: 'paid' });
    } finally {
      await handle.close();
    }
  });

  it('posts a balanced Dr Cash / Cr AR journal entry on mark-paid', async () => {
    const { invoiceId, accountId } = await seedSentInvoice();
    const { app, handle, stripe } = buildApp();
    if (!stripe) throw new Error('stripe bundle not configured');
    try {
      const payload = checkoutCompletedPayload(invoiceId);
      const sig = signEvent(stripe.client, payload);
      const res = await app.request('/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': sig },
        body: payload,
      });
      expect(res.status).toBe(200);

      const db = getTestDb();
      const entries = await db
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.sourceEntityId, invoiceId));
      expect(entries).toHaveLength(1);
      expect(entries[0]?.accountId).toBe(accountId);
      expect(entries[0]?.sourceEntityType).toBe('invoice');

      const lines = await db
        .select()
        .from(journalLines)
        .where(eq(journalLines.journalEntryId, entries[0]?.id as string));
      expect(lines).toHaveLength(2);
      const debit = lines.find((l) => l.side === 'debit');
      const credit = lines.find((l) => l.side === 'credit');
      expect(debit?.amount).toBe('100.00');
      expect(credit?.amount).toBe('100.00');
    } finally {
      await handle.close();
    }
  });

  it('is idempotent on re-delivery — second event no-ops with 200', async () => {
    const { invoiceId } = await seedSentInvoice();
    const { app, handle, stripe } = buildApp();
    if (!stripe) throw new Error('stripe bundle not configured');
    try {
      const payload = checkoutCompletedPayload(invoiceId);
      const sig = signEvent(stripe.client, payload);
      const first = await app.request('/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': sig },
        body: payload,
      });
      expect(first.status).toBe(200);
      const second = await app.request('/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': sig },
        body: payload,
      });
      expect(second.status).toBe(200);
      const db = getTestDb();
      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, invoiceId));
      expect(audits.filter((a) => a.action === 'stripe-paid')).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  it('acknowledges 200 on non-completion event types without writing', async () => {
    const { invoiceId } = await seedSentInvoice();
    const { app, handle, stripe } = buildApp();
    if (!stripe) throw new Error('stripe bundle not configured');
    try {
      const payload = JSON.stringify({
        id: 'evt_other',
        object: 'event',
        type: 'payment_intent.created',
        data: { object: { id: 'pi_x' } },
      });
      const sig = signEvent(stripe.client, payload);
      const res = await app.request('/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': sig },
        body: payload,
      });
      expect(res.status).toBe(200);

      const db = getTestDb();
      const [unchanged] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(unchanged?.status).toBe('sent');
    } finally {
      await handle.close();
    }
  });

  it('returns 503 when Stripe is not configured', async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not set');
    const handle = createApiDatabase(url);
    const auth = createApiAuth(handle.db, { ...testEnv, databaseUrl: url });
    const app = createApp({ auth, db: handle.db, publicAppUrl: testEnv.publicAppUrl });
    try {
      const res = await app.request('/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': 'whatever' },
        body: '{}',
      });
      expect(res.status).toBe(503);
    } finally {
      await handle.close();
    }
  });
});
