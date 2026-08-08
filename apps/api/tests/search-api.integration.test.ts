import { authUser, companies, memberships } from '@thalermark/db';
import type { SearchResponse } from '@thalermark/validation';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// GET /api/search end-to-end, through RLS (the suite runs as thalermark_app).
//
// The read goes through search_documents_match(), a SECURITY DEFINER function
// that is exempt from the tenant policy — so "does account A ever see account
// B's row" is not a formality here, it is the one test that would catch a real
// leak. It asserts on entity ids rather than counts, because a count assertion
// also passes when the row simply is not there.

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

type App = ReturnType<typeof createApp>;
type Ctx = { app: App; cookie: string; accountId: string; companyId: string };

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

async function setup(app: App, email: string): Promise<Ctx> {
  const signup = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (signup.status !== 200) throw new Error(`sign-up failed: ${await signup.text()}`);
  const cookie = extractSessionCookie(signup);
  const db = getTestDb();
  const [user] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email));
  if (!user) throw new Error('user missing');
  const [m] = await db
    .select({ accountId: memberships.accountId })
    .from(memberships)
    .where(eq(memberships.userId, user.id));
  if (!m) throw new Error('membership missing');
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.accountId, m.accountId));
  if (!company) throw new Error('company missing');
  return { app, cookie, accountId: m.accountId, companyId: company.id };
}

function headers(ctx: Ctx) {
  return { cookie: ctx.cookie, 'x-account-id': ctx.accountId, 'content-type': 'application/json' };
}

async function search(ctx: Ctx, query: string): Promise<SearchResponse> {
  const res = await ctx.app.request(`/api/search?${query}`, { headers: headers(ctx) });
  if (res.status !== 200) throw new Error(`search failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as SearchResponse;
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

async function createInvoice(ctx: Ctx, contactId: string, number: string, total = '1200.00') {
  const res = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId,
      number,
      issueDate: '2026-07-01',
      dueDate: '2026-07-15',
      subtotal: total,
      tax: '0.00',
      total,
      lineItems: [
        {
          position: 1,
          description: 'Gutter cleaning and repair',
          quantity: '1',
          unitPrice: total,
          amount: total,
        },
      ],
    }),
  });
  if (res.status !== 201) throw new Error(`invoice create failed: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

describe('GET /api/search — finding things', () => {
  beforeEach(resetDb);

  it('finds a contact by prefix and an invoice by its customer name', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'find@test.dev');
      const contactId = await createContact(ctx, 'Johnson Roofing LLC');
      const invoiceId = await createInvoice(ctx, contactId, 'INV-1042');

      const body = await search(ctx, 'q=johns&limit=50');
      const ids = body.results.map((r) => r.entityId);
      expect(ids).toContain(contactId);
      expect(ids).toContain(invoiceId);
    } finally {
      await handle.close();
    }
  });

  it('finds an invoice by line-item text', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'find-line@test.dev');
      const contactId = await createContact(ctx, 'Smith Landscaping');
      const invoiceId = await createInvoice(ctx, contactId, 'INV-2001');

      const body = await search(ctx, 'q=gutter&limit=50');
      expect(body.results.map((r) => r.entityId)).toContain(invoiceId);
    } finally {
      await handle.close();
    }
  });

  it('finds an invoice by exact amount, below the text floor', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'find-amount@test.dev');
      const contactId = await createContact(ctx, 'Smith Landscaping');
      const invoiceId = await createInvoice(ctx, contactId, 'INV-2002', '1200.00');

      for (const q of ['1200', '$1,200.00']) {
        const body = await search(ctx, `q=${encodeURIComponent(q)}&limit=50`);
        expect(body.results.map((r) => r.entityId)).toContain(invoiceId);
      }
      // Money crosses the wire as a decimal string, never a float.
      const body = await search(ctx, 'q=1200&limit=50');
      const hit = body.results.find((r) => r.entityId === invoiceId);
      expect(hit?.amount).toBe('1200.00');
    } finally {
      await handle.close();
    }
  });

  it('tolerates a typo via the trigram pass', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'find-typo@test.dev');
      const contactId = await createContact(ctx, 'Johnson Roofing');

      const body = await search(ctx, 'q=jonson%20roofing&limit=50');
      expect(body.results.map((r) => r.entityId)).toContain(contactId);
    } finally {
      await handle.close();
    }
  });

  it('finds an accented name without the accent', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'find-accent@test.dev');
      const contactId = await createContact(ctx, 'Peña Roofing');

      const body = await search(ctx, 'q=pena&limit=50');
      expect(body.results.map((r) => r.entityId)).toContain(contactId);
    } finally {
      await handle.close();
    }
  });
});

describe('GET /api/search — tenancy', () => {
  beforeEach(resetDb);

  it('never returns another account, even through the SECURITY DEFINER path', async () => {
    const { app, handle } = buildApp();
    try {
      const a = await setup(app, 'search-a@test.dev');
      const b = await setup(app, 'search-b@test.dev');

      const aContact = await createContact(a, 'Johnson Roofing LLC');
      const bContact = await createContact(b, 'Johnson Roofing LLC');

      const aBody = await search(a, 'q=johnson&limit=50');
      const aIds = aBody.results.map((r) => r.entityId);
      expect(aIds).toContain(aContact);
      expect(aIds).not.toContain(bContact);
      expect(aBody.results.every((r) => r.companyId === a.companyId)).toBe(true);

      const bBody = await search(b, 'q=johnson&limit=50');
      const bIds = bBody.results.map((r) => r.entityId);
      expect(bIds).toContain(bContact);
      expect(bIds).not.toContain(aContact);
    } finally {
      await handle.close();
    }
  });

  it('narrows to one company when companyId is passed', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'search-company@test.dev');
      await createContact(ctx, 'Johnson Roofing LLC');

      const scoped = await search(ctx, `q=johnson&companyId=${ctx.companyId}&limit=50`);
      expect(scoped.results.length).toBeGreaterThan(0);
      expect(scoped.results.every((r) => r.companyId === ctx.companyId)).toBe(true);

      // A company in the same account that owns nothing matching returns none.
      const other = '00000000-0000-7000-8000-0000000000ff';
      const empty = await search(ctx, `q=johnson&companyId=${other}&limit=50`);
      expect(empty.results).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });
});

describe('GET /api/search — request handling', () => {
  beforeEach(resetDb);

  it('returns 200 with no results below the text floor, not a 400', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'search-short@test.dev');
      await createContact(ctx, 'Johnson Roofing LLC');

      // The client debounces; it should not have to special-case the boundary
      // between "keep typing" and "nothing matched".
      for (const q of ['', 'j', 'jo']) {
        const res = await ctx.app.request(`/api/search?q=${q}`, { headers: headers(ctx) });
        expect(res.status).toBe(200);
        expect(((await res.json()) as SearchResponse).results).toHaveLength(0);
      }
    } finally {
      await handle.close();
    }
  });

  it('caps each entity type in grouped mode', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'search-group@test.dev');
      const contactId = await createContact(ctx, 'Johnson Roofing LLC');
      for (const n of ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5']) {
        await createInvoice(ctx, contactId, `${n}-johnson`);
      }

      const body = await search(ctx, 'q=johnson&group=1&limit=20');
      const invoices = body.results.filter((r) => r.entityType === 'invoice');
      expect(invoices.length).toBeLessThanOrEqual(3);
      // and the contact still gets a slot rather than being crowded out
      expect(body.results.map((r) => r.entityId)).toContain(contactId);
      expect(body.hasMore).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('filters by entity type', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'search-types@test.dev');
      const contactId = await createContact(ctx, 'Johnson Roofing LLC');
      await createInvoice(ctx, contactId, 'INV-johnson');

      const body = await search(ctx, 'q=johnson&types=contact&limit=50');
      expect(body.results.every((r) => r.entityType === 'contact')).toBe(true);
      expect(body.results.map((r) => r.entityId)).toContain(contactId);
    } finally {
      await handle.close();
    }
  });

  it('pages with offset', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'search-page@test.dev');
      const contactId = await createContact(ctx, 'Johnson Roofing LLC');
      for (const n of ['1', '2', '3', '4', '5']) {
        await createInvoice(ctx, contactId, `INV-${n}-johnson`);
      }

      const first = await search(ctx, 'q=johnson&limit=2');
      const second = await search(ctx, 'q=johnson&limit=2&offset=2');
      expect(first.results).toHaveLength(2);
      expect(second.results).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      // Disjoint pages — the ORDER BY is a total order, so paging is stable.
      const firstIds = first.results.map((r) => r.entityId);
      expect(second.results.every((r) => !firstIds.includes(r.entityId))).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('rejects malformed input', async () => {
    const { app, handle } = buildApp();
    try {
      const ctx = await setup(app, 'search-bad@test.dev');
      const cases = [
        ['q=johnson&limit=0', 'invalid_limit'],
        ['q=johnson&limit=abc', 'invalid_limit'],
        ['q=johnson&offset=-1', 'invalid_offset'],
        ['q=johnson&types=wombat', 'invalid_types'],
        [`q=${'x'.repeat(201)}`, 'invalid_query'],
      ] as const;
      for (const [query, error] of cases) {
        const res = await ctx.app.request(`/api/search?${query}`, { headers: headers(ctx) });
        expect(res.status, query).toBe(400);
        expect((await res.json()) as { error: string }).toMatchObject({ error });
      }
    } finally {
      await handle.close();
    }
  });
});
