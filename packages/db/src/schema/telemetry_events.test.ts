import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { accounts } from './accounts.js';
import { telemetryEvents } from './telemetry_events.js';

async function seedAccount() {
  const db = getTestDb();
  const accountId = uuidv7();
  await db.insert(accounts).values({ id: accountId, name: 'Acct' });
  return accountId;
}

describe('telemetry_events — schema', () => {
  beforeEach(resetDb);

  it('inserts and reads back an event with jsonb payload', async () => {
    const db = getTestDb();
    const accountId = await seedAccount();
    const id = uuidv7();

    await db.insert(telemetryEvents).values({
      id,
      accountId,
      eventName: 'invoice_created',
      payload: { line_item_count: 3 },
    });

    const rows = await db.select().from(telemetryEvents).where(eq(telemetryEvents.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventName).toBe('invoice_created');
    expect(rows[0]?.payload).toEqual({ line_item_count: 3 });
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('accepts an empty-object payload for events with no fields', async () => {
    const db = getTestDb();
    const accountId = await seedAccount();
    const id = uuidv7();

    await db.insert(telemetryEvents).values({
      id,
      accountId,
      eventName: 'invoice_marked_paid',
      payload: {},
    });

    const rows = await db.select().from(telemetryEvents).where(eq(telemetryEvents.id, id));
    expect(rows[0]?.payload).toEqual({});
  });

  it('rejects rows with no matching account (FK violation)', async () => {
    const db = getTestDb();
    await expect(
      db.insert(telemetryEvents).values({
        id: uuidv7(),
        accountId: uuidv7(),
        eventName: 'invoice_created',
        payload: { line_item_count: 1 },
      }),
    ).rejects.toThrow();
  });
});
