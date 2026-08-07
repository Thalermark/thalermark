import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { contacts } from './contacts.js';
import { jobs } from './jobs.js';
import { mileageTrips } from './mileage_trips.js';

async function seedTenant() {
  const db = getTestDb();
  const accountId = uuidv7();
  const companyId = uuidv7();
  const contactId = uuidv7();
  const jobId = uuidv7();
  await db.insert(accounts).values({ id: accountId, name: 'Acme' });
  await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
  await db.insert(contacts).values({ id: contactId, accountId, companyId, name: 'Miller' });
  await db
    .insert(jobs)
    .values({ id: jobId, accountId, companyId, contactId, name: 'The Miller place' });
  return { accountId, companyId, contactId, jobId };
}

async function seedTrip(
  t: Awaited<ReturnType<typeof seedTenant>>,
  overrides: Partial<{ miles: string; jobId: string | null; tripDate: string }> = {},
) {
  const db = getTestDb();
  const id = uuidv7();
  await db.insert(mileageTrips).values({
    id,
    accountId: t.accountId,
    companyId: t.companyId,
    tripDate: overrides.tripDate ?? '2026-07-15',
    miles: overrides.miles ?? '24.5000',
    purpose: 'Drove to the Miller place',
    jobId: overrides.jobId === undefined ? t.jobId : overrides.jobId,
  });
  return id;
}

describe('mileage_trips', () => {
  beforeEach(resetDb);

  it('stores miles at 4dp so valuation can multiply exactly', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const id = await seedTrip(t, { miles: '24.5000' });

    const [row] = await db.select().from(mileageTrips).where(eq(mileageTrips.id, id));
    expect(row?.miles).toBe('24.5000');
    expect(row?.tripDate).toBe('2026-07-15');
  });

  // THE divergence from time_entries.job_id, which is NOT NULL. A drive to the
  // bank or the supply house is an ordinary deductible business mile belonging
  // to no job at all; forcing a job would lose those trips or invent a fake job
  // to hold them.
  it('accepts a trip with no job — the drive to the bank is still a business mile', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const id = await seedTrip(t, { jobId: null });

    const [row] = await db.select().from(mileageTrips).where(eq(mileageTrips.id, id));
    expect(row).toBeDefined();
    expect(row?.jobId).toBeNull();
  });

  // The second divergence: time_entries CASCADE off the job, these SET NULL.
  // This is tax substantiation — deleting a job must not destroy the evidence
  // for a deduction already claimed.
  it('survives its job being deleted, keeping the mileage evidence', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const id = await seedTrip(t);

    await db.delete(jobs).where(eq(jobs.id, t.jobId));

    const [row] = await db.select().from(mileageTrips).where(eq(mileageTrips.id, id));
    expect(row).toBeDefined();
    expect(row?.jobId).toBeNull();
    expect(row?.miles).toBe('24.5000');
    expect(row?.purpose).toBe('Drove to the Miller place');
  });

  it('refuses a trip with no purpose — the unsubstantiated deduction is the one disallowed', async () => {
    const db = getTestDb();
    const t = await seedTenant();

    await expect(
      db.insert(mileageTrips).values({
        id: uuidv7(),
        accountId: t.accountId,
        companyId: t.companyId,
        tripDate: '2026-07-15',
        miles: '10.0000',
        // biome-ignore lint/suspicious/noExplicitAny: asserting the NOT NULL guard
        purpose: null as any,
      }),
    ).rejects.toThrow();
  });

  it('refuses zero or negative miles', async () => {
    const t = await seedTenant();

    await expect(seedTrip(t, { miles: '0.0000' })).rejects.toThrow();
    await expect(seedTrip(t, { miles: '-5.0000' })).rejects.toThrow();
  });

  it('goes when its company goes', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    await seedTrip(t);

    await db.delete(companies).where(eq(companies.id, t.companyId));

    const rows = await db
      .select()
      .from(mileageTrips)
      .where(eq(mileageTrips.accountId, t.accountId));
    expect(rows).toHaveLength(0);
  });
});
