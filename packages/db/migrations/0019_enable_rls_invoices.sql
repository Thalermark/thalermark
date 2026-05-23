-- invoices + invoice_line_items RLS: tenant-scoped CRUD for the owning
-- account. Same NULLIF idiom as the other domain tables (see migration 0007).
-- Staff readonly stays BYPASSRLS + SELECT-only via the role grants from
-- migration 0005.
--
-- Both tables carry account_id directly. invoice_line_items could in theory
-- derive its tenant from invoices via the invoice_id FK, but the standard
-- NULLIF idiom is uniform across the codebase (audit_events and
-- telemetry_events both denormalize the same way) — uniformity beats the
-- one column of duplication, and avoids a subquery on every RLS check.

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invoices_tenant_isolation" ON "invoices"
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);

ALTER TABLE "invoice_line_items" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invoice_line_items_tenant_isolation" ON "invoice_line_items"
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);
