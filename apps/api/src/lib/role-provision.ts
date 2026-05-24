import { Pool } from 'pg';

// Promotes the `thalermark_app` role (created NOLOGIN in migration 0005) to
// LOGIN with the given password. Idempotent — ALTER ROLE is safe to re-run on
// every boot, which is the simplest way to rotate the password by redeploy.
//
// Connect string must be a superuser URL (the same one used for migrations);
// non-superusers cannot ALTER ROLE.
export async function provisionAppRole(superuserUrl: string, password: string): Promise<void> {
  // Postgres does not allow bind parameters in DDL, so the password has to
  // be inlined as a literal. We hand-escape per the SQL standard (single
  // quote → two single quotes) — safe under standard_conforming_strings,
  // which is on by default in Postgres ≥9.1 (we target 17). Reject NUL bytes
  // outright since Postgres can't store them in strings and the failure mode
  // is a confusing later error.
  if (password.includes('\0')) {
    throw new Error('THALERMARK_APP_PASSWORD must not contain NUL bytes');
  }
  const quoted = `'${password.replace(/'/g, "''")}'`;
  const pool = new Pool({ connectionString: superuserUrl });
  try {
    await pool.query(`ALTER ROLE thalermark_app WITH LOGIN PASSWORD ${quoted}`);
  } finally {
    await pool.end();
  }
}
