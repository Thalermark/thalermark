import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { provisionAppRole } from '../src/lib/role-provision.js';

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
