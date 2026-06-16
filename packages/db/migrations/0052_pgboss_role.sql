-- Dedicated, least-privilege Postgres role for pg-boss (the background-job
-- queue). pg-boss previously ran on the superuser DATABASE_URL, so an api
-- RCE/SSRF would inherit BYPASSRLS and defeat tenant isolation. This role owns
-- ONLY its own `pgboss` schema: NOT a superuser, no BYPASSRLS, and no grants on
-- the public (tenant) tables. The api connects pg-boss with PGBOSS_DATABASE_URL
-- pointed here; pg-boss is started with createSchema:false, so it never needs
-- CREATE on the database — owning the schema below is all the privilege it needs.
--
-- Mirrors the thalermark_app pattern (migration 0005): created NOLOGIN so the
-- privilege contract lives in the migration, and the deployment promotes it to
-- LOGIN with a password at boot via provisionRole() (THALERMARK_PGBOSS_PASSWORD).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thalermark_pgboss') THEN
    CREATE ROLE thalermark_pgboss NOLOGIN NOINHERIT;
  END IF;
END
$$;

-- Owning the schema is the entire privilege grant: pg-boss can create and manage
-- its queue tables/types/functions inside it and nothing else.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION thalermark_pgboss;

-- If the schema already existed (e.g. a dev DB where pg-boss first ran as the
-- superuser), re-own it so the role can manage it. Objects created earlier keep
-- their original owner; on a pre-alpha / dev DB the clean reset is
-- `DROP SCHEMA pgboss CASCADE` before migrating.
ALTER SCHEMA pgboss OWNER TO thalermark_pgboss;
