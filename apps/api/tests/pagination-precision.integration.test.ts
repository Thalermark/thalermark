import { authUser, memberships } from '@thalermark/db';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Keyset pagination across rows that share a created_at (TMC-193).
//
// THE BUG. `created_at` is timestamptz — microsecond precision. The cursor used
// to carry that value through a JS `Date`, which is millisecond precision, so
// for a row stored at `…:00.574485` the next-page predicate became
// `created_at < '…:00.574'`. Strictly greater, and not equal either: neither
// branch of the comparison matched, the page came back empty, and every row
// sharing that timestamp became permanently unreachable. Silent — no error, no
// log line, just missing data.
//
// WHY IT MATTERED IN PRODUCTION, not just in a contrived test: `defaultNow()`
// resolves to the TRANSACTION timestamp, so every row written in one statement
// or one transaction shares a created_at exactly. That is the CSV importer, the
// recurring-invoice sweep generating several invoices in a run, and entity
// handoff. A 500-row contact import was mostly invisible past page one.
//
// WHY IT SHIPPED: every existing pagination test inserted rows one at a time
// through the API, which gave each row its own transaction and its own
// timestamp — the exact condition under which the bug cannot appear. Bulk
// insertion is what makes it visible, which is why this file inserts in a
// single statement.

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

function extractSessionCookie(res: Response): string {
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

async function setup(email: string) {
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
  const signRes = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (signRes.status !== 200) throw new Error(`sign-up failed: ${signRes.status}`);
  const cookie = extractSessionCookie(signRes);

  const db = getTestDb();
  const [user] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email));
  if (!user) throw new Error('user not seeded');
  const [m] = await db
    .select({ accountId: memberships.accountId })
    .from(memberships)
    .where(eq(memberships.userId, user.id));
  if (!m) throw new Error('membership not seeded');
  const [company] = await db
    .execute<{ id: string }>(
      sql`select id from companies where account_id = ${m.accountId} limit 1`,
    )
    .then((r) => r.rows);
  if (!company) throw new Error('company not seeded');

  return {
    app,
    handle,
    accountId: m.accountId,
    companyId: company.id,
    headers: { cookie, 'x-account-id': m.accountId, 'content-type': 'application/json' },
  };
}

// Walks every page and returns what was actually reachable.
async function walk(
  ctx: Awaited<ReturnType<typeof setup>>,
  path: string,
  key: 'contacts' | 'invoices',
  limit: number,
): Promise<{ seen: Set<string>; returned: number; pages: number }> {
  const seen = new Set<string>();
  let returned = 0;
  let cursor: string | null = null;
  let pages = 0;
  while (pages < 100) {
    const url = cursor
      ? `${path}?limit=${limit}&cursor=${encodeURIComponent(cursor)}`
      : `${path}?limit=${limit}`;
    const res = await ctx.app.request(url, { headers: ctx.headers });
    if (res.status !== 200) throw new Error(`${url} -> ${res.status}`);
    const body = (await res.json()) as Record<string, unknown> & { nextCursor?: string | null };
    const rows = (body[key] ?? []) as { id: string }[];
    returned += rows.length;
    for (const r of rows) seen.add(r.id);
    pages++;
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  return { seen, returned, pages };
}

describe('keyset pagination across rows sharing a created_at', () => {
  beforeEach(resetDb);

  it('reaches every contact from a single bulk insert', async () => {
    const ctx = await setup('bulk-contacts@test.com');
    try {
      const db = getTestDb();
      // ONE statement — all 25 rows get the identical transaction timestamp,
      // at microsecond precision. This is the shape the CSV importer produces.
      await db.execute(sql`
        INSERT INTO contacts (id, account_id, company_id, name, created_at, updated_at)
        SELECT gen_random_uuid(), ${ctx.accountId}, ${ctx.companyId}, 'Bulk ' || g, now(), now()
        FROM generate_series(1, 25) g
      `);

      // Sanity: they really do share one timestamp, or the test proves nothing.
      const [row] = await db
        .execute<{ n: number }>(
          sql`select count(distinct created_at)::int as n from contacts where company_id = ${ctx.companyId}`,
        )
        .then((r) => r.rows);
      expect(Number(row?.n)).toBe(1);

      const { seen, returned, pages } = await walk(ctx, '/api/contacts', 'contacts', 5);
      expect(seen.size).toBe(25);
      // No row served twice, and it genuinely paged rather than returning all
      // 25 at once.
      expect(returned).toBe(25);
      expect(pages).toBeGreaterThan(3);
    } finally {
      await ctx.handle.close();
    }
  });

  it('reaches every invoice from a single bulk insert', async () => {
    const ctx = await setup('bulk-invoices@test.com');
    try {
      const db = getTestDb();
      await db.execute(sql`
        INSERT INTO contacts (id, account_id, company_id, name, created_at, updated_at)
        VALUES (gen_random_uuid(), ${ctx.accountId}, ${ctx.companyId}, 'Payer', now(), now())
      `);
      await db.execute(sql`
        INSERT INTO invoices (
          id, account_id, company_id, contact_id, number, status,
          issue_date, due_date, currency, subtotal, tax, total, created_at, updated_at
        )
        SELECT gen_random_uuid(), ${ctx.accountId}, ${ctx.companyId},
               (SELECT id FROM contacts WHERE company_id = ${ctx.companyId} LIMIT 1),
               'INV-' || g, 'draft', DATE '2026-03-01', DATE '2026-04-01',
               'USD', 10.00, 0.00, 10.00, now(), now()
        FROM generate_series(1, 20) g
      `);

      const { seen, returned } = await walk(ctx, '/api/invoices', 'invoices', 4);
      expect(seen.size).toBe(20);
      expect(returned).toBe(20);
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects a malformed cursor and does not leak another account position', async () => {
    const ctx = await setup('cursor-guard@test.com');
    try {
      const bad = Buffer.from(JSON.stringify(['not-a-uuid']), 'utf8').toString('base64url');
      const res = await ctx.app.request(`/api/contacts?cursor=${encodeURIComponent(bad)}`, {
        headers: ctx.headers,
      });
      expect(res.status).toBe(400);

      // A well-formed uuid that belongs to no visible row resolves to NULL in
      // the subquery, so the page is simply empty — never someone else's rows.
      const stranger = Buffer.from(
        JSON.stringify(['00000000-0000-7000-8000-00000000dead']),
        'utf8',
      ).toString('base64url');
      const res2 = await ctx.app.request(`/api/contacts?cursor=${encodeURIComponent(stranger)}`, {
        headers: ctx.headers,
      });
      expect(res2.status).toBe(200);
      expect(((await res2.json()) as { contacts: unknown[] }).contacts).toEqual([]);
    } finally {
      await ctx.handle.close();
    }
  });
});
