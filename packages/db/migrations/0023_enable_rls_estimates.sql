-- estimates + estimate_line_items RLS: tenant-scoped CRUD for the owning
-- account. Same NULLIF idiom as the rest of the domain tables (see migrations
-- 0007 / 0019). Staff readonly stays BYPASSRLS + SELECT-only via the role
-- grants from migration 0005.
--
-- Both tables carry account_id directly. estimate_line_items could in theory
-- derive its tenant from estimates via the estimate_id FK, but uniformity with
-- the rest of the schema (audit_events, telemetry_events, invoice_line_items)
-- wins — one denormalized column beats a join on every RLS check.

ALTER TABLE "estimates" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "estimates_tenant_isolation" ON "estimates"
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);

ALTER TABLE "estimate_line_items" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "estimate_line_items_tenant_isolation" ON "estimate_line_items"
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);
