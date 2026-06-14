-- email_templates RLS: tenant-scoped SELECT + INSERT + UPDATE + DELETE for the
-- owning account. Same NULLIF idiom as the other tenant tables (see migration
-- 0007). Staff readonly stays BYPASSRLS + SELECT-only via the role grants from
-- migration 0005; this table inherits those via the default privileges set
-- there.
--
-- A row is an OVERRIDE of the in-code default copy; an empty table is the
-- normal zero-config state (self-host needs no seeding). DELETE = "reset to
-- default". The standard full-CRUD tenant fence applies (uniform with every
-- other domain table). Pairs with the drizzle-generated 0043 that creates the
-- table.

ALTER TABLE "email_templates" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "email_templates_tenant_isolation" ON "email_templates"
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);
