import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { getTestDb } from '../tests/db-test-helper.js';
import { withAccountContext } from './client.js';

// Slice 1.4 smoke tests — proves the bones are in place. The full RLS
// isolation matrix (cross-tenant blocks, staff bypass) lands in Slice 1.5,
// where tests connect as the unprivileged thalermark_app role.

describe('RLS foundations — Postgres roles', () => {
  it('creates thalermark_app with no BYPASSRLS', async () => {
    const db = getTestDb();
    const result = await db.execute<{ rolname: string; rolbypassrls: boolean }>(
      sql`SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'thalermark_app'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.rolbypassrls).toBe(false);
  });

  it('creates thalermark_staff_readonly with BYPASSRLS', async () => {
    const db = getTestDb();
    const result = await db.execute<{ rolname: string; rolbypassrls: boolean }>(
      sql`SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'thalermark_staff_readonly'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.rolbypassrls).toBe(true);
  });

  it('grants only SELECT on tables to the staff readonly role', async () => {
    const db = getTestDb();
    const result = await db.execute<{ privilege_type: string }>(sql`
      SELECT DISTINCT privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'thalermark_staff_readonly' AND table_schema = 'public'
    `);
    const privs = result.rows.map((r) => r.privilege_type).sort();
    expect(privs).toEqual(['SELECT']);
  });
});

describe('RLS foundations — row security enabled', () => {
  it('enables row security on accounts, companies, memberships', async () => {
    const db = getTestDb();
    const result = await db.execute<{ tablename: string; rowsecurity: boolean }>(sql`
      SELECT tablename, rowsecurity
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('accounts', 'companies', 'memberships')
      ORDER BY tablename
    `);
    expect(result.rows).toEqual([
      { tablename: 'accounts', rowsecurity: true },
      { tablename: 'companies', rowsecurity: true },
      { tablename: 'memberships', rowsecurity: true },
    ]);
  });
});

describe('withAccountContext', () => {
  it('sets app.current_account_id inside the transaction', async () => {
    const db = getTestDb();
    const accountId = uuidv7();

    const seen = await withAccountContext(db, { accountId }, async (tx) => {
      const r = await tx.execute<{ current_setting: string }>(
        sql`SELECT current_setting('app.current_account_id', true)`,
      );
      return r.rows[0]?.current_setting;
    });

    expect(seen).toBe(accountId);
  });

  it('sets app.current_user_id when provided', async () => {
    const db = getTestDb();
    const accountId = uuidv7();
    const userId = uuidv7();

    const seen = await withAccountContext(db, { accountId, userId }, async (tx) => {
      const r = await tx.execute<{ current_setting: string }>(
        sql`SELECT current_setting('app.current_user_id', true)`,
      );
      return r.rows[0]?.current_setting;
    });

    expect(seen).toBe(userId);
  });

  it('isolates the GUC to the transaction (later queries see no account)', async () => {
    const db = getTestDb();
    const accountId = uuidv7();

    await withAccountContext(db, { accountId }, async () => {
      // no-op — just to set and tear down the GUC
    });

    const after = await db.execute<{ current_setting: string }>(
      sql`SELECT current_setting('app.current_account_id', true)`,
    );
    // missing_ok=true returns empty string when unset at session scope
    expect(after.rows[0]?.current_setting).toBe('');
  });
});
