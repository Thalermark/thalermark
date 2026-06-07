-- items RLS: tenant-scoped SELECT + INSERT + UPDATE + DELETE for the owning
-- account. Same NULLIF idiom as the other tenant tables (see migration 0007).
-- Staff readonly stays BYPASSRLS + SELECT-only via the role grants from
-- migration 0005; the items table inherits those via the default privileges
-- set there.
--
-- Items archive (archived_at) rather than hard-delete — there is no DELETE
-- endpoint, so the report's source_item_id breadcrumbs never get orphaned.
-- The policy is still the standard full-CRUD tenant fence (uniform with every
-- other domain table); "no DELETE" is an API-surface decision, not an RLS one.
-- Pairs with the drizzle-generated 0038 that creates the table and adds the
-- source_item_id provenance FK to the three line-item tables.

ALTER TABLE "items" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "items_tenant_isolation" ON "items"
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);
