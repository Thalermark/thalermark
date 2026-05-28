import {
  SYSTEM_USER_ID,
  accounts,
  auditEvents,
  authUser,
  companies,
  customers,
  invoices,
  memberships,
} from '@thalermark/db';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import type { StripeBundle } from '../src/lib/stripe.js';
import { createStripeBundle } from '../src/lib/stripe.js';
import { getTestDb, resetDb } from './test-helper.js';

const TEST_WEBHOOK_SECRET = 'whsec_test_secret_for_signature_helper';

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

async function userContext(email: string): Promise<{ accountId: string; companyId: string }> {
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
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.accountId, m.accountId));
  if (!company) throw new Error(`default company for ${email} not seeded`);
  return { accountId: m.accountId, companyId: company.id };
}

// Network calls on accounts.create / accountLinks.create are stubbed — we
// only ever hit stripe.com from the real onboarding browser flow, not from
// tests. The webhook tests below use the real client because they rely on
// the sync signature helpers (generateTestHeaderString + constructEvent).
type ConnectStubs = {
  createAccount?: ReturnType<typeof vi.fn>;
  createAccountLink?: ReturnType<typeof vi.fn>;
  createCheckoutSession?: ReturnType<typeof vi.fn>;
};

function makeStubStripe(stubs: ConnectStubs = {}): StripeBundle {
  const createAccount = stubs.createAccount ?? vi.fn(async () => ({ id: 'acct_new' }));
  const createAccountLink =
    stubs.createAccountLink ??
    vi.fn(async () => ({ url: 'https://connect.stripe.com/setup/s/test' }));
  const createCheckoutSession =
    stubs.createCheckoutSession ??
    vi.fn(async () => ({ client_secret: 'cs_secret_test', id: 'cs_test' }));
  const client = {
    accounts: { create: createAccount },
    accountLinks: { create: createAccountLink },
    checkout: { sessions: { create: createCheckoutSession } },
  } as unknown as Stripe;
  return {
    client,
    publishableKey: 'pk_test_stub',
    webhookSecret: 'whsec_test_stub',
  };
}

function buildApp(stripe: StripeBundle | null | undefined) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(url);
  const auth = createApiAuth(handle.db, { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    publicAppUrl: testEnv.publicAppUrl,
    stripe,
  });
  return { app, handle };
}

function buildAppWithRealStripe() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(url);
  const auth = createApiAuth(handle.db, { ...testEnv, databaseUrl: url });
  const stripe = createStripeBundle({
    secretKey: testEnv.stripeSecretKey,
    publishableKey: testEnv.stripePublishableKey,
    webhookSecret: testEnv.stripeWebhookSecret,
  });
  if (!stripe) throw new Error('stripe bundle not configured for real-stripe test');
  const app = createApp({
    auth,
    db: handle.db,
    publicAppUrl: testEnv.publicAppUrl,
    stripe,
  });
  return { app, handle, stripe };
}

function accountUpdatedPayload(
  accountId: string,
  chargesEnabled: boolean,
  detailsSubmitted: boolean,
): string {
  return JSON.stringify({
    id: `evt_${accountId}`,
    object: 'event',
    type: 'account.updated',
    account: accountId,
    data: {
      object: {
        id: accountId,
        object: 'account',
        charges_enabled: chargesEnabled,
        details_submitted: detailsSubmitted,
      },
    },
  });
}

describe('POST /api/companies/:id/stripe-connect/onboard', () => {
  beforeEach(resetDb);

  it('creates a Stripe account on first call, persists the id, writes audit, returns URL', async () => {
    const createAccount = vi.fn(async () => ({ id: 'acct_alpha' }));
    const createAccountLink = vi.fn(async () => ({ url: 'https://stripe.test/onboard/alpha' }));
    const stripe = makeStubStripe({ createAccount, createAccountLink });
    const { app, handle } = buildApp(stripe);
    try {
      const cookie = await signUp(app, 'alice@connect.test');
      const { accountId, companyId } = await userContext('alice@connect.test');

      const res = await app.request(`/api/companies/${companyId}/stripe-connect/onboard`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string; accountId: string };
      expect(body.url).toBe('https://stripe.test/onboard/alpha');
      expect(body.accountId).toBe('acct_alpha');

      expect(createAccount).toHaveBeenCalledTimes(1);
      const [params, opts] = createAccount.mock.calls[0] as unknown as [
        Stripe.AccountCreateParams,
        { idempotencyKey?: string },
      ];
      expect(params.type).toBe('express');
      expect(params.country).toBe('US');
      expect(opts.idempotencyKey).toBe(`company-${companyId}-create-account`);

      const db = getTestDb();
      const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(row?.stripeConnectAccountId).toBe('acct_alpha');

      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, companyId));
      const created = audits.find((a) => a.action === 'stripe-connect-create');
      expect(created).toBeDefined();
      expect(created?.after).toMatchObject({ stripeConnectAccountId: 'acct_alpha' });
    } finally {
      await handle.close();
    }
  });

  it('reuses the stored account id on subsequent calls (no second Stripe account)', async () => {
    const createAccount = vi.fn(async () => ({ id: 'acct_beta' }));
    const createAccountLink = vi.fn(async () => ({ url: 'https://stripe.test/onboard/beta' }));
    const stripe = makeStubStripe({ createAccount, createAccountLink });
    const { app, handle } = buildApp(stripe);
    try {
      const cookie = await signUp(app, 'bob@connect.test');
      const { accountId, companyId } = await userContext('bob@connect.test');

      const first = await app.request(`/api/companies/${companyId}/stripe-connect/onboard`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      });
      expect(first.status).toBe(200);

      const second = await app.request(`/api/companies/${companyId}/stripe-connect/onboard`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      });
      expect(second.status).toBe(200);

      expect(createAccount).toHaveBeenCalledTimes(1);
      expect(createAccountLink).toHaveBeenCalledTimes(2);

      const db = getTestDb();
      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, companyId));
      expect(audits.filter((a) => a.action === 'stripe-connect-create')).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  it('returns 503 when Stripe is not configured', async () => {
    const { app, handle } = buildApp(null);
    try {
      const cookie = await signUp(app, 'carol@connect.test');
      const { accountId, companyId } = await userContext('carol@connect.test');
      const res = await app.request(`/api/companies/${companyId}/stripe-connect/onboard`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'stripe_not_configured' });
    } finally {
      await handle.close();
    }
  });

  it('returns 404 for a company in another tenant', async () => {
    const stripe = makeStubStripe();
    const { app, handle } = buildApp(stripe);
    try {
      const cookie = await signUp(app, 'dave@connect.test');
      const { accountId } = await userContext('dave@connect.test');
      // Forge an unrelated company directly in DB.
      const otherAccountId = uuidv7();
      const otherCompanyId = uuidv7();
      const db = getTestDb();
      await db.insert(accounts).values({ id: otherAccountId, name: 'Other' });
      await db
        .insert(companies)
        .values({ id: otherCompanyId, accountId: otherAccountId, name: 'Other Co' });

      const res = await app.request(`/api/companies/${otherCompanyId}/stripe-connect/onboard`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
      });
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
});

describe('GET /api/companies/:id/stripe-connect/status', () => {
  beforeEach(resetDb);

  it('returns disabled defaults for a company that has never onboarded', async () => {
    const stripe = makeStubStripe();
    const { app, handle } = buildApp(stripe);
    try {
      const cookie = await signUp(app, 'eve@connect.test');
      const { accountId, companyId } = await userContext('eve@connect.test');
      const res = await app.request(`/api/companies/${companyId}/stripe-connect/status`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        stripeConfigured: true,
        stripeConnectAccountId: null,
        stripeConnectChargesEnabled: false,
        stripeConnectDetailsSubmitted: false,
      });
    } finally {
      await handle.close();
    }
  });

  it('reports stripeConfigured=false when no bundle is wired in', async () => {
    const { app, handle } = buildApp(null);
    try {
      const cookie = await signUp(app, 'frank@connect.test');
      const { accountId, companyId } = await userContext('frank@connect.test');
      const res = await app.request(`/api/companies/${companyId}/stripe-connect/status`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ stripeConfigured: false });
    } finally {
      await handle.close();
    }
  });
});

describe('Stripe webhook — account.updated', () => {
  beforeEach(resetDb);

  it('flips charges_enabled + details_submitted on the matched company and writes audit', async () => {
    const { app, handle, stripe } = buildAppWithRealStripe();
    try {
      // Seed a company with an existing connect account id so the webhook
      // can resolve it. Direct DB seed — RLS-bypass mirrors the webhook
      // handler's bootstrapDb path.
      const db = getTestDb();
      const userId = uuidv7();
      const accountId = uuidv7();
      const companyId = uuidv7();
      await db
        .insert(authUser)
        .values({ id: userId, email: `${userId}@test.com`, emailVerified: false, name: 'Test' });
      await db.insert(accounts).values({ id: accountId, name: 'Acc' });
      await db.insert(memberships).values({ id: uuidv7(), accountId, userId });
      await db
        .insert(companies)
        .values({ id: companyId, accountId, name: 'Co', stripeConnectAccountId: 'acct_live' });

      const payload = accountUpdatedPayload('acct_live', true, true);
      const sig = stripe.client.webhooks.generateTestHeaderString({
        payload,
        secret: TEST_WEBHOOK_SECRET,
      });

      const res = await app.request('/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': sig },
        body: payload,
      });
      expect(res.status).toBe(200);

      const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(row?.stripeConnectChargesEnabled).toBe(true);
      expect(row?.stripeConnectDetailsSubmitted).toBe(true);

      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, companyId));
      const update = audits.find((a) => a.action === 'stripe-connect-update');
      expect(update).toBeDefined();
      expect(update?.actorUserId).toBe(SYSTEM_USER_ID);
      expect(update?.before).toMatchObject({
        stripeConnectChargesEnabled: false,
        stripeConnectDetailsSubmitted: false,
      });
      expect(update?.after).toMatchObject({
        stripeConnectChargesEnabled: true,
        stripeConnectDetailsSubmitted: true,
      });
    } finally {
      await handle.close();
    }
  });

  it('is idempotent — re-delivery with matching state writes no audit row', async () => {
    const { app, handle, stripe } = buildAppWithRealStripe();
    try {
      const db = getTestDb();
      const userId = uuidv7();
      const accountId = uuidv7();
      const companyId = uuidv7();
      await db
        .insert(authUser)
        .values({ id: userId, email: `${userId}@test.com`, emailVerified: false, name: 'Test' });
      await db.insert(accounts).values({ id: accountId, name: 'Acc' });
      await db.insert(memberships).values({ id: uuidv7(), accountId, userId });
      await db.insert(companies).values({
        id: companyId,
        accountId,
        name: 'Co',
        stripeConnectAccountId: 'acct_idem',
        stripeConnectChargesEnabled: true,
        stripeConnectDetailsSubmitted: true,
      });

      const payload = accountUpdatedPayload('acct_idem', true, true);
      const sig = stripe.client.webhooks.generateTestHeaderString({
        payload,
        secret: TEST_WEBHOOK_SECRET,
      });

      const res = await app.request('/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': sig },
        body: payload,
      });
      expect(res.status).toBe(200);

      const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, companyId));
      expect(audits.filter((a) => a.action === 'stripe-connect-update')).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });

  it('200s + no-ops when the account id is unknown to us', async () => {
    const { app, handle, stripe } = buildAppWithRealStripe();
    try {
      const payload = accountUpdatedPayload('acct_orphan', true, true);
      const sig = stripe.client.webhooks.generateTestHeaderString({
        payload,
        secret: TEST_WEBHOOK_SECRET,
      });
      const res = await app.request('/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': sig },
        body: payload,
      });
      expect(res.status).toBe(200);
    } finally {
      await handle.close();
    }
  });
});

// Direct DB seed for the public checkout-session route. The route is unauth'd
// and reads via bootstrapDb, so we mirror the seed shape from
// stripe-webhook.integration.test.ts. `connect` configures the company's Stripe
// Connect state — null = self-host (no stripeAccount header), populated = SaaS
// (stripeAccount required, gated on chargesEnabled).
async function seedPayableInvoice(connect: {
  accountId: string | null;
  chargesEnabled: boolean;
}): Promise<{ publicToken: string; invoiceId: string; companyId: string }> {
  const db = getTestDb();
  const userId = uuidv7();
  const acctId = uuidv7();
  const companyId = uuidv7();
  const customerId = uuidv7();
  const invoiceId = uuidv7();
  const publicToken = `tok_${invoiceId}`;
  await db
    .insert(authUser)
    .values({ id: userId, email: `${userId}@test.com`, emailVerified: false, name: 'T' });
  await db.insert(accounts).values({ id: acctId, name: 'Acc' });
  await db.insert(memberships).values({ id: uuidv7(), accountId: acctId, userId });
  await db.insert(companies).values({
    id: companyId,
    accountId: acctId,
    name: 'Co',
    stripeConnectAccountId: connect.accountId,
    stripeConnectChargesEnabled: connect.chargesEnabled,
    stripeConnectDetailsSubmitted: connect.chargesEnabled,
  });
  await db.insert(customers).values({ id: customerId, accountId: acctId, companyId, name: 'Bob' });
  await db.insert(invoices).values({
    id: invoiceId,
    accountId: acctId,
    companyId,
    customerId,
    number: 'INV-1',
    status: 'sent',
    issueDate: '2026-05-28',
    dueDate: '2026-06-27',
    currency: 'USD',
    subtotal: '100.00',
    tax: '0.00',
    total: '100.00',
    publicToken,
    sentAt: new Date(),
  });
  return { publicToken, invoiceId, companyId };
}

describe('POST /api/public/invoices/:token/checkout-session — slice 8.5e', () => {
  beforeEach(resetDb);

  it('threads stripeAccount when the company has onboarded Connect', async () => {
    const createCheckoutSession = vi.fn(async () => ({
      client_secret: 'cs_secret_connect',
      id: 'cs_connect',
    }));
    const stripe = makeStubStripe({ createCheckoutSession });
    const { app, handle } = buildApp(stripe);
    try {
      const { publicToken } = await seedPayableInvoice({
        accountId: 'acct_live_5e',
        chargesEnabled: true,
      });
      const res = await app.request(`/api/public/invoices/${publicToken}/checkout-session`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { clientSecret: string };
      expect(body.clientSecret).toBe('cs_secret_connect');

      expect(createCheckoutSession).toHaveBeenCalledTimes(1);
      const [, opts] = createCheckoutSession.mock.calls[0] as unknown as [
        unknown,
        { stripeAccount?: string },
      ];
      expect(opts.stripeAccount).toBe('acct_live_5e');
    } finally {
      await handle.close();
    }
  });

  it('returns 503 connect_not_ready when the company has onboarded but Stripe has not enabled charges', async () => {
    const createCheckoutSession = vi.fn();
    const stripe = makeStubStripe({ createCheckoutSession });
    const { app, handle } = buildApp(stripe);
    try {
      const { publicToken } = await seedPayableInvoice({
        accountId: 'acct_pending_5e',
        chargesEnabled: false,
      });
      const res = await app.request(`/api/public/invoices/${publicToken}/checkout-session`, {
        method: 'POST',
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'connect_not_ready' });
      expect(createCheckoutSession).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('does not pass stripeAccount on the self-host path (no connectAccountId)', async () => {
    const createCheckoutSession = vi.fn(async () => ({
      client_secret: 'cs_secret_selfhost',
      id: 'cs_selfhost',
    }));
    const stripe = makeStubStripe({ createCheckoutSession });
    const { app, handle } = buildApp(stripe);
    try {
      const { publicToken } = await seedPayableInvoice({
        accountId: null,
        chargesEnabled: false,
      });
      const res = await app.request(`/api/public/invoices/${publicToken}/checkout-session`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      // Two-arg call with second undefined preserves Stripe SDK default
      // routing to the platform account — exactly the 8.5c behavior.
      expect(createCheckoutSession).toHaveBeenCalledTimes(1);
      const [, opts] = createCheckoutSession.mock.calls[0] as unknown as [unknown, unknown];
      expect(opts).toBeUndefined();
    } finally {
      await handle.close();
    }
  });
});

describe('GET /api/public/invoices/:token — payable gate on Connect (slice 8.5e)', () => {
  beforeEach(resetDb);

  it('reports payable=false and connectPending=true when Connect is mid-onboarding', async () => {
    const stripe = makeStubStripe();
    const { app, handle } = buildApp(stripe);
    try {
      const { publicToken } = await seedPayableInvoice({
        accountId: 'acct_payable_gate',
        chargesEnabled: false,
      });
      const res = await app.request(`/api/public/invoices/${publicToken}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { payable: boolean; connectPending: boolean };
      expect(body.payable).toBe(false);
      expect(body.connectPending).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('reports payable=true and connectPending=false when Connect is enabled', async () => {
    const stripe = makeStubStripe();
    const { app, handle } = buildApp(stripe);
    try {
      const { publicToken } = await seedPayableInvoice({
        accountId: 'acct_ready_gate',
        chargesEnabled: true,
      });
      const res = await app.request(`/api/public/invoices/${publicToken}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { payable: boolean; connectPending: boolean };
      expect(body.payable).toBe(true);
      expect(body.connectPending).toBe(false);
    } finally {
      await handle.close();
    }
  });
});

describe('Stripe webhook — checkout.session.completed from a connected account (slice 8.5e)', () => {
  beforeEach(resetDb);

  it('marks the invoice paid even when the event carries account=acct_<connected>', async () => {
    const { app, handle, stripe } = buildAppWithRealStripe();
    try {
      // Seed the invoice with Connect onboarded + enabled, mirroring the
      // shape a connected-account session completion would resolve against.
      const { invoiceId } = await seedPayableInvoice({
        accountId: 'acct_connected_paid',
        chargesEnabled: true,
      });

      // Stripe Connect events carry `account: 'acct_<connected>'` at the
      // top level. The handler resolves the invoice purely by
      // client_reference_id, so this field shouldn't matter — but a
      // regression test pins that property in.
      const payload = JSON.stringify({
        id: 'evt_connected',
        object: 'event',
        type: 'checkout.session.completed',
        account: 'acct_connected_paid',
        data: {
          object: {
            id: 'cs_connected_session',
            object: 'checkout.session',
            payment_status: 'paid',
            client_reference_id: invoiceId,
          },
        },
      });
      const sig = stripe.client.webhooks.generateTestHeaderString({
        payload,
        secret: TEST_WEBHOOK_SECRET,
      });

      const res = await app.request('/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': sig },
        body: payload,
      });
      expect(res.status).toBe(200);

      const db = getTestDb();
      const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(row?.status).toBe('paid');
      expect(row?.paidAt).toBeInstanceOf(Date);
    } finally {
      await handle.close();
    }
  });
});
