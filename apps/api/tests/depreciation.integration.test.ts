import {
  authUser,
  capitalPurchases,
  chartOfAccounts,
  companies,
  journalEntries,
  journalLines,
  memberships,
} from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { sweepDepreciation } from '../src/lib/depreciation.js';
import type { Mailer } from '../src/lib/mailer.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Yearly depreciation for "spread it out" purchases (TMC-123).
//
// The bug this closes: picking "spread it out" produced a schedule that nothing
// ever posted, so Schedule C line 13 read $0 for those users every year while
// §179 users were fine. So the load-bearing assertions here are (a) line 13 is
// no longer zero, (b) re-running posts nothing, and (c) a purchase logged years
// late catches up.

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
  const mailer: Mailer = { async send() {} };
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
    mailer,
    emailFrom: testEnv.emailFrom,
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

function send(
  app: App,
  method: string,
  path: string,
  cookie: string,
  accountId: string,
  body?: unknown,
) {
  const headers: Record<string, string> = { cookie, 'x-account-id': accountId };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}
const get = (app: App, path: string, cookie: string, accountId: string) =>
  send(app, 'GET', path, cookie, accountId);

async function tenantBalanced(accountId: string): Promise<boolean> {
  const lines = await getTestDb()
    .select({ side: journalLines.side, amount: journalLines.amount })
    .from(journalLines)
    .where(eq(journalLines.accountId, accountId));
  const debit = lines.filter((l) => l.side === 'debit').reduce((s, l) => s + Number(l.amount), 0);
  const credit = lines.filter((l) => l.side === 'credit').reduce((s, l) => s + Number(l.amount), 0);
  return Math.abs(debit - credit) < 0.005;
}

// Schedule C line 13 ("Depreciation and section 179 expense") for a tax year —
// the number this whole ticket exists to stop being wrong.
async function line13(
  app: App,
  companyId: string,
  cookie: string,
  accountId: string,
  year: number,
  basis?: 'cash' | 'accrual',
): Promise<string> {
  const q = `year=${year}${basis ? `&basis=${basis}` : ''}`;
  const res = await get(app, `/api/companies/${companyId}/schedule-c?${q}`, cookie, accountId);
  const body = (await res.json()) as { partII: { line: string; amount: string }[] };
  return body.partII.find((r) => r.line === '13')?.amount ?? 'missing';
}

// Create a "spread it out" purchase directly, so a test can date it in the past
// without the create endpoint's own date handling being part of the assertion.
async function seedSpreadPurchase(
  app: App,
  cookie: string,
  accountId: string,
  companyId: string,
  opts: {
    purchaseDate: string;
    amount: string;
    usefulLifeYears?: number;
    priorAccumulatedDepreciation?: string;
    depreciationStartYear?: number;
  },
): Promise<string> {
  const res = await send(app, 'POST', '/api/purchases', cookie, accountId, {
    companyId,
    description: 'Mower',
    amount: opts.amount,
    purchaseDate: opts.purchaseDate,
    funding: 'paid_in_full',
    taxTreatment: 'spread',
    ...(opts.usefulLifeYears ? { usefulLifeYears: opts.usefulLifeYears } : {}),
    ...(opts.priorAccumulatedDepreciation
      ? { priorAccumulatedDepreciation: opts.priorAccumulatedDepreciation }
      : {}),
    ...(opts.depreciationStartYear ? { depreciationStartYear: opts.depreciationStartYear } : {}),
  });
  if (res.status !== 201) throw new Error(`purchase create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

const sweep = (now: Date) =>
  sweepDepreciation({ bootstrapDb: getTestDb(), tenantDb: getTestDb(), now });

describe('depreciation auto-posting', () => {
  beforeEach(resetDb);

  it('posts closed years only, halving the purchase year, and lands on Schedule C line 13', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'dep-basic@example.com');
      const { accountId, companyId } = await ownerContext('dep-basic@example.com');
      await seedSpreadPurchase(app, cookie, accountId, companyId, {
        purchaseDate: '2026-06-15',
        amount: '3600.00',
      });

      // Before the sweep, the bug: a shipped tax worksheet reading zero.
      expect(await line13(app, companyId, cookie, accountId, 2026)).toBe('0.00');

      // Mid-2027: 2026 has closed, 2027 has not.
      const result = await sweep(new Date('2027-06-01T12:00:00Z'));
      expect(result.entriesPosted).toBe(1);
      expect(await line13(app, companyId, cookie, accountId, 2026)).toBe('360.00');
      expect(await line13(app, companyId, cookie, accountId, 2027)).toBe('0.00');
      expect(await tenantBalanced(accountId)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('is idempotent — a second sweep on the same day posts nothing', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'dep-idem@example.com');
      const { accountId, companyId } = await ownerContext('dep-idem@example.com');
      await seedSpreadPurchase(app, cookie, accountId, companyId, {
        purchaseDate: '2026-06-15',
        amount: '3600.00',
      });

      const first = await sweep(new Date('2028-06-01T12:00:00Z'));
      expect(first.entriesPosted).toBe(2); // 2026 half + 2027 full
      const second = await sweep(new Date('2028-06-01T12:00:00Z'));
      expect(second.entriesPosted).toBe(0);

      // The double-post this guards against would show as an inflated line 13,
      // which in an append-only ledger can only be undone by another entry.
      expect(await line13(app, companyId, cookie, accountId, 2027)).toBe('720.00');
    } finally {
      await handle.close();
    }
  });

  it('backfills every missed year for a purchase logged years late', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'dep-backfill@example.com');
      const { accountId, companyId } = await ownerContext('dep-backfill@example.com');
      await seedSpreadPurchase(app, cookie, accountId, companyId, {
        purchaseDate: '2023-03-01',
        amount: '3600.00',
      });

      // One pass in 2027 has to catch up 2023–2026, not just the latest year.
      const result = await sweep(new Date('2027-02-01T12:00:00Z'));
      expect(result.entriesPosted).toBe(4);
      expect(await line13(app, companyId, cookie, accountId, 2023)).toBe('360.00');
      expect(await line13(app, companyId, cookie, accountId, 2024)).toBe('720.00');
      expect(await line13(app, companyId, cookie, accountId, 2026)).toBe('720.00');
    } finally {
      await handle.close();
    }
  });

  it('writes the asset off to exactly its cost and then stops', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'dep-total@example.com');
      const { accountId, companyId } = await ownerContext('dep-total@example.com');
      const id = await seedSpreadPurchase(app, cookie, accountId, companyId, {
        // 1000/3 doesn't divide evenly — the rounding has to land somewhere.
        purchaseDate: '2020-05-01',
        amount: '1000.00',
        usefulLifeYears: 3,
      });

      await sweep(new Date('2030-01-01T12:00:00Z'));
      const detail = (await (await get(app, `/api/purchases/${id}`, cookie, accountId)).json()) as {
        schedule: { postedToDate: string; total: string };
      };
      expect(detail.schedule.postedToDate).toBe('1000.00');
      expect(detail.schedule.total).toBe('1000.00');

      // Past the end of its life, further sweeps add nothing.
      const after = await sweep(new Date('2031-01-01T12:00:00Z'));
      expect(after.entriesPosted).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it('honours the accountant override: a full chunk in the purchase year', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'dep-override@example.com');
      const { accountId, companyId } = await ownerContext('dep-override@example.com');
      const patch = await send(app, 'PATCH', `/api/companies/${companyId}`, cookie, accountId, {
        depreciationConvention: 'full_year',
      });
      expect(patch.status).toBe(200);

      await seedSpreadPurchase(app, cookie, accountId, companyId, {
        purchaseDate: '2026-06-15',
        amount: '3600.00',
      });
      await sweep(new Date('2027-06-01T12:00:00Z'));
      expect(await line13(app, companyId, cookie, accountId, 2026)).toBe('720.00');
    } finally {
      await handle.close();
    }
  });

  it('shows up on line 13 on cash basis too — depreciation is basis-independent', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'dep-basis@example.com');
      const { accountId, companyId } = await ownerContext('dep-basis@example.com');
      await seedSpreadPurchase(app, cookie, accountId, companyId, {
        purchaseDate: '2026-06-15',
        amount: '3600.00',
      });
      await sweep(new Date('2027-06-01T12:00:00Z'));

      // A cash filer takes depreciation exactly as an accrual filer does — the
      // accounting-method toggle must not gate it away.
      expect(await line13(app, companyId, cookie, accountId, 2026, 'cash')).toBe('360.00');
      expect(await line13(app, companyId, cookie, accountId, 2026, 'accrual')).toBe('360.00');
    } finally {
      await handle.close();
    }
  });

  it('skips §179 purchases — their write-off already posted at purchase', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'dep-179@example.com');
      const { accountId, companyId } = await ownerContext('dep-179@example.com');
      const res = await send(app, 'POST', '/api/purchases', cookie, accountId, {
        companyId,
        description: 'Mower',
        amount: '3600.00',
        purchaseDate: '2026-04-01',
        funding: 'paid_in_full',
        taxTreatment: 'deduct_now',
      });
      expect(res.status).toBe(201);

      const result = await sweep(new Date('2028-06-01T12:00:00Z'));
      expect(result.candidates).toBe(0);
      // Still the single full write-off from purchase time, not a penny more.
      expect(await line13(app, companyId, cookie, accountId, 2026)).toBe('3600.00');
      expect(await line13(app, companyId, cookie, accountId, 2027)).toBe('0.00');
    } finally {
      await handle.close();
    }
  });

  it('reverses posted depreciation when the purchase is deleted, in its own tax year', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'dep-delete@example.com');
      const { accountId, companyId } = await ownerContext('dep-delete@example.com');
      const id = await seedSpreadPurchase(app, cookie, accountId, companyId, {
        purchaseDate: '2026-06-15',
        amount: '3600.00',
      });
      await sweep(new Date('2028-06-01T12:00:00Z'));
      expect(await line13(app, companyId, cookie, accountId, 2026)).toBe('360.00');

      const del = await send(app, 'DELETE', `/api/purchases/${id}`, cookie, accountId);
      expect(del.status).toBe(200);

      // Reversed in the year it was posted, not today: deleting an old purchase
      // must not shunt a deduction onto the current year.
      expect(await line13(app, companyId, cookie, accountId, 2026)).toBe('0.00');
      expect(await line13(app, companyId, cookie, accountId, 2027)).toBe('0.00');
      expect(await tenantBalanced(accountId)).toBe(true);

      // And a later sweep doesn't resurrect it — the row is soft-deleted, so it
      // isn't a candidate at all.
      const after = await sweep(new Date('2029-01-01T12:00:00Z'));
      expect(after.candidates).toBe(0);
      expect(await line13(app, companyId, cookie, accountId, 2026)).toBe('0.00');
    } finally {
      await handle.close();
    }
  });

  // TMC-240. The delete reverses each closed year in its own tax year; restore
  // has to put every one of them back, or a restored purchase silently loses
  // years of write-offs that the user never chose to give up.
  //
  // Dated relative to the real current year because the restore route reads the
  // real clock (unlike sweep(), which takes an injected `now`) — a hard-coded
  // year would stop testing anything once it passed.
  it('restore puts back every year of depreciation the delete reversed', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'dep-restore@example.com');
      const { accountId, companyId } = await ownerContext('dep-restore@example.com');
      const thisYear = new Date().getUTCFullYear();
      const firstYear = thisYear - 3;
      const id = await seedSpreadPurchase(app, cookie, accountId, companyId, {
        purchaseDate: `${firstYear}-06-15`,
        amount: '3600.00',
      });

      // Half-year convention: half a chunk in the purchase year, full ones after.
      await sweep(new Date());
      expect(await line13(app, companyId, cookie, accountId, firstYear)).toBe('360.00');
      expect(await line13(app, companyId, cookie, accountId, firstYear + 1)).toBe('720.00');

      expect((await send(app, 'DELETE', `/api/purchases/${id}`, cookie, accountId)).status).toBe(
        200,
      );
      expect(await line13(app, companyId, cookie, accountId, firstYear)).toBe('0.00');
      expect(await line13(app, companyId, cookie, accountId, firstYear + 1)).toBe('0.00');

      const res = await send(app, 'POST', `/api/purchases/${id}/restore`, cookie, accountId);
      expect(res.status).toBe(200);

      // Every closed year is back on the same tax year it was filed against —
      // not bunched onto today, which is what dating the repost to the purchase
      // would otherwise risk.
      expect(await line13(app, companyId, cookie, accountId, firstYear)).toBe('360.00');
      expect(await line13(app, companyId, cookie, accountId, firstYear + 1)).toBe('720.00');
      expect(await line13(app, companyId, cookie, accountId, firstYear + 2)).toBe('720.00');
      expect(await tenantBalanced(accountId)).toBe(true);

      // The next sweep finds nothing owing — restore already caught it up, and
      // the reversed-year check nets to zero rather than double-posting.
      const after = await sweep(new Date());
      expect(after.entriesPosted).toBe(0);
      expect(await line13(app, companyId, cookie, accountId, firstYear)).toBe('360.00');
    } finally {
      await handle.close();
    }
  });

  it('does not post a year the company has not finished living through', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'dep-tz@example.com');
      const { accountId, companyId } = await ownerContext('dep-tz@example.com');
      await send(app, 'PATCH', `/api/companies/${companyId}`, cookie, accountId, {
        timezone: 'America/Chicago',
      });
      await seedSpreadPurchase(app, cookie, accountId, companyId, {
        purchaseDate: '2026-06-15',
        amount: '3600.00',
      });

      // 02:00 UTC on 1 Jan 2027 is still 20:00 on 31 Dec 2026 in Chicago, so
      // 2026 hasn't closed for this company yet.
      const early = await sweep(new Date('2027-01-01T02:00:00Z'));
      expect(early.entriesPosted).toBe(0);

      // Eight hours later it has.
      const later = await sweep(new Date('2027-01-01T10:00:00Z'));
      expect(later.entriesPosted).toBe(1);
      expect(await line13(app, companyId, cookie, accountId, 2026)).toBe('360.00');
    } finally {
      await handle.close();
    }
  });

  it('leaves other tenants alone', async () => {
    const { app, handle } = buildApp();
    try {
      const cookieA = await signUp(app, 'dep-a@example.com');
      const a = await ownerContext('dep-a@example.com');
      const cookieB = await signUp(app, 'dep-b@example.com');
      const b = await ownerContext('dep-b@example.com');

      await seedSpreadPurchase(app, cookieA, a.accountId, a.companyId, {
        purchaseDate: '2026-06-15',
        amount: '3600.00',
      });
      await sweep(new Date('2027-06-01T12:00:00Z'));

      expect(await line13(app, a.companyId, cookieA, a.accountId, 2026)).toBe('360.00');
      expect(await line13(app, b.companyId, cookieB, b.accountId, 2026)).toBe('0.00');

      const bLines = await getTestDb()
        .select({ id: journalLines.id })
        .from(journalLines)
        .where(eq(journalLines.accountId, b.accountId));
      expect(bLines).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });

  it('does not depreciate past cost when the convention is flipped mid-life', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'dep-flip@example.com');
      const { accountId, companyId } = await ownerContext('dep-flip@example.com');
      const id = await seedSpreadPurchase(app, cookie, accountId, companyId, {
        purchaseDate: '2026-06-15',
        amount: '3600.00',
      });

      // Two years posted on half_year (360 + 720), then the accountant switches.
      await sweep(new Date('2028-06-01T12:00:00Z'));
      await send(app, 'PATCH', `/api/companies/${companyId}`, cookie, accountId, {
        depreciationConvention: 'full_year',
      });
      await sweep(new Date('2035-01-01T12:00:00Z'));

      // Already-posted years keep the figures they were posted with (the ledger
      // is append-only), and the asset still ends written off to exactly cost —
      // never more.
      const detail = (await (await get(app, `/api/purchases/${id}`, cookie, accountId)).json()) as {
        schedule: { postedToDate: string };
      };
      expect(detail.schedule.postedToDate).toBe('3600.00');
      expect(await line13(app, companyId, cookie, accountId, 2026)).toBe('360.00');
      expect(await tenantBalanced(accountId)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('keeps depreciation out of cash flow — no money actually moved', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'dep-cash@example.com');
      const { accountId, companyId } = await ownerContext('dep-cash@example.com');
      await seedSpreadPurchase(app, cookie, accountId, companyId, {
        purchaseDate: '2026-06-15',
        amount: '3600.00',
      });

      const before = (await (
        await get(app, `/api/companies/${companyId}/dashboard`, cookie, accountId)
      ).json()) as { cashOnHand: string };
      await sweep(new Date('2028-06-01T12:00:00Z'));
      const after = (await (
        await get(app, `/api/companies/${companyId}/dashboard`, cookie, accountId)
      ).json()) as { cashOnHand: string };

      expect(after.cashOnHand).toBe(before.cashOnHand);
    } finally {
      await handle.close();
    }
  });

  it('does not touch the loan balance on a financed purchase', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'dep-loan@example.com');
      const { accountId, companyId } = await ownerContext('dep-loan@example.com');
      const res = await send(app, 'POST', '/api/purchases', cookie, accountId, {
        companyId,
        description: 'Mower',
        amount: '3600.00',
        purchaseDate: '2026-06-15',
        funding: 'financed',
        downPayment: '600.00',
        taxTreatment: 'spread',
      });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };

      await sweep(new Date('2028-06-01T12:00:00Z'));
      const detail = (await (await get(app, `/api/purchases/${id}`, cookie, accountId)).json()) as {
        owing: string;
      };
      // Depreciation posts against 6350/1900; the loan (2700) is untouched.
      expect(detail.owing).toBe('3000.00');

      const [row] = await getTestDb()
        .select({ id: capitalPurchases.id })
        .from(capitalPurchases)
        .where(and(eq(capitalPurchases.id, id), eq(capitalPurchases.accountId, accountId)));
      expect(row).toBeDefined();
    } finally {
      await handle.close();
    }
  });
});

// Assets that were already part-way through their life when they arrived — an
// accountant entering a mower the previous books had already depreciated, or an
// incorporation handoff (§351 carryover basis).
//
// The load-bearing property: the schedule is IDENTICAL to an ordinary purchase's
// (same cost, life, convention, clock — carryover basis means stepping into the
// transferor's shoes). Only which of its years belong to this company differs.
describe('depreciation carryover', () => {
  beforeEach(resetDb);

  it('resumes mid-schedule instead of back-posting the previous books years', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'dep-carry@example.com');
      const { accountId, companyId } = await ownerContext('dep-carry@example.com');

      // Bought 2024 for 6,000 over 5 years. Half-year convention: 600 in 2024,
      // then 1,200 a year. The previous books took 2024 + 2025 = 1,800.
      const id = await seedSpreadPurchase(app, cookie, accountId, companyId, {
        purchaseDate: '2024-03-01',
        amount: '6000.00',
        usefulLifeYears: 5,
        priorAccumulatedDepreciation: '1800.00',
        depreciationStartYear: 2026,
      });

      await sweep(new Date('2027-06-01T12:00:00Z'));

      const posted = await getTestDb()
        .select({ postedAt: journalEntries.postedAt, amount: journalLines.amount })
        .from(journalEntries)
        .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
        .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalLines.coaAccountId))
        .where(
          and(
            eq(journalEntries.accountId, accountId),
            eq(journalEntries.sourceEntityId, id),
            eq(chartOfAccounts.code, '6350'),
          ),
        );
      const years = posted.map((r) => r.postedAt.getUTCFullYear()).sort();
      // 2026 belongs to this company; 2024 and 2025 belong to the old books and
      // must never appear here.
      expect(years).toEqual([2026]);
      expect(posted[0]?.amount).toBe('1200.00');
      expect(await tenantBalanced(accountId)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('never writes off more than the asset cost across both sets of books', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'dep-clamp@example.com');
      const { accountId, companyId } = await ownerContext('dep-clamp@example.com');

      // 5,400 of a 6,000 asset already taken elsewhere: only 600 is left, however
      // many years the plan still nominally has.
      const id = await seedSpreadPurchase(app, cookie, accountId, companyId, {
        purchaseDate: '2024-03-01',
        amount: '6000.00',
        usefulLifeYears: 5,
        priorAccumulatedDepreciation: '5400.00',
        depreciationStartYear: 2026,
      });

      await sweep(new Date('2032-06-01T12:00:00Z'));

      const rows = await getTestDb()
        .select({ amount: journalLines.amount })
        .from(journalEntries)
        .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
        .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalLines.coaAccountId))
        .where(
          and(
            eq(journalEntries.accountId, accountId),
            eq(journalEntries.sourceEntityId, id),
            eq(chartOfAccounts.code, '6350'),
          ),
        );
      const total = rows.reduce((sum, r) => sum + Math.round(Number(r.amount) * 100), 0);
      expect(total).toBe(60000);
      expect(await tenantBalanced(accountId)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('leaves an ordinary purchase completely unchanged', async () => {
    const { app, handle } = buildApp();
    try {
      const cookie = await signUp(app, 'dep-ordinary@example.com');
      const { accountId, companyId } = await ownerContext('dep-ordinary@example.com');

      // Both fields omitted — the regression pin on today's semantics.
      const id = await seedSpreadPurchase(app, cookie, accountId, companyId, {
        purchaseDate: '2024-03-01',
        amount: '6000.00',
        usefulLifeYears: 5,
      });

      await sweep(new Date('2027-06-01T12:00:00Z'));

      const posted = await getTestDb()
        .select({ postedAt: journalEntries.postedAt, amount: journalLines.amount })
        .from(journalEntries)
        .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
        .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalLines.coaAccountId))
        .where(
          and(
            eq(journalEntries.accountId, accountId),
            eq(journalEntries.sourceEntityId, id),
            eq(chartOfAccounts.code, '6350'),
          ),
        );
      expect(posted.map((r) => r.postedAt.getUTCFullYear()).sort()).toEqual([2024, 2025, 2026]);
    } finally {
      await handle.close();
    }
  });
});
