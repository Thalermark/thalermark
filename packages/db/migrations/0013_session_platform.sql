-- The collapsed 0000_baseline is a pg_dump that empties the session search_path,
-- and hand-written DDL here is unqualified — restore it as the first statement so
-- a fresh-DB session can apply this file (0001–0012 do the same).
SET search_path TO public;--> statement-breakpoint
-- Session-origin tag for scoped revocation (TMCLD-102). Nullable metadata in the
-- same class as ip_address / user_agent — captured for every session, no RLS. No
-- grant changes: a new COLUMN on auth_session inherits the table's existing
-- privileges, and unlike a new TABLE it isn't reached by baseline's ALTER DEFAULT
-- PRIVILEGES, so the staff-readonly REVOKE that 0012 / llm_connections apply to
-- credential-bearing tables isn't needed (platform is non-secret: 'web'|'mobile').
ALTER TABLE "auth_session" ADD COLUMN "platform" text;
