import { PgBoss } from 'pg-boss';
import { afterAll, describe, expect, it } from 'vitest';
import { provisionPgBossRole } from '../src/lib/role-provision.js';

// The rest of the suite deliberately never boots pg-boss. This one file does, to
// prove the security split actually works at runtime: pg-boss can start, create
// its queue tables, and run a job while connected as the least-privilege
// thalermark_pgboss role (migration 0052) with createSchema:false — i.e. without
// any superuser / CREATE-on-database privilege. If this regresses, the recurring
// sweep would silently fail to start in production.

const TEST_PASSWORD = 'pgboss_role_test_pw';

function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

describe('pg-boss on the least-privilege thalermark_pgboss role', () => {
  const superuserUrl = process.env.DATABASE_URL;
  if (!superuserUrl) throw new Error('DATABASE_URL not set — global-setup should have set it');
  let boss: PgBoss | undefined;

  afterAll(async () => {
    await boss?.stop({ graceful: false });
  });

  it('starts with createSchema:false and runs a job end-to-end', async () => {
    await provisionPgBossRole(superuserUrl, TEST_PASSWORD);
    const pgBossUrl = withCredentials(superuserUrl, 'thalermark_pgboss', TEST_PASSWORD);

    boss = new PgBoss({ connectionString: pgBossUrl, schema: 'pgboss', createSchema: false });
    // start() runs pg-boss's own table setup inside the pre-created, role-owned
    // schema — proves the role can CREATE there (DDL) without CREATE-on-database.
    await boss.start();

    const queue = 'role-split-probe';
    await boss.createQueue(queue);

    // Round-trip a job to prove the role also has DML on its own tables.
    const ran = new Promise<void>((resolve) => {
      void boss?.work(queue, async () => {
        resolve();
      });
    });
    await boss.send(queue, {});
    await expect(ran).resolves.toBeUndefined();
  });
});
