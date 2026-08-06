import { authUser, chartOfAccounts, companies, journalEntries, journalLines } from '@thalermark/db';
import { memberships, mileageTrips, vehicleYears, vehicles } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// Mileage trips (TMC-179).
//
// The load-bearing test in this file is "the books never move". Everything else
// here is ordinary CRUD; that one assertion is the feature's whole safety
// property, because a mileage deduction that posted to the ledger would invent
// cash that never left the bank.

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

type Ctx = Awaited<ReturnType<typeof setup>>;

async function setup(email: string) {
  const { app, handle } = buildApp();
  const cookie = await signUp(app, email);
  const { accountId, companyId } = await userContext(email);
  const headers = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };
  return { app, handle, cookie, accountId, companyId, headers };
}

async function coaId(companyId: string, code: string): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.companyId, companyId), eq(chartOfAccounts.code, code)));
  if (!row) throw new Error(`COA ${code} not seeded for company ${companyId}`);
  return row.id;
}

async function logTrip(
  ctx: Ctx,
  body: Partial<{
    tripDate: string;
    miles: string;
    purpose: string;
    vehicleId: string | null;
    jobId: string | null;
  }> = {},
) {
  return ctx.app.request('/api/mileage-trips', {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({
      companyId: ctx.companyId,
      tripDate: body.tripDate ?? '2026-07-15',
      miles: body.miles ?? '24.5',
      purpose: body.purpose ?? 'Drove to the Miller place',
      ...(body.vehicleId !== undefined ? { vehicleId: body.vehicleId } : {}),
      ...(body.jobId !== undefined ? { jobId: body.jobId } : {}),
    }),
  });
}

async function makeContact(ctx: Ctx, name: string): Promise<string> {
  const res = await ctx.app.request('/api/contacts', {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({ companyId: ctx.companyId, name }),
  });
  if (res.status !== 201) throw new Error(`contact create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function makeJob(ctx: Ctx, name: string, contactId?: string): Promise<string> {
  const res = await ctx.app.request('/api/jobs', {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({ companyId: ctx.companyId, name, contactId }),
  });
  if (res.status !== 201) throw new Error(`job create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

// A snapshot of everything that must not move when a trip is logged.
async function ledgerFingerprint(ctx: Ctx) {
  const db = getTestDb();
  const entries = await db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(eq(journalEntries.accountId, ctx.accountId));
  const lines = await db
    .select({ id: journalLines.id })
    .from(journalLines)
    .where(eq(journalLines.accountId, ctx.accountId));
  const balanceSheet = await ctx.app.request(
    `/api/companies/${ctx.companyId}/balance-sheet?asOf=2026-12-31`,
    { headers: ctx.headers },
  );
  const profitLoss = await ctx.app.request(
    `/api/companies/${ctx.companyId}/profit-loss?from=2026-01-01&to=2026-12-31`,
    { headers: ctx.headers },
  );
  return {
    entryCount: entries.length,
    lineCount: lines.length,
    balanceSheet: await balanceSheet.text(),
    profitLoss: await profitLoss.text(),
  };
}

describe('mileage trips', () => {
  beforeEach(resetDb);

  it('logs a trip and reads it back', async () => {
    const ctx = await setup('miles-create@example.com');
    const res = await logTrip(ctx, { miles: '24.5' });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Record<string, unknown>;
    expect(created.miles).toBe('24.5000');
    expect(created.purpose).toBe('Drove to the Miller place');
    expect(created.jobId).toBeNull();
    // A trip logged before any vehicle exists is still a real deduction. Those
    // miles surface as unassigned on the worksheet rather than being dropped.
    expect(created.vehicleId).toBeNull();

    const list = await ctx.app.request(`/api/mileage-trips?companyId=${ctx.companyId}`, {
      headers: ctx.headers,
    });
    expect(list.status).toBe(200);
    const { trips } = (await list.json()) as { trips: { id: string }[] };
    expect(trips).toHaveLength(1);
    expect(trips[0]?.id).toBe(created.id);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // THE test. Standard mileage is a tax figure, not a bookkeeping one — no
  // money moves when you drive. If this ever fails, the feature is wrong, not
  // the test.
  // ─────────────────────────────────────────────────────────────────────────
  it('leaves the books byte-identical — no journal entry, ever', async () => {
    const ctx = await setup('miles-books@example.com');

    // Post something real first, so the fingerprint is of a company with actual
    // books rather than an empty one where any two snapshots trivially match.
    const cashId = await coaId(ctx.companyId, '1000');
    const fuelId = await coaId(ctx.companyId, '6100');
    const expense = await ctx.app.request('/api/expenses', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({
        companyId: ctx.companyId,
        merchant: 'Shell',
        amount: '62.40',
        expenseDate: '2026-07-02',
        categoryAccountId: fuelId,
        paymentAccountId: cashId,
      }),
    });
    expect(expense.status).toBe(201);

    const before = await ledgerFingerprint(ctx);
    expect(before.entryCount).toBeGreaterThan(0);

    for (let i = 0; i < 25; i++) {
      const res = await logTrip(ctx, {
        miles: '31.2',
        tripDate: '2026-07-15',
        purpose: `Trip ${i}`,
      });
      expect(res.status).toBe(201);
    }

    const after = await ledgerFingerprint(ctx);
    expect(after.entryCount).toBe(before.entryCount);
    expect(after.lineCount).toBe(before.lineCount);
    expect(after.balanceSheet).toBe(before.balanceSheet);
    expect(after.profitLoss).toBe(before.profitLoss);
  });

  // Mileage is not in the P&L, and job-margin buckets reconcile against it. A
  // nullable job_id will one day tempt someone to "complete" margin with these;
  // this is the guard rail.
  it('leaves job margin byte-identical even when trips name a job', async () => {
    const ctx = await setup('miles-margin@example.com');
    const contactId = await makeContact(ctx, 'Miller');
    const jobId = await makeJob(ctx, 'The Miller place', contactId);

    const marginUrl = `/api/companies/${ctx.companyId}/job-margin?from=2026-01-01&to=2026-12-31`;
    const before = await (await ctx.app.request(marginUrl, { headers: ctx.headers })).text();

    for (let i = 0; i < 5; i++) {
      const res = await logTrip(ctx, { jobId, purpose: `Site visit ${i}` });
      expect(res.status).toBe(201);
    }

    const after = await (await ctx.app.request(marginUrl, { headers: ctx.headers })).text();
    expect(after).toBe(before);
  });

  it('accepts a trip with no job — the drive to the bank is still a business mile', async () => {
    const ctx = await setup('miles-nojob@example.com');
    const res = await logTrip(ctx, { purpose: 'Deposit cheques at the bank', jobId: null });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { jobId: string | null }).jobId).toBeNull();
  });

  it('keeps the trip when its job is deleted', async () => {
    const ctx = await setup('miles-jobdel@example.com');
    const contactId = await makeContact(ctx, 'Miller');
    const jobId = await makeJob(ctx, 'The Miller place', contactId);
    const created = (await (await logTrip(ctx, { jobId })).json()) as { id: string };

    const del = await ctx.app.request(`/api/jobs/${jobId}`, {
      method: 'DELETE',
      headers: ctx.headers,
    });
    expect(del.status).toBe(204);

    const db = getTestDb();
    const [row] = await db.select().from(mileageTrips).where(eq(mileageTrips.id, created.id));
    expect(row).toBeDefined();
    expect(row?.jobId).toBeNull();
    expect(row?.miles).toBe('24.5000');
  });

  it('rejects a trip with no purpose', async () => {
    const ctx = await setup('miles-nopurpose@example.com');
    const res = await ctx.app.request('/api/mileage-trips', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({
        companyId: ctx.companyId,
        tripDate: '2026-07-15',
        miles: '24.5',
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
  });

  it('rejects a job from a sibling company', async () => {
    const ctx = await setup('miles-mismatch@example.com');
    const other = await ctx.app.request('/api/companies', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({ name: 'Second Co', businessType: 'sole_prop' }),
    });
    expect(other.status).toBe(201);
    const otherCompanyId = ((await other.json()) as { id: string }).id;

    const jobRes = await ctx.app.request('/api/jobs', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({ companyId: otherCompanyId, name: 'Elsewhere' }),
    });
    const otherJobId = ((await jobRes.json()) as { id: string }).id;

    const res = await logTrip(ctx, { jobId: otherJobId });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('job_company_mismatch');
  });

  it("does not leak another account's trips", async () => {
    const mine = await setup('miles-mine@example.com');
    const theirs = await setup('miles-theirs@example.com');
    await logTrip(theirs, { purpose: 'Their drive' });

    const list = await mine.app.request(`/api/mileage-trips?companyId=${mine.companyId}`, {
      headers: mine.headers,
    });
    const { trips } = (await list.json()) as { trips: unknown[] };
    expect(trips).toHaveLength(0);
  });

  it('refuses a trip in a closed year, and says so', async () => {
    const ctx = await setup('miles-closed@example.com');
    // 2025, not 2026: you cannot close a year you are still living through, and
    // a year with no activity has nothing to roll into equity — so the year
    // needs books AND needs to be over.
    const expense = await ctx.app.request('/api/expenses', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({
        companyId: ctx.companyId,
        merchant: 'Shell',
        amount: '62.40',
        expenseDate: '2025-03-02',
        categoryAccountId: await coaId(ctx.companyId, '6100'),
        paymentAccountId: await coaId(ctx.companyId, '1000'),
      }),
    });
    expect(expense.status).toBe(201);

    const close = await ctx.app.request('/api/ledger/period-closes', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({ companyId: ctx.companyId, fiscalYear: 2025 }),
    });
    expect(close.status).toBe(201);

    const res = await logTrip(ctx, { tripDate: '2025-07-15' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('period_closed');
  });

  it('refuses a trip against a retired company', async () => {
    const ctx = await setup('miles-retired@example.com');
    // A workspace must always have somewhere to work, so retiring the only
    // company is refused. Give it a second one first.
    const second = await ctx.app.request('/api/companies', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({ name: 'Still Trading Co', businessType: 'sole_prop' }),
    });
    expect(second.status).toBe(201);

    const retire = await ctx.app.request(`/api/companies/${ctx.companyId}/retire`, {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({ retiredAt: '2026-06-30' }),
    });
    expect(retire.status).toBe(200);

    const res = await logTrip(ctx, { tripDate: '2026-07-15' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('company_retired');
  });

  it('edits and deletes a trip', async () => {
    const ctx = await setup('miles-edit@example.com');
    const created = (await (await logTrip(ctx)).json()) as { id: string };

    const patch = await ctx.app.request(`/api/mileage-trips/${created.id}`, {
      method: 'PATCH',
      headers: ctx.headers,
      body: JSON.stringify({ miles: '31.8', purpose: 'Corrected' }),
    });
    expect(patch.status).toBe(200);
    const updated = (await patch.json()) as Record<string, unknown>;
    expect(updated.miles).toBe('31.8000');
    expect(updated.purpose).toBe('Corrected');

    const del = await ctx.app.request(`/api/mileage-trips/${created.id}`, {
      method: 'DELETE',
      headers: ctx.headers,
    });
    expect(del.status).toBe(200);

    const list = await ctx.app.request(`/api/mileage-trips?companyId=${ctx.companyId}`, {
      headers: ctx.headers,
    });
    expect(((await list.json()) as { trips: unknown[] }).trips).toHaveLength(0);
  });

  // The year summary is where the mid-year rate split has to survive a round
  // trip through the database, not just the pure helper.
  it('summarises a year, valuing each trip at the rate in force on its date', async () => {
    const ctx = await setup('miles-summary@example.com');
    await logTrip(ctx, { tripDate: '2026-06-30', miles: '100', purpose: 'Before the change' });
    await logTrip(ctx, { tripDate: '2026-07-01', miles: '100', purpose: 'After the change' });

    const res = await ctx.app.request(`/api/companies/${ctx.companyId}/mileage?year=2026`, {
      headers: ctx.headers,
    });
    expect(res.status).toBe(200);
    const summary = (await res.json()) as Record<string, unknown>;
    expect(summary.year).toBe(2026);
    expect(summary.tripCount).toBe(2);
    expect(summary.miles).toBe('200.0000');
    // 100 x 0.7250 + 100 x 0.7600. Not 200 x either rate.
    expect(summary.amount).toBe('148.50');
    expect(summary.unratedMiles).toBe('0.0000');
  });

  it('reports miles it cannot price rather than guessing a rate', async () => {
    const ctx = await setup('miles-unrated@example.com');
    await logTrip(ctx, { tripDate: '2030-03-01', miles: '40', purpose: 'Far future' });

    const res = await ctx.app.request(`/api/companies/${ctx.companyId}/mileage?year=2030`, {
      headers: ctx.headers,
    });
    const summary = (await res.json()) as Record<string, unknown>;
    expect(summary.miles).toBe('40.0000');
    expect(summary.amount).toBe('0.00');
    expect(summary.unratedMiles).toBe('40.0000');
  });
});

// Vehicles and the Schedule C Part IV disclosure (TMC-179 follow-up). Part IV is
// per-vehicle — the instructions require a separate attached statement for each
// additional vehicle — which is what earns this table. Nothing here posts, and
// nothing here changes a dollar figure on any form.
describe('vehicles', () => {
  beforeEach(resetDb);

  async function makeVehicle(ctx: Ctx, label: string, extra: Record<string, unknown> = {}) {
    return ctx.app.request('/api/vehicles', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({ companyId: ctx.companyId, label, ...extra }),
    });
  }

  it('creates a vehicle with every Part IV answer unanswered', async () => {
    const ctx = await setup('veh-create@example.com');
    const res = await makeVehicle(ctx, 'F-150');
    expect(res.status).toBe(201);
    const v = (await res.json()) as Record<string, unknown>;
    expect(v.label).toBe('F-150');
    // NULL, not defaulted — "we guessed no" would be an affirmative false
    // statement on a signed return.
    expect(v.placedInServiceOn).toBeNull();
    expect(v.personalUse).toBeNull();
    expect(v.anotherVehicleAvailable).toBeNull();
  });

  // The plow-truck case. 45 = No and 46 = Yes is not a contradiction — it is the
  // strongest combination for the deduction.
  it('records a work-only vehicle alongside another personal vehicle', async () => {
    const ctx = await setup('veh-plow@example.com');
    const res = await makeVehicle(ctx, 'Plow truck', {
      placedInServiceOn: '2024-11-01',
      personalUse: 'none',
      anotherVehicleAvailable: true,
    });
    expect(res.status).toBe(201);
    const v = (await res.json()) as Record<string, unknown>;
    expect(v.personalUse).toBe('none');
    expect(v.anotherVehicleAvailable).toBe(true);
    expect(v.placedInServiceOn).toBe('2024-11-01');
  });

  it('refuses a duplicate label and names the one that already exists', async () => {
    const ctx = await setup('veh-dupe@example.com');
    const first = (await (await makeVehicle(ctx, 'F-150')).json()) as { id: string };

    const res = await makeVehicle(ctx, '  f-150  ');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; vehicleId: string };
    expect(body.error).toBe('vehicle_label_taken');
    expect(body.vehicleId).toBe(first.id);
  });

  it('rejects a vehicle from a sibling company', async () => {
    const ctx = await setup('veh-mismatch@example.com');
    const other = await ctx.app.request('/api/companies', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({ name: 'Second Co', businessType: 'sole_prop' }),
    });
    const otherCompanyId = ((await other.json()) as { id: string }).id;
    const otherVehicle = (await (
      await ctx.app.request('/api/vehicles', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({ companyId: otherCompanyId, label: 'Elsewhere' }),
      })
    ).json()) as { id: string };

    const res = await logTrip(ctx, { vehicleId: otherVehicle.id });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('vehicle_company_mismatch');
  });

  it('retires rather than deletes, keeping the trips', async () => {
    const ctx = await setup('veh-retire@example.com');
    const v = (await (await makeVehicle(ctx, 'F-150')).json()) as { id: string };
    const trip = (await (await logTrip(ctx, { vehicleId: v.id })).json()) as { id: string };

    const res = await ctx.app.request(`/api/vehicles/${v.id}/retire`, {
      method: 'POST',
      headers: ctx.headers,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { retiredAt: string | null }).retiredAt).not.toBeNull();

    const active = await ctx.app.request(`/api/vehicles?companyId=${ctx.companyId}`, {
      headers: ctx.headers,
    });
    expect(((await active.json()) as { vehicles: unknown[] }).vehicles).toHaveLength(0);
    // Still fetchable, and its trips are untouched — a truck sold in June still
    // belongs on that year's return.
    const all = await ctx.app.request(
      `/api/vehicles?companyId=${ctx.companyId}&includeRetired=true`,
      { headers: ctx.headers },
    );
    expect(((await all.json()) as { vehicles: unknown[] }).vehicles).toHaveLength(1);

    const db = getTestDb();
    const [row] = await db.select().from(mileageTrips).where(eq(mileageTrips.id, trip.id));
    expect(row?.vehicleId).toBe(v.id);

    expect((await makeVehicle(ctx, 'F-150')).status).toBe(201);
  });

  // Vehicle answers are NOT period-locked, unlike trips. A trip changes the
  // dollar figure on line 9; these fill a disclosure box. A corp that closes in
  // January must still be able to answer in March.
  it('accepts vehicle answers in a closed year while a trip in it still 409s', async () => {
    const ctx = await setup('veh-closed@example.com');
    await ctx.app.request('/api/expenses', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({
        companyId: ctx.companyId,
        merchant: 'Shell',
        amount: '62.40',
        expenseDate: '2025-03-02',
        categoryAccountId: await coaId(ctx.companyId, '6100'),
        paymentAccountId: await coaId(ctx.companyId, '1000'),
      }),
    });
    const close = await ctx.app.request('/api/ledger/period-closes', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({ companyId: ctx.companyId, fiscalYear: 2025 }),
    });
    expect(close.status).toBe(201);

    const v = (await (await makeVehicle(ctx, 'F-150')).json()) as { id: string };
    const patch = await ctx.app.request(`/api/vehicles/${v.id}`, {
      method: 'PATCH',
      headers: ctx.headers,
      body: JSON.stringify({ personalUse: 'some', placedInServiceOn: '2025-01-15' }),
    });
    expect(patch.status).toBe(200);

    expect((await logTrip(ctx, { tripDate: '2025-07-15' })).status).toBe(409);
  });

  it('leaves the books byte-identical with vehicles present', async () => {
    const ctx = await setup('veh-books@example.com');
    const cashId = await coaId(ctx.companyId, '1000');
    const fuelId = await coaId(ctx.companyId, '6100');
    await ctx.app.request('/api/expenses', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({
        companyId: ctx.companyId,
        merchant: 'Shell',
        amount: '62.40',
        expenseDate: '2026-07-02',
        categoryAccountId: fuelId,
        paymentAccountId: cashId,
      }),
    });

    const before = await ledgerFingerprint(ctx);
    const v = (await (await makeVehicle(ctx, 'F-150', { personalUse: 'some' })).json()) as {
      id: string;
    };
    for (let i = 0; i < 10; i++) {
      await logTrip(ctx, { vehicleId: v.id, purpose: `Trip ${i}` });
    }

    const after = await ledgerFingerprint(ctx);
    expect(after.entryCount).toBe(before.entryCount);
    expect(after.lineCount).toBe(before.lineCount);
    expect(after.balanceSheet).toBe(before.balanceSheet);
    expect(after.profitLoss).toBe(before.profitLoss);
  });
});

// The per-year half of Part IV — line 44's total, and the arithmetic that turns
// it into the three boxes the form actually wants.
describe('vehicle years', () => {
  beforeEach(resetDb);

  async function makeVehicle(ctx: Ctx, label: string, extra: Record<string, unknown> = {}) {
    const res = await ctx.app.request('/api/vehicles', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({ companyId: ctx.companyId, label, ...extra }),
    });
    return (await res.json()) as { id: string };
  }

  async function putYear(ctx: Ctx, vehicleId: string, year: number, body: unknown) {
    return ctx.app.request(`/api/vehicles/${vehicleId}/years/${year}`, {
      method: 'PUT',
      headers: ctx.headers,
      body: JSON.stringify(body),
    });
  }

  it('records a total and is idempotent', async () => {
    const ctx = await setup('vy-upsert@example.com');
    const v = await makeVehicle(ctx, 'F-150', { personalUse: 'some' });

    const first = await putYear(ctx, v.id, 2026, { totalMiles: '12000' });
    expect(first.status).toBe(201);
    expect(((await first.json()) as { totalMiles: string }).totalMiles).toBe('12000.0000');

    // Answering again replaces rather than duplicating — one row per vehicle
    // per year, or "what did this truck do in 2026" is ambiguous on the return.
    const second = await putYear(ctx, v.id, 2026, { totalMiles: '12500' });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { totalMiles: string }).totalMiles).toBe('12500.0000');
  });

  // Blocks, where the double-dip overlap only warns. total < business is
  // arithmetically impossible; a double deduction is merely suspicious.
  it('refuses a total below the miles already logged, and says what they are', async () => {
    const ctx = await setup('vy-below@example.com');
    const v = await makeVehicle(ctx, 'F-150', { personalUse: 'some' });
    await logTrip(ctx, { vehicleId: v.id, miles: '500', tripDate: '2026-07-15' });

    const res = await putYear(ctx, v.id, 2026, { totalMiles: '400' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; businessMiles: string };
    expect(body.error).toBe('total_below_logged');
    expect(body.businessMiles).toBe('500.0000');
  });

  it('counts commuting against the total too', async () => {
    const ctx = await setup('vy-commute@example.com');
    const v = await makeVehicle(ctx, 'F-150', { personalUse: 'some' });
    await logTrip(ctx, { vehicleId: v.id, miles: '500', tripDate: '2026-07-15' });

    // 500 business + 600 commuting = 1100 > 1000.
    expect(
      (await putYear(ctx, v.id, 2026, { totalMiles: '1000', commutingMiles: '600' })).status,
    ).toBe(400);
    expect(
      (await putYear(ctx, v.id, 2026, { totalMiles: '1200', commutingMiles: '600' })).status,
    ).toBe(201);
  });

  it('scopes the logged comparison to the year being answered', async () => {
    const ctx = await setup('vy-yearscope@example.com');
    const v = await makeVehicle(ctx, 'F-150', { personalUse: 'some' });
    await logTrip(ctx, { vehicleId: v.id, miles: '5000', tripDate: '2026-07-15' });

    // 2025 has no trips, so a small total is fine even though 2026 has 5,000.
    expect((await putYear(ctx, v.id, 2025, { totalMiles: '100' })).status).toBe(201);
  });

  // The divergence from trips, pinned. Vehicle answers fill a disclosure box and
  // change no dollar figure, so a closed year must not lock them out.
  it('accepts a year answer for a CLOSED year', async () => {
    const ctx = await setup('vy-closed@example.com');
    await ctx.app.request('/api/expenses', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({
        companyId: ctx.companyId,
        merchant: 'Shell',
        amount: '62.40',
        expenseDate: '2025-03-02',
        categoryAccountId: await coaId(ctx.companyId, '6100'),
        paymentAccountId: await coaId(ctx.companyId, '1000'),
      }),
    });
    const close = await ctx.app.request('/api/ledger/period-closes', {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify({ companyId: ctx.companyId, fiscalYear: 2025 }),
    });
    expect(close.status).toBe(201);

    const v = await makeVehicle(ctx, 'F-150', { personalUse: 'some' });
    expect((await putYear(ctx, v.id, 2025, { totalMiles: '9000' })).status).toBe(201);
    // ...while a TRIP in that same year is still refused.
    expect((await logTrip(ctx, { tripDate: '2025-07-15' })).status).toBe(409);
  });

  it('goes when its vehicle goes, unlike a trip', async () => {
    const ctx = await setup('vy-cascade@example.com');
    const v = await makeVehicle(ctx, 'F-150', { personalUse: 'some' });
    const trip = (await (await logTrip(ctx, { vehicleId: v.id })).json()) as { id: string };
    await putYear(ctx, v.id, 2026, { totalMiles: '12000' });

    const db = getTestDb();
    await db.delete(vehicles).where(eq(vehicles.id, v.id));

    // The year row is a fact ABOUT the vehicle — meaningless without it.
    const years = await db
      .select()
      .from(vehicleYears)
      .where(eq(vehicleYears.accountId, ctx.accountId));
    expect(years).toHaveLength(0);
    // The trip is evidence and survives.
    const [row] = await db.select().from(mileageTrips).where(eq(mileageTrips.id, trip.id));
    expect(row).toBeDefined();
    expect(row?.vehicleId).toBeNull();
  });

  it('rejects a nonsense year and an unknown vehicle', async () => {
    const ctx = await setup('vy-bad@example.com');
    const v = await makeVehicle(ctx, 'F-150');
    expect((await putYear(ctx, v.id, 1200, { totalMiles: '10' })).status).toBe(400);
    expect(
      (await putYear(ctx, '018f0000-0000-7000-8000-000000000009', 2026, { totalMiles: '10' }))
        .status,
    ).toBe(404);
  });
});
