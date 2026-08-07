import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { accounts } from './accounts.js';
import { companies } from './companies.js';
import { mileageTrips } from './mileage_trips.js';
import { vehicles } from './vehicles.js';

async function seedTenant() {
  const db = getTestDb();
  const accountId = uuidv7();
  const companyId = uuidv7();
  await db.insert(accounts).values({ id: accountId, name: 'Acme' });
  await db.insert(companies).values({ id: companyId, accountId, name: 'Acme Co' });
  return { accountId, companyId };
}

async function seedVehicle(
  t: Awaited<ReturnType<typeof seedTenant>>,
  overrides: Partial<{ label: string; personalUse: string | null; retiredAt: Date | null }> = {},
) {
  const db = getTestDb();
  const id = uuidv7();
  await db.insert(vehicles).values({
    id,
    accountId: t.accountId,
    companyId: t.companyId,
    label: overrides.label ?? 'F-150',
    personalUse: overrides.personalUse === undefined ? null : overrides.personalUse,
    retiredAt: overrides.retiredAt ?? null,
  });
  return id;
}

describe('vehicles', () => {
  beforeEach(resetDb);

  // The three-state is the whole reason a purpose-built vehicle costs its owner
  // no year-end work: 'none' means asked and answered, NULL means not yet asked.
  // A NOT NULL DEFAULT would make those indistinguishable, and the guess would
  // be an affirmative false statement on a signed return.
  it('starts with every Part IV answer unanswered, not defaulted', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const id = await seedVehicle(t);

    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, id));
    expect(row?.placedInServiceOn).toBeNull();
    expect(row?.personalUse).toBeNull();
    expect(row?.anotherVehicleAvailable).toBeNull();
    expect(row?.retiredAt).toBeNull();
  });

  // Two rows for one truck would split its business miles across two Part IV
  // disclosures, each understating. Case and whitespace must not defeat it.
  it('refuses a second active vehicle whose label differs only by case or spacing', async () => {
    const t = await seedTenant();
    await seedVehicle(t, { label: 'F-150' });

    await expect(seedVehicle(t, { label: 'f-150' })).rejects.toThrow();
    await expect(seedVehicle(t, { label: '  F-150  ' })).rejects.toThrow();
  });

  it('frees the label once the vehicle is retired', async () => {
    const t = await seedTenant();
    await seedVehicle(t, { label: 'F-150', retiredAt: new Date('2026-06-30T00:00:00Z') });

    await expect(seedVehicle(t, { label: 'F-150' })).resolves.toBeDefined();
  });

  it('lets two companies each own a vehicle with the same label', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const secondCompanyId = uuidv7();
    await db
      .insert(companies)
      .values({ id: secondCompanyId, accountId: t.accountId, name: 'Plowing Co' });

    await seedVehicle(t, { label: 'F-150' });
    // The same physical truck used by two businesses that file two returns is
    // two disclosures — correct per the form, and why this table is
    // company-scoped rather than account-scoped.
    await expect(
      db.insert(vehicles).values({
        id: uuidv7(),
        accountId: t.accountId,
        companyId: secondCompanyId,
        label: 'F-150',
      }),
    ).resolves.toBeDefined();
  });

  // Same divergence mileage_trips.job_id has, for the same reason: this is tax
  // substantiation, and deleting a vehicle must not destroy the evidence for a
  // deduction already claimed.
  it('keeps the trip when its vehicle is deleted', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    const vehicleId = await seedVehicle(t);
    const tripId = uuidv7();
    await db.insert(mileageTrips).values({
      id: tripId,
      accountId: t.accountId,
      companyId: t.companyId,
      tripDate: '2026-07-15',
      miles: '24.5000',
      purpose: 'Drove to the Miller place',
      vehicleId,
    });

    await db.delete(vehicles).where(eq(vehicles.id, vehicleId));

    const [row] = await db.select().from(mileageTrips).where(eq(mileageTrips.id, tripId));
    expect(row).toBeDefined();
    expect(row?.vehicleId).toBeNull();
    expect(row?.miles).toBe('24.5000');
  });

  it('goes when its company goes', async () => {
    const db = getTestDb();
    const t = await seedTenant();
    await seedVehicle(t);

    await db.delete(companies).where(eq(companies.id, t.companyId));

    const rows = await db.select().from(vehicles).where(eq(vehicles.accountId, t.accountId));
    expect(rows).toHaveLength(0);
  });
});
