import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { provisionAppRole, provisionPgBossRole } from '../src/lib/role-provision.js';

// Verifies that provisionAppRole flips thalermark_app to LOGIN and that a
// pool opened with the resulting credentials authenticates as that role.
// Together this asserts the production boot path actually swaps off the
// superuser identity that the rest of the api integration tests still use.

const TEST_PASSWORD = 'role_provision_test_pw';

function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

describe('provisionAppRole', () => {
  const superuserUrl = process.env.DATABASE_URL;
  if (!superuserUrl) throw new Error('DATABASE_URL not set — global-setup should have set it');
  const appUrl = withCredentials(superuserUrl, 'thalermark_app', TEST_PASSWORD);
  let appPool: Pool | undefined;

  afterAll(async () => {
    await appPool?.end();
  });

  it('promotes thalermark_app to LOGIN with the given password', async () => {
    await provisionAppRole(superuserUrl, TEST_PASSWORD);
    appPool = new Pool({ connectionString: appUrl });
    const result = await appPool.query<{ current_user: string }>('SELECT current_user');
    expect(result.rows[0]?.current_user).toBe('thalermark_app');
  });

  it('is idempotent — a second call rotates the password without error', async () => {
    await provisionAppRole(superuserUrl, TEST_PASSWORD);
    const rotated = `${TEST_PASSWORD}_v2`;
    await provisionAppRole(superuserUrl, rotated);
    const pool = new Pool({
      connectionString: withCredentials(superuserUrl, 'thalermark_app', rotated),
    });
    try {
      const result = await pool.query<{ current_user: string }>('SELECT current_user');
      expect(result.rows[0]?.current_user).toBe('thalermark_app');
    } finally {
      await pool.end();
    }
    // Restore the original password so the rest of the file (and any sibling
    // test runs sharing the container) keep working.
    await provisionAppRole(superuserUrl, TEST_PASSWORD);
  });
});

describe('provisionPgBossRole', () => {
  const superuserUrl = process.env.DATABASE_URL;
  if (!superuserUrl) throw new Error('DATABASE_URL not set — global-setup should have set it');
  const pgBossUrl = withCredentials(superuserUrl, 'thalermark_pgboss', TEST_PASSWORD);
  let pool: Pool | undefined;

  afterAll(async () => {
    await pool?.end();
  });

  it('promotes thalermark_pgboss to LOGIN, but NOT to superuser/BYPASSRLS', async () => {
    await provisionPgBossRole(superuserUrl, TEST_PASSWORD);
    pool = new Pool({ connectionString: pgBossUrl });
    const who = await pool.query<{ current_user: string }>('SELECT current_user');
    expect(who.rows[0]?.current_user).toBe('thalermark_pgboss');
    // The whole point of the split: the job runner's role must not be able to
    // bypass tenant isolation.
    const attrs = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(attrs.rows[0]?.rolsuper).toBe(false);
    expect(attrs.rows[0]?.rolbypassrls).toBe(false);
  });

  it('owns its pgboss schema but cannot read tenant tables', async () => {
    await provisionPgBossRole(superuserUrl, TEST_PASSWORD);
    const p = new Pool({ connectionString: pgBossUrl });
    try {
      // Owns the schema migration 0052 created — can create objects in it.
      const canCreate = await p.query<{ has: boolean }>(
        "SELECT has_schema_privilege('thalermark_pgboss', 'pgboss', 'CREATE') AS has",
      );
      expect(canCreate.rows[0]?.has).toBe(true);
      // No grant on the public tenant tables → the privilege check rejects
      // before RLS even applies. This is the isolation guarantee.
      await expect(p.query('SELECT 1 FROM accounts LIMIT 1')).rejects.toThrow(/permission denied/i);
    } finally {
      await p.end();
    }
  });
});
