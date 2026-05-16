import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from '../../tests/db-test-helper.js';
import { accounts } from './accounts.js';

describe('accounts', () => {
  beforeEach(resetDb);

  it('inserts and reads back an account', async () => {
    const db = getTestDb();
    const id = uuidv7();

    await db.insert(accounts).values({ id, name: 'Test Account' });

    const rows = await db.select().from(accounts).where(eq(accounts.id, id));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(id);
    expect(rows[0]?.name).toBe('Test Account');
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    expect(rows[0]?.updatedAt).toBeInstanceOf(Date);
  });
});
