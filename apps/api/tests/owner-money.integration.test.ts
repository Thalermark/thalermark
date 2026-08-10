import {
  authUser,
  chartOfAccounts,
  companies,
  journalEntries,
  journalLines,
  memberships,
  ownerMoneyEvents,
} from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Owner money events — the owner putting their own money in / paying themselves.
// This is the only path that posts to Owner's Equity (3000) / Owner's Draw
// (3100). Asserts the full hidden-ledger chain: contribution → Dr Cash (1000) /
// Cr Owner's Equity (3000); draw → Dr Owner's Draw (3100) / Cr Cash (1000); edit
// → reversal + repost; delete (soft) → reversal. Plus the in/out flow on the
// dashboard (contributions read as "money in", draws as "money out") and tenant
// isolation. Pure posting-policy coverage lives in apps/api/src/lib/ledger.test.ts.

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

async function signUp(app: ReturnType<typeof createApp>, email: string) {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`);
  return extractSessionCookie(res);
}

async function userContext(email: string) {
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

const TODAY = new Date().toISOString().slice(0, 10);

async function createEvent(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request('/api/owner-money', {
    method: 'POST',
    headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify({ amount: '500.00', occurredOn: TODAY, ...body }),
  });
}

async function entriesFor(eventId: string) {
  const db = getTestDb();
  return db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.sourceEntityId, eventId))
    .orderBy(journalEntries.postedAt);
}

async function linesFor(entryId: string) {
  const db = getTestDb();
  return db
    .select({ side: journalLines.side, amount: journalLines.amount, code: chartOfAccounts.code })
    .from(journalLines)
    .leftJoin(chartOfAccounts, eq(journalLines.coaAccountId, chartOfAccounts.id))
    .where(eq(journalLines.journalEntryId, entryId));
}

// The position dashboard in/out flows, windowed tightly to the event date so the
// assertions don't depend on the calendar month.
async function dashboardFlow(
  app: ReturnType<typeof createApp>,
  cookie: string,
  accountId: string,
  companyId: string,
  on: string,
) {
  const res = await app.request(`/api/companies/${companyId}/dashboard?from=${on}&to=${on}`, {
    headers: { cookie, 'x-account-id': accountId },
  });
  return (await res.json()) as { moneyIn: string; moneyOut: string };
}

describe('owner money events — CRUD + ledger (equity/draw)', () => {
  beforeEach(resetDb);

  it("contribution posts Dr Cash / Cr Owner's Equity and reads as money in", async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'ome-contrib@example.com');
      const { accountId, companyId } = await userContext('ome-contrib@example.com');

      const res = await createEvent(ctx.app, cookie, accountId, {
        companyId,
        kind: 'contribution',
        amount: '1500.00',
      });
      expect(res.status).toBe(201);
      const row = (await res.json()) as { id: string; kind: string; amount: string };
      expect(row.kind).toBe('contribution');
      expect(row.amount).toBe('1500.00');

      const entries = await entriesFor(row.id);
      expect(entries).toHaveLength(1);
      const byCode = new Map((await linesFor(entries[0]?.id as string)).map((l) => [l.code, l]));
      expect(byCode.get('1000')).toMatchObject({ side: 'debit', amount: '1500.00' });
      expect(byCode.get('3000')).toMatchObject({ side: 'credit', amount: '1500.00' });

      const flow = await dashboardFlow(ctx.app, cookie, accountId, companyId, TODAY);
      expect(flow.moneyIn).toBe('1500.00');
      expect(flow.moneyOut).toBe('0.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it("draw posts Dr Owner's Draw / Cr Cash and reads as money out", async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'ome-draw@example.com');
      const { accountId, companyId } = await userContext('ome-draw@example.com');

      const res = await createEvent(ctx.app, cookie, accountId, {
        companyId,
        kind: 'draw',
        amount: '800.00',
      });
      expect(res.status).toBe(201);
      const row = (await res.json()) as { id: string };

      const entries = await entriesFor(row.id);
      expect(entries).toHaveLength(1);
      const byCode = new Map((await linesFor(entries[0]?.id as string)).map((l) => [l.code, l]));
      expect(byCode.get('3100')).toMatchObject({ side: 'debit', amount: '800.00' });
      expect(byCode.get('1000')).toMatchObject({ side: 'credit', amount: '800.00' });

      const flow = await dashboardFlow(ctx.app, cookie, accountId, companyId, TODAY);
      expect(flow.moneyOut).toBe('800.00');
      expect(flow.moneyIn).toBe('0.00');
    } finally {
      await ctx.handle.close();
    }
  });

  // Regression (migration 0018): a draw is a contra-EQUITY posting, so it must
  // REDUCE reported equity. 3100 was seeded normal_balance 'debit', which meant
  // the balance sheet netted a draw in its own direction and added it — equity
  // came out overstated by twice the withdrawal and `balanced` went false. The
  // sibling assertions above cover the postings themselves; this covers the
  // report that reads them, which is where the bug actually surfaced.
  it('a draw reduces equity and keeps the balance sheet balanced', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'ome-bs@example.com');
      const { accountId, companyId } = await userContext('ome-bs@example.com');

      await createEvent(ctx.app, cookie, accountId, {
        companyId,
        kind: 'contribution',
        amount: '2000.00',
      });
      await createEvent(ctx.app, cookie, accountId, {
        companyId,
        kind: 'draw',
        amount: '800.00',
      });

      const bs = (await (
        await ctx.app.request(`/api/companies/${companyId}/balance-sheet`, {
          headers: { cookie, 'x-account-id': accountId },
        })
      ).json()) as {
        equity: { code: string; amount: string }[];
        totalAssets: string;
        totalEquity: string;
        balanced: boolean;
      };

      // Cash 2000 in − 800 out, and equity has to agree with it.
      expect(bs.totalAssets).toBe('1200.00');
      expect(bs.totalEquity).toBe('1200.00');
      expect(bs.balanced).toBe(true);
      // The draw shows as a negative line inside equity — the same way
      // Accumulated Depreciation shows negative inside assets.
      const byCode = new Map(bs.equity.map((l) => [l.code, l.amount]));
      expect(byCode.get('3000')).toBe('2000.00');
      expect(byCode.get('3100')).toBe('-800.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('edit reverses the prior posting and reposts the new amount', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'ome-edit@example.com');
      const { accountId, companyId } = await userContext('ome-edit@example.com');

      const created = (await (
        await createEvent(ctx.app, cookie, accountId, {
          companyId,
          kind: 'contribution',
          amount: '100.00',
        })
      ).json()) as { id: string };

      const res = await ctx.app.request(`/api/owner-money/${created.id}`, {
        method: 'PATCH',
        headers: { cookie, 'x-account-id': accountId, 'content-type': 'application/json' },
        body: JSON.stringify({ amount: '250.00' }),
      });
      expect(res.status).toBe(200);

      // create + reversal + repost = 3 entries; the in flow nets per source to 250.
      expect(await entriesFor(created.id)).toHaveLength(3);
      const flow = await dashboardFlow(ctx.app, cookie, accountId, companyId, TODAY);
      expect(flow.moneyIn).toBe('250.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('delete is soft + reverses the posting; the event drops out of reads', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'ome-del@example.com');
      const { accountId, companyId } = await userContext('ome-del@example.com');

      const created = (await (
        await createEvent(ctx.app, cookie, accountId, {
          companyId,
          kind: 'contribution',
          amount: '400.00',
        })
      ).json()) as { id: string };

      const del = await ctx.app.request(`/api/owner-money/${created.id}`, {
        method: 'DELETE',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(del.status).toBe(200);

      // create + reversal = 2 entries; the in flow nets per source to zero.
      expect(await entriesFor(created.id)).toHaveLength(2);
      const flow = await dashboardFlow(ctx.app, cookie, accountId, companyId, TODAY);
      expect(flow.moneyIn).toBe('0.00');

      // The soft-deleted event is gone from get + list.
      const get = await ctx.app.request(`/api/owner-money/${created.id}`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(get.status).toBe(404);
      const list = await ctx.app.request(`/api/owner-money?companyId=${companyId}`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(((await list.json()) as { events: unknown[] }).events).toHaveLength(0);
    } finally {
      await ctx.handle.close();
    }
  });

  // TMC-240: the soft delete's other half. Without this the surviving row was
  // unreachable, which made the soft delete a permanent one that also used disk.
  it('restore puts the event and its posting back where they were', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'ome-restore@example.com');
      const { accountId, companyId } = await userContext('ome-restore@example.com');

      const created = (await (
        await createEvent(ctx.app, cookie, accountId, {
          companyId,
          kind: 'contribution',
          amount: '400.00',
        })
      ).json()) as { id: string };

      await ctx.app.request(`/api/owner-money/${created.id}`, {
        method: 'DELETE',
        headers: { cookie, 'x-account-id': accountId },
      });

      // The deleted row is reachable again only when asked for — this is the
      // list the restore button is rendered from.
      const deletedList = (await (
        await ctx.app.request(`/api/owner-money?companyId=${companyId}&includeDeleted=true`, {
          headers: { cookie, 'x-account-id': accountId },
        })
      ).json()) as { events: { id: string; deletedAt: string | null }[] };
      expect(deletedList.events).toHaveLength(1);
      expect(deletedList.events[0]?.deletedAt).not.toBeNull();

      const res = await ctx.app.request(`/api/owner-money/${created.id}/restore`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { deletedAt: string | null }).deletedAt).toBeNull();

      // create + reversal + repost = 3 entries, and the money is back where it
      // started — the ledger is append-only, so undo is another entry.
      expect(await entriesFor(created.id)).toHaveLength(3);
      const flow = await dashboardFlow(ctx.app, cookie, accountId, companyId, TODAY);
      expect(flow.moneyIn).toBe('400.00');

      // And it reads like an ordinary live event again.
      const get = await ctx.app.request(`/api/owner-money/${created.id}`, {
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(get.status).toBe(200);
      const list = (await (
        await ctx.app.request(`/api/owner-money?companyId=${companyId}`, {
          headers: { cookie, 'x-account-id': accountId },
        })
      ).json()) as { events: unknown[] };
      expect(list.events).toHaveLength(1);
    } finally {
      await ctx.handle.close();
    }
  });

  // Idempotence matters more here than for the items archive pair: a second
  // POST that posted again would double the contribution.
  it('restoring a live event posts nothing', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'ome-restore-live@example.com');
      const { accountId, companyId } = await userContext('ome-restore-live@example.com');

      const created = (await (
        await createEvent(ctx.app, cookie, accountId, {
          companyId,
          kind: 'contribution',
          amount: '400.00',
        })
      ).json()) as { id: string };

      const res = await ctx.app.request(`/api/owner-money/${created.id}/restore`, {
        method: 'POST',
        headers: { cookie, 'x-account-id': accountId },
      });
      expect(res.status).toBe(200);

      expect(await entriesFor(created.id)).toHaveLength(1);
      const flow = await dashboardFlow(ctx.app, cookie, accountId, companyId, TODAY);
      expect(flow.moneyIn).toBe('400.00');
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects an invalid kind', async () => {
    const ctx = buildApp();
    try {
      const cookie = await signUp(ctx.app, 'ome-badkind@example.com');
      const { accountId, companyId } = await userContext('ome-badkind@example.com');

      const res = await createEvent(ctx.app, cookie, accountId, {
        companyId,
        kind: 'withdrawal',
        amount: '10.00',
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    } finally {
      await ctx.handle.close();
    }
  });

  it("does not leak another account's owner money events", async () => {
    const ctx = buildApp();
    try {
      const cookieA = await signUp(ctx.app, 'ome-tenant-a@example.com');
      const a = await userContext('ome-tenant-a@example.com');
      const created = (await (
        await createEvent(ctx.app, cookieA, a.accountId, {
          companyId: a.companyId,
          kind: 'contribution',
          amount: '999.00',
        })
      ).json()) as { id: string };

      const cookieB = await signUp(ctx.app, 'ome-tenant-b@example.com');
      const b = await userContext('ome-tenant-b@example.com');

      const cross = await ctx.app.request(`/api/owner-money/${created.id}`, {
        headers: { cookie: cookieB, 'x-account-id': b.accountId },
      });
      expect(cross.status).toBe(404);

      const list = await ctx.app.request(`/api/owner-money?companyId=${b.companyId}`, {
        headers: { cookie: cookieB, 'x-account-id': b.accountId },
      });
      expect(((await list.json()) as { events: unknown[] }).events).toHaveLength(0);

      const db = getTestDb();
      const [row] = await db
        .select()
        .from(ownerMoneyEvents)
        .where(eq(ownerMoneyEvents.id, created.id));
      expect(row?.accountId).toBe(a.accountId);
    } finally {
      await ctx.handle.close();
    }
  });
});
