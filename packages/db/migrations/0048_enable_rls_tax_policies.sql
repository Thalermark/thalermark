-- tax_policies RLS: tenant-scoped SELECT + INSERT + UPDATE + DELETE for the
-- owning account. Same NULLIF idiom as the other tenant tables (see migration
-- 0007). Staff readonly stays BYPASSRLS + SELECT-only via the role grants from
-- migration 0005; the tax_policies table inherits those via the default
-- privileges set there.
--
-- Tax policies archive (archived_at) rather than hard-delete — there is no
-- DELETE endpoint, so the tax_policy_id breadcrumbs on historical line items
-- never get orphaned. The policy is still the standard full-CRUD tenant fence
-- (uniform with every other domain table); "no DELETE" is an API-surface
-- decision, not an RLS one. Pairs with the drizzle-generated 0047 that creates
-- the table and adds the tax_policy_id FK to items + the three line-item tables.

ALTER TABLE "tax_policies" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tax_policies_tenant_isolation" ON "tax_policies"
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);
