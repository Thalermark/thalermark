import { Pool } from 'pg';

// Promotes a NOLOGIN Postgres role to LOGIN with the given password. Idempotent
// — ALTER ROLE is safe to re-run on every boot, which is the simplest way to
// rotate the password by redeploy.
//
// Connect string must be a superuser URL (the same one used for migrations);
// non-superusers cannot ALTER ROLE. The role name is an internal constant (never
// user input) but is validated as a bare SQL identifier anyway, since it has to
// be inlined — Postgres allows no bind parameters in DDL.
export async function provisionRole(
  superuserUrl: string,
  role: string,
  password: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new Error(`provisionRole: invalid role name '${role}'`);
  }
  // Postgres does not allow bind parameters in DDL, so the password has to be
  // inlined as a literal. We hand-escape per the SQL standard (single quote →
  // two single quotes) — safe under standard_conforming_strings, which is on by
  // default in Postgres ≥9.1 (we target 17). Reject NUL bytes outright since
  // Postgres can't store them in strings and the failure mode is a confusing
  // later error.
  if (password.includes('\0')) {
    throw new Error(`${role} password must not contain NUL bytes`);
  }
  const quoted = `'${password.replace(/'/g, "''")}'`;
  const pool = new Pool({ connectionString: superuserUrl });
  try {
    await pool.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${quoted}`);
  } finally {
    await pool.end();
  }
}

// Promotes the `thalermark_app` runtime role (created NOLOGIN in migration 0005).
export function provisionAppRole(superuserUrl: string, password: string): Promise<void> {
  return provisionRole(superuserUrl, 'thalermark_app', password);
}

// Promotes the `thalermark_pgboss` background-job role (created NOLOGIN in
// migration 0052) so pg-boss no longer needs the superuser DATABASE_URL.
export function provisionPgBossRole(superuserUrl: string, password: string): Promise<void> {
  return provisionRole(superuserUrl, 'thalermark_pgboss', password);
}
