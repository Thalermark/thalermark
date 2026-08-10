import { authUser, chartOfAccounts, companies, memberships, searchDocuments } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { sweepSearchReindex } from '../src/lib/search/sweep.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// The search index is maintained by hanging off the audit writer (TMC-198), so
// what these tests really assert is that the *existing* mutation paths keep it
// true — including the handful that write no audit event and had to be patched
// by hand. A regression here is silent in production: nothing throws, search
// just quietly stops finding a thing that exists.
//
// Assertions read through getTestDb() (the superuser handle) on purpose, so a
// tenancy test can see BOTH accounts' rows and prove isolation by identity
// rather than by a count that would also pass if the row simply were not there.

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

type App = ReturnType<typeof createApp>;

type Ctx = {
  app: App;
  cookie: string;
  accountId: string;
  companyId: string;
};

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

async function signUp(app: App, email: string): Promise<string> {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return extractSessionCookie(res);
}

async function contextFor(email: string): Promise<{ accountId: string; companyId: string }> {
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

async function setup(app: App, email: string): Promise<Ctx> {
  const cookie = await signUp(app, email);
  const { accountId, companyId } = await contextFor(email);
  return { app, cookie, accountId, companyId };
}

function headers(ctx: Ctx) {
  return { cookie: ctx.cookie, 'x-account-id': ctx.accountId, 'content-type': 'application/json' };
}

async function coaId(companyId: string, code: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.companyId, companyId), eq(chartOfAccounts.code, code)));
  if (!row) throw new Error(`no COA ${code} for company ${companyId}`);
  return row.id;
}

// Reads the document for one entity, across every account, so tenancy tests can
// see what they must not be able to reach through the API.
async function doc(entityType: string, entityId: string) {
  const [row] = await getTestDb()
    .select()
    .from(searchDocuments)
    .where(and(eq(searchDocuments.entityType, entityType), eq(searchDocuments.entityId, entityId)));
  return row ?? null;
}

async function createContact(ctx: Ctx, name: string, extra: Record<string, unknown> = {}) {
  const res = await ctx.app.request('/api/contacts', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({ companyId: ctx.companyId, name, ...extra }),
  });
  if (res.status !== 201) throw new Error(`contact create failed: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function createInvoice(ctx: Ctx, contactId: string, number: string) {
  const res = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId,
      number,
      issueDate: '2026-07-01',
      dueDate: '2026-07-15',
      subtotal: '1200.00',
      tax: '0.00',
      total: '1200.00',
      lineItems: [
        {
          position: 1,
          description: 'Gutter cleaning and repair',
          quantity: '1',
          unitPrice: '1200.00',
          amount: '1200.00',
        },
      ],
    }),
  });
  if (res.status !== 201) throw new Error(`invoice create failed: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function createExpense(ctx: Ctx, merchant: string, extra: Record<string, unknown> = {}) {
  const res = await ctx.app.request('/api/expenses', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      categoryAccountId: await coaId(ctx.companyId, '6100'),
      paymentAccountId: await coaId(ctx.companyId, '1000'),
      amount: '132.10',
      expenseDate: '2026-07-02',
      merchant,
      ...extra,
    }),
  });
  if (res.status !== 201) throw new Error(`expense create failed: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function createItem(ctx: Ctx, name: string) {
  const res = await ctx.app.request('/api/items', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      name,
      type: 'service',
      unitPrice: '75.00',
    }),
  });
  if (res.status !== 201) throw new Error(`item create failed: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

describe('search index — projection', () => {
  beforeEach(resetDb);

  it('indexes a contact on create and follows a rename', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'proj-contact@test.dev');
      const id = await createContact(ctx, 'Johnson Roofing LLC', {
        email: 'jose@johnson.test',
        phone: '(555) 123-4567',
      });

      const created = await doc('contact', id);
      expect(created).not.toBeNull();
      expect(created?.title).toBe('Johnson Roofing LLC');
      expect(created?.titleNorm).toBe('johnson roofing llc');
      // Digits alongside the formatted number is what makes a bare 5551234567
      // find this contact.
      expect(created?.bodyNorm).toContain('5551234567');

      const res = await ctx.app.request(`/api/contacts/${id}`, {
        method: 'PATCH',
        headers: headers(ctx),
        body: JSON.stringify({ name: 'Peña Roofing LLC' }),
      });
      expect(res.status).toBe(200);

      const renamed = await doc('contact', id);
      expect(renamed?.title).toBe('Peña Roofing LLC');
      // Accent-folded, so searching "pena" finds it.
      expect(renamed?.titleNorm).toBe('pena roofing llc');
      expect(renamed?.titleNorm).not.toContain('johnson');
    } finally {
      await handle.close();
    }
  });

  it('indexes an invoice with its contact name and line-item text', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'proj-invoice@test.dev');
      const contactId = await createContact(ctx, 'Johnson Roofing LLC');
      const invoiceId = await createInvoice(ctx, contactId, 'INV-1042');

      const row = await doc('invoice', invoiceId);
      expect(row?.title).toBe('INV-1042');
      expect(row?.subtitle).toBe('Johnson Roofing LLC');
      // The line description is why "gutter" finds this invoice.
      expect(row?.bodyNorm).toContain('gutter cleaning and repair');
      // bigint cents, not a numeric string — int8eq is leakproof, which is what
      // keeps exact-amount matching indexable.
      expect(row?.amountCents).toBe(120000);
      expect(row?.status).toBe('draft');
      expect(row?.occurredOn).toBe('2026-07-01');
    } finally {
      await handle.close();
    }
  });

  it('follows a state change: mark-sent updates the indexed status', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'proj-sent@test.dev');
      const contactId = await createContact(ctx, 'Smith Landscaping');
      const invoiceId = await createInvoice(ctx, contactId, 'INV-2001');
      expect((await doc('invoice', invoiceId))?.status).toBe('draft');

      const res = await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: headers(ctx),
      });
      expect(res.status).toBe(200);
      expect((await doc('invoice', invoiceId))?.status).toBe('sent');
    } finally {
      await handle.close();
    }
  });

  it('keeps a voided invoice indexed — void is the only way out of a wrong one', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'proj-void@test.dev');
      const contactId = await createContact(ctx, 'Smith Landscaping');
      const invoiceId = await createInvoice(ctx, contactId, 'INV-2002');
      await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: headers(ctx),
      });

      const res = await ctx.app.request(`/api/invoices/${invoiceId}/void`, {
        method: 'POST',
        headers: headers(ctx),
      });
      expect(res.status).toBe(200);

      const row = await doc('invoice', invoiceId);
      expect(row).not.toBeNull();
      expect(row?.status).toBe('voided');
    } finally {
      await handle.close();
    }
  });

  it('drops a soft-deleted expense but keeps an archived item', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'proj-lifecycle@test.dev');

      const expenseId = await createExpense(ctx, 'Home Depot', { memo: 'gutter brackets' });
      expect((await doc('expense', expenseId))?.title).toBe('Home Depot');
      const del = await ctx.app.request(`/api/expenses/${expenseId}`, {
        method: 'DELETE',
        headers: headers(ctx),
      });
      expect(del.status).toBe(200);
      // Deletion is deletion.
      expect(await doc('expense', expenseId)).toBeNull();

      // …until it is undone (TMC-240). Restore writes an audit row like any
      // other mutation, so the projector runs again and finds a live expense —
      // the index needs no delete-aware special case of its own.
      const restored = await ctx.app.request(`/api/expenses/${expenseId}/restore`, {
        method: 'POST',
        headers: headers(ctx),
      });
      expect(restored.status).toBe(200);
      expect((await doc('expense', expenseId))?.title).toBe('Home Depot');

      const itemId = await createItem(ctx, 'Gutter cleaning');
      const arch = await ctx.app.request(`/api/items/${itemId}/archive`, {
        method: 'POST',
        headers: headers(ctx),
      });
      expect(arch.status).toBe(200);
      // Archiving is filing — "what did we used to charge for this" is a real
      // question, so the document stays and is marked instead.
      const archived = await doc('item', itemId);
      expect(archived).not.toBeNull();
      expect(archived?.status).toBe('archived');

      await ctx.app.request(`/api/items/${itemId}/restore`, {
        method: 'POST',
        headers: headers(ctx),
      });
      expect((await doc('item', itemId))?.status).toBeNull();
    } finally {
      await handle.close();
    }
  });
});

describe('search index — tenancy', () => {
  beforeEach(resetDb);

  it('keeps two accounts with identical text in separate documents', async () => {
    const { app, handle } = buildApp();
    try {
      const a = await setup(app, 'tenant-a@test.dev');
      const b = await setup(app, 'tenant-b@test.dev');

      const aId = await createContact(a, 'Johnson Roofing LLC');
      const bId = await createContact(b, 'Johnson Roofing LLC');

      const aDoc = await doc('contact', aId);
      const bDoc = await doc('contact', bId);

      // Asserted by identity, not by count: a count would also pass if the row
      // simply were not there.
      expect(aDoc?.accountId).toBe(a.accountId);
      expect(bDoc?.accountId).toBe(b.accountId);
      expect(a.accountId).not.toBe(b.accountId);
      expect(aDoc?.companyId).toBe(a.companyId);
      expect(bDoc?.companyId).toBe(b.companyId);
    } finally {
      await handle.close();
    }
  });
});

describe('search index — the paths that write no audit event', () => {
  beforeEach(resetDb);

  // syncInvoiceSettlement writes invoices.status and paidAt but audits nothing
  // itself. Every settlement path funnels through it, so the reindex lives
  // there rather than at the four call sites.
  it('recording a payment updates the indexed status', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'gap-payment@test.dev');
      const contactId = await createContact(ctx, 'Smith Landscaping');
      const invoiceId = await createInvoice(ctx, contactId, 'INV-3001');
      await ctx.app.request(`/api/invoices/${invoiceId}/mark-sent`, {
        method: 'POST',
        headers: headers(ctx),
      });

      const res = await ctx.app.request(`/api/invoices/${invoiceId}/payments`, {
        method: 'POST',
        headers: headers(ctx),
        body: JSON.stringify({ amount: '1200.00', receivedOn: '2026-07-10', method: 'check' }),
      });
      expect(res.status).toBe(201);
      expect((await doc('invoice', invoiceId))?.status).toBe('paid');
    } finally {
      await handle.close();
    }
  });

  // resolveVendorLink flips contacts.is_vendor while the only audit event
  // belongs to the expense. Defensive today (the contact document carries no
  // role flags) but it keeps the repair beside the mutation.
  it('linking a vendor to an expense leaves the contact document intact', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'gap-vendor@test.dev');
      const vendorId = await createContact(ctx, 'Ace Hardware');
      await createExpense(ctx, 'Ace Hardware', { vendorContactId: vendorId });

      const row = await doc('contact', vendorId);
      expect(row).not.toBeNull();
      expect(row?.title).toBe('Ace Hardware');
    } finally {
      await handle.close();
    }
  });

  // The allocations endpoint is deliberately unaudited and deliberately does
  // NOT reindex — it changes what an expense is attributed to, not what it is.
  // Pinned so the "no patch needed" decision is closed by evidence.
  it('setting allocations leaves the expense document untouched', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'gap-alloc@test.dev');
      const expenseId = await createExpense(ctx, 'Home Depot', { memo: 'brackets' });
      const before = await doc('expense', expenseId);

      const res = await ctx.app.request(`/api/expenses/${expenseId}/allocations`, {
        method: 'PUT',
        headers: headers(ctx),
        body: JSON.stringify({ allocations: [] }),
      });
      expect(res.status).toBe(200);

      const after = await doc('expense', expenseId);
      expect(after?.title).toBe(before?.title);
      expect(after?.bodyNorm).toBe(before?.bodyNorm);
      expect(after?.amountCents).toBe(before?.amountCents);
    } finally {
      await handle.close();
    }
  });

  // A 3-row CSV import emits three per-row audit events, which the session
  // dedupes into one projector call and one 3-row upsert.
  it('a CSV import indexes every imported row', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'gap-import@test.dev');
      const res = await ctx.app.request('/api/contacts/import', {
        method: 'POST',
        headers: headers(ctx),
        body: JSON.stringify({
          companyId: ctx.companyId,
          rows: [{ name: 'Alpha Paving' }, { name: 'Beta Fencing' }, { name: 'Gamma Decking' }],
        }),
      });
      expect(res.status).toBe(201);

      const rows = await getTestDb()
        .select()
        .from(searchDocuments)
        .where(
          and(
            eq(searchDocuments.accountId, ctx.accountId),
            eq(searchDocuments.entityType, 'contact'),
          ),
        );
      expect(rows.map((r) => r.title).sort()).toEqual([
        'Alpha Paving',
        'Beta Fencing',
        'Gamma Decking',
      ]);
    } finally {
      await handle.close();
    }
  });
});

// The sweep is the safety net under the audit-seam convention. If a mutation
// path is ever added that forgets to reindex, these behaviours are what turn a
// permanent invisible bug into a bounded staleness window — so they are worth
// testing directly rather than trusting.
describe('search index — the reindex sweep', () => {
  beforeEach(resetDb);

  it('rebuilds a document that was deleted out from under it', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'sweep-heal@test.dev');
      const id = await createContact(ctx, 'Johnson Roofing LLC');

      // Simulates the mutation path that forgot to reindex.
      await getTestDb().delete(searchDocuments).where(eq(searchDocuments.entityId, id));
      expect(await doc('contact', id)).toBeNull();

      const result = await sweepSearchReindex({
        bootstrapDb: getTestDb(),
        tenantDb: handle.db,
        accountId: ctx.accountId,
      });

      expect(result.failed).toBe(0);
      const healed = await doc('contact', id);
      expect(healed?.title).toBe('Johnson Roofing LLC');
    } finally {
      await handle.close();
    }
  });

  it('reaps a document whose entity no longer exists', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'sweep-reap@test.dev');
      const realId = await createContact(ctx, 'Real Contact');

      // A document for an entity that was never there — what a missed delete
      // leaves behind.
      const orphanId = '00000000-0000-7000-8000-00000000dead';
      await getTestDb()
        .insert(searchDocuments)
        .values({
          entityType: 'contact',
          entityId: orphanId,
          accountId: ctx.accountId,
          companyId: ctx.companyId,
          title: 'Ghost Contact',
          titleNorm: 'ghost contact',
          entityUpdatedAt: new Date(),
          // Backdated so it is unambiguously older than the run start, which is
          // exactly the condition the reap keys on.
          indexedAt: new Date(Date.now() - 60_000),
        });
      expect(await doc('contact', orphanId)).not.toBeNull();

      const result = await sweepSearchReindex({
        bootstrapDb: getTestDb(),
        tenantDb: handle.db,
        accountId: ctx.accountId,
      });

      expect(result.reaped).toBe(1);
      expect(await doc('contact', orphanId)).toBeNull();
      // and it did not take the live document with it
      expect(await doc('contact', realId)).not.toBeNull();
    } finally {
      await handle.close();
    }
  });

  it('is idempotent — a second run changes nothing', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'sweep-idempotent@test.dev');
      const contactId = await createContact(ctx, 'Johnson Roofing LLC');
      await createInvoice(ctx, contactId, 'INV-9001');

      const first = await sweepSearchReindex({
        bootstrapDb: getTestDb(),
        tenantDb: handle.db,
        accountId: ctx.accountId,
      });
      const second = await sweepSearchReindex({
        bootstrapDb: getTestDb(),
        tenantDb: handle.db,
        accountId: ctx.accountId,
      });

      // Nothing reaped on either pass: every document was re-stamped by the
      // same run that would have reaped it.
      expect(first.reaped).toBe(0);
      expect(second.reaped).toBe(0);
      expect(second.documents).toBe(first.documents);
      expect(second.failed).toBe(0);

      const rows = await getTestDb()
        .select()
        .from(searchDocuments)
        .where(eq(searchDocuments.accountId, ctx.accountId));
      expect(rows).toHaveLength(2);
    } finally {
      await handle.close();
    }
  });
});
