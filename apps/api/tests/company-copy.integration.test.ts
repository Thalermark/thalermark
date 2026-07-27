import {
  authUser,
  companies,
  contacts,
  emailTemplates,
  items,
  memberships,
  recurringInvoiceLineItems,
  recurringInvoices,
  taxPolicies,
} from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Copying one company's setup into another — the reference data a business
// carries with it, without any of its history.
//
// The invariant that matters most is the last test: NOTHING in the copy may
// reference a row belonging to the source company. Every foreign key has to be
// remapped, and the remap order is forced (tax policies → items → contacts →
// recurring). A missed one is silent: the row inserts fine, the DB accepts it
// because the FK targets the table not the company, and the two companies are
// quietly entangled forever.

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

function buildApp() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
  });
  return { app, handle };
}

type App = ReturnType<typeof createApp>;

async function signUp(app: App, email: string): Promise<string> {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`);
  return extractSessionCookie(res);
}

async function ownerContext(email: string) {
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
  if (!company) throw new Error(`company for ${email} not seeded`);
  return { accountId: m.accountId, companyId: company.id };
}

type Ctx = { app: App; cookie: string; accountId: string; sourceId: string; targetId: string };

function req(ctx: Ctx, path: string, init?: RequestInit) {
  const headers: Record<string, string> = { cookie: ctx.cookie, 'x-account-id': ctx.accountId };
  if (init?.body) headers['content-type'] = 'application/json';
  return ctx.app.request(path, { ...init, headers: { ...headers, ...init?.headers } });
}

// A source company with every copyable entity populated, and the FKs between
// them wired up — an item pointing at a tax policy, a recurring schedule
// pointing at a contact with lines pointing at both.
async function seedSource(ctx: Ctx) {
  const policy = (await (
    await req(ctx, '/api/tax-policies', {
      method: 'POST',
      body: JSON.stringify({
        companyId: ctx.sourceId,
        name: 'City tax',
        ratePct: '8.2500',
        isDefault: true,
      }),
    })
  ).json()) as { id: string };

  const item = (await (
    await req(ctx, '/api/items', {
      method: 'POST',
      body: JSON.stringify({
        companyId: ctx.sourceId,
        name: 'Mowing',
        type: 'service',
        unitPrice: '75.00',
        taxable: true,
        taxPolicyId: policy.id,
      }),
    })
  ).json()) as { id: string };

  const customer = (await (
    await req(ctx, '/api/contacts', {
      method: 'POST',
      body: JSON.stringify({ companyId: ctx.sourceId, name: 'Acme', email: 'acme@example.com' }),
    })
  ).json()) as { id: string };

  // A vendor too — the CSV importer can't express isVendor, so a copy that
  // leaned on it would silently demote this contact to a customer.
  await req(ctx, '/api/contacts', {
    method: 'POST',
    body: JSON.stringify({
      companyId: ctx.sourceId,
      name: 'Fuel Depot',
      isCustomer: false,
      isVendor: true,
    }),
  });

  const schedule = await req(ctx, '/api/recurring-invoices', {
    method: 'POST',
    body: JSON.stringify({
      companyId: ctx.sourceId,
      contactId: customer.id,
      frequency: 'monthly',
      intervalCount: 1,
      startDate: '2026-01-01',
      subtotal: '75.00',
      tax: '6.19',
      total: '81.19',
      lineItems: [
        {
          position: 1,
          description: 'Mowing',
          quantity: '1',
          unitPrice: '75.00',
          amount: '75.00',
          taxable: true,
          taxRatePct: '8.2500',
          taxAmount: '6.19',
          taxPolicyId: policy.id,
          sourceItemId: item.id,
        },
      ],
    }),
  });
  if (schedule.status !== 201) throw new Error(`recurring create failed: ${schedule.status}`);

  await req(ctx, `/api/companies/${ctx.sourceId}/email-templates/invoice`, {
    method: 'PUT',
    body: JSON.stringify({ subject: 'Your invoice', body: 'Hello {{customer_name}}, thanks.' }),
  });

  await req(ctx, `/api/companies/${ctx.sourceId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      businessAddress: '1 Elm St',
      businessPhone: '555-0100',
      timezone: 'America/Chicago',
    }),
  });

  return { policyId: policy.id, itemId: item.id, customerId: customer.id };
}

async function setup(email: string): Promise<{ ctx: Ctx; close: () => Promise<void> }> {
  const { app, handle } = buildApp();
  const cookie = await signUp(app, email);
  const { accountId, companyId } = await ownerContext(email);
  const base: Ctx = { app, cookie, accountId, sourceId: companyId, targetId: '' };
  const created = (await (
    await req(base, '/api/companies', {
      method: 'POST',
      body: JSON.stringify({ name: 'Newco Inc', businessType: 's_corp' }),
    })
  ).json()) as { id: string };
  return { ctx: { ...base, targetId: created.id }, close: () => handle.close() };
}

const copy = (ctx: Ctx, include?: Record<string, boolean>) =>
  req(ctx, `/api/companies/${ctx.targetId}/copy-from`, {
    method: 'POST',
    body: JSON.stringify({ sourceCompanyId: ctx.sourceId, ...(include ? { include } : {}) }),
  });

describe('copying a company setup', () => {
  beforeEach(resetDb);

  it('copies every entity and carries the profile across', async () => {
    const { ctx, close } = await setup('cc-all@example.com');
    try {
      await seedSource(ctx);
      const res = await copy(ctx);
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        taxPolicies: 1,
        items: 1,
        contacts: 2,
        recurringInvoices: 1,
        emailTemplates: 1,
        profile: true,
      });

      const listed = (await (await req(ctx, '/api/companies')).json()) as {
        companies: { id: string; businessAddress: string | null; timezone: string }[];
      };
      const target = listed.companies.find((c) => c.id === ctx.targetId);
      expect(target?.businessAddress).toBe('1 Elm St');
      expect(target?.timezone).toBe('America/Chicago');
    } finally {
      await close();
    }
  });

  it('preserves the vendor flag, which the CSV importer cannot', async () => {
    const { ctx, close } = await setup('cc-vendor@example.com');
    try {
      await seedSource(ctx);
      await copy(ctx);

      const copied = await getTestDb()
        .select({
          name: contacts.name,
          isCustomer: contacts.isCustomer,
          isVendor: contacts.isVendor,
        })
        .from(contacts)
        .where(eq(contacts.companyId, ctx.targetId));
      const vendor = copied.find((c) => c.name === 'Fuel Depot');
      expect(vendor).toMatchObject({ isCustomer: false, isVendor: true });
    } finally {
      await close();
    }
  });

  it('lands recurring schedules paused so nothing emails a customer', async () => {
    const { ctx, close } = await setup('cc-paused@example.com');
    try {
      await seedSource(ctx);
      await copy(ctx);

      const [copied] = await getTestDb()
        .select({
          status: recurringInvoices.status,
          occurrenceCount: recurringInvoices.occurrenceCount,
        })
        .from(recurringInvoices)
        .where(eq(recurringInvoices.companyId, ctx.targetId));
      // A copy landing 'active' would have the next sweep send real invoices
      // from a company nobody has finished setting up.
      expect(copied?.status).toBe('paused');
      expect(Number(copied?.occurrenceCount)).toBe(0);
    } finally {
      await close();
    }
  });

  it('refuses a target that already has reference data', async () => {
    const { ctx, close } = await setup('cc-occupied@example.com');
    try {
      await seedSource(ctx);
      await req(ctx, '/api/contacts', {
        method: 'POST',
        body: JSON.stringify({ companyId: ctx.targetId, name: 'Already here' }),
      });

      const res = await copy(ctx);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('target_not_empty');
    } finally {
      await close();
    }
  });

  it('honours the include flags', async () => {
    const { ctx, close } = await setup('cc-partial@example.com');
    try {
      await seedSource(ctx);
      const res = await copy(ctx, {
        taxPolicies: false,
        items: false,
        recurringInvoices: false,
        emailTemplates: false,
        profile: false,
        contacts: true,
      });
      expect(await res.json()).toMatchObject({
        taxPolicies: 0,
        items: 0,
        contacts: 2,
        recurringInvoices: 0,
        emailTemplates: 0,
        profile: false,
      });
    } finally {
      await close();
    }
  });

  // THE test. Every FK in the copy must point inside the target company.
  it('leaves no foreign key pointing at the source company', async () => {
    const { ctx, close } = await setup('cc-fk@example.com');
    try {
      const source = await seedSource(ctx);
      await copy(ctx);
      const db = getTestDb();

      // items.tax_policy_id must resolve to a policy in the TARGET company.
      const [copiedItem] = await db
        .select({ taxPolicyId: items.taxPolicyId })
        .from(items)
        .where(eq(items.companyId, ctx.targetId));
      expect(copiedItem?.taxPolicyId).not.toBe(source.policyId);
      const [policyOwner] = await db
        .select({ companyId: taxPolicies.companyId })
        .from(taxPolicies)
        .where(eq(taxPolicies.id, copiedItem?.taxPolicyId as string));
      expect(policyOwner?.companyId).toBe(ctx.targetId);

      // recurring.contact_id likewise.
      const [copiedSchedule] = await db
        .select({ id: recurringInvoices.id, contactId: recurringInvoices.contactId })
        .from(recurringInvoices)
        .where(eq(recurringInvoices.companyId, ctx.targetId));
      expect(copiedSchedule?.contactId).not.toBe(source.customerId);
      const [contactOwner] = await db
        .select({ companyId: contacts.companyId })
        .from(contacts)
        .where(eq(contacts.id, copiedSchedule?.contactId as string));
      expect(contactOwner?.companyId).toBe(ctx.targetId);

      // ...and both FKs on the schedule's lines, which are the easiest to miss.
      const [copiedLine] = await db
        .select({
          taxPolicyId: recurringInvoiceLineItems.taxPolicyId,
          sourceItemId: recurringInvoiceLineItems.sourceItemId,
        })
        .from(recurringInvoiceLineItems)
        .where(eq(recurringInvoiceLineItems.recurringInvoiceId, copiedSchedule?.id as string));
      expect(copiedLine?.taxPolicyId).not.toBe(source.policyId);
      expect(copiedLine?.sourceItemId).not.toBe(source.itemId);
      const [lineItemOwner] = await db
        .select({ companyId: items.companyId })
        .from(items)
        .where(eq(items.id, copiedLine?.sourceItemId as string));
      expect(lineItemOwner?.companyId).toBe(ctx.targetId);

      // Email templates carry no cross-company FK, but assert the row landed on
      // the target rather than being shared.
      const templates = await db
        .select({ companyId: emailTemplates.companyId })
        .from(emailTemplates)
        .where(eq(emailTemplates.companyId, ctx.targetId));
      expect(templates).toHaveLength(1);

      // And the source is untouched — a copy is not a move.
      const sourceContacts = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.companyId, ctx.sourceId)));
      expect(sourceContacts).toHaveLength(2);
    } finally {
      await close();
    }
  });
});
