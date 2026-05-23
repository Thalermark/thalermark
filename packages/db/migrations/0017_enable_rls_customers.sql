-- customers RLS: tenant-scoped SELECT + INSERT + UPDATE + DELETE for the
-- owning account. Same NULLIF idiom as the other tenant tables (see migration
-- 0007). Staff readonly is BYPASSRLS + SELECT-only via the role grants from
-- migration 0005.
--
-- Customers carry both account_id (RLS key) and company_id (FK only). RLS
-- enforces account isolation; cross-company access within an account is a
-- product-level concern handled at the API layer once per-company permissions
-- land (v1.1, per PROJECT.md). The app role still needs DELETE rights —
-- unlike audit/telemetry, customers are user-mutable and may be hard-deleted
-- when they have no invoices yet.

ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customers_tenant_isolation" ON "customers"
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);
