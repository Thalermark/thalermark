-- recurring_invoices + recurring_invoice_line_items RLS, plus the frequency /
-- status / interval CHECK constraints drizzle does not emit from text/integer
-- columns. Pairs with the drizzle-generated 0032 that creates the tables.
--
-- Tenant isolation follows the standard NULLIF idiom (see 0007) — uniform with
-- every other domain table. Schedules are full-CRUD within the tenant; the
-- background sweeper writes generated invoices under the tenant's own context
-- (withAccountContext), so the policy gates it like any other write.
--
-- Staff readonly stays BYPASSRLS + SELECT-only via the role grants from
-- migration 0005.
--
-- frequency / status are constrained to their enums; interval_count and
-- net_terms_days are positive (interval_count > 0 has no meaning at 0 — a
-- schedule that never advances; net_terms_days >= 0 allows "due on receipt").
-- occurrence_count and max_occurrences guard against negatives.

ALTER TABLE "recurring_invoices" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "recurring_invoices_tenant_isolation" ON "recurring_invoices"
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);

ALTER TABLE "recurring_invoice_line_items" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "recurring_invoice_line_items_tenant_isolation" ON "recurring_invoice_line_items"
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);

ALTER TABLE "recurring_invoices"
  ADD CONSTRAINT "recurring_invoices_frequency_check"
  CHECK (frequency IN ('weekly', 'monthly', 'yearly'));

ALTER TABLE "recurring_invoices"
  ADD CONSTRAINT "recurring_invoices_status_check"
  CHECK (status IN ('active', 'paused', 'ended'));

ALTER TABLE "recurring_invoices"
  ADD CONSTRAINT "recurring_invoices_interval_count_positive_check"
  CHECK (interval_count > 0);

ALTER TABLE "recurring_invoices"
  ADD CONSTRAINT "recurring_invoices_net_terms_days_nonneg_check"
  CHECK (net_terms_days >= 0);

ALTER TABLE "recurring_invoices"
  ADD CONSTRAINT "recurring_invoices_occurrence_count_nonneg_check"
  CHECK (occurrence_count >= 0);

ALTER TABLE "recurring_invoices"
  ADD CONSTRAINT "recurring_invoices_max_occurrences_positive_check"
  CHECK (max_occurrences IS NULL OR max_occurrences > 0);
