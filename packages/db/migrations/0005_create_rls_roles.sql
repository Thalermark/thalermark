-- Two non-superuser Postgres roles for the Thalermark API:
--   thalermark_app           — RLS-enforcing; used for normal customer requests
--   thalermark_staff_readonly — BYPASSRLS + SELECT-only; used for staff impersonation
--
-- Roles are created with NOLOGIN; the deployment provisions a LOGIN role
-- (e.g. thalermark_api) that INHERITs from these. That keeps the privilege
-- contract in this migration and the password/host config in deployment.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thalermark_app') THEN
    CREATE ROLE thalermark_app NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thalermark_staff_readonly') THEN
    CREATE ROLE thalermark_staff_readonly NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO thalermark_app, thalermark_staff_readonly;

-- App role: full CRUD on existing and future tables, subject to RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO thalermark_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO thalermark_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO thalermark_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO thalermark_app;

-- Staff role: SELECT only. BYPASSRLS lets support see across all accounts;
-- the absence of write grants is the second layer that keeps it read-only.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO thalermark_staff_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO thalermark_staff_readonly;
