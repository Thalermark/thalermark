-- expenses RLS + extraction_status enum guard.
-- Pairs with the drizzle-generated 0028 that creates the expenses table.
-- Hand-written here because drizzle doesn't emit CHECK constraints from
-- text-column enums.
--
-- Tenant isolation follows the standard NULLIF idiom (see 0007) — uniform
-- with every other domain table. expenses is full-CRUD within the tenant;
-- the SOFT-delete model (deleted_at column, set by the API rather than DROP)
-- keeps history readable, and the journal_entries posted against an expense
-- stay valid via id reference. UPDATE is allowed at the policy level because
-- soft-delete sets deleted_at via UPDATE; the API enforces the once-deleted-
-- always-deleted invariant in application code (no UPDATE after deleted_at
-- is set).
--
-- Staff readonly stays BYPASSRLS + SELECT-only via the role grants from
-- migration 0005.
--
-- amount is CHECKed > 0 in the table definition column-wise (drizzle's
-- numeric column doesn't emit the CHECK, so it's added here). amount = 0
-- has no business meaning for an expense, and a posting helper that gets
-- handed zero would create an unbalanced or single-line journal entry that
-- the L1 sum-to-zero trigger rejects anyway — fail at write rather than at
-- commit.

ALTER TABLE "expenses" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "expenses_tenant_isolation" ON "expenses"
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);

ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_amount_positive_check"
  CHECK (amount > 0);

ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_extraction_status_check"
  CHECK (extraction_status IN ('none', 'pending', 'succeeded', 'failed'));
