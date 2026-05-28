-- chart_of_accounts / journal_entries / journal_lines RLS + integrity.
-- Pairs with the drizzle-generated 0025 that creates the three tables and
-- adds companies.business_type. Hand-written here because drizzle doesn't
-- emit CHECK constraints from text-column enums or DEFERRABLE constraint
-- triggers.
--
-- Tenant isolation follows the standard NULLIF idiom (see 0007) — uniform
-- with every other domain table. chart_of_accounts is full-CRUD within the
-- tenant (operators rename / deactivate accounts). journal_entries and
-- journal_lines are append-only: only SELECT + INSERT policies are
-- declared, so UPDATE and DELETE fall through to RLS-default-deny for the
-- app role. Mistakes get corrected with reversing entries, not mutation.
--
-- Staff readonly stays BYPASSRLS + SELECT-only via the role grants from
-- migration 0005.

-- ----- chart_of_accounts -----

ALTER TABLE "chart_of_accounts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chart_of_accounts_tenant_isolation" ON "chart_of_accounts"
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);

ALTER TABLE "chart_of_accounts"
  ADD CONSTRAINT "chart_of_accounts_account_type_check"
  CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense'));

ALTER TABLE "chart_of_accounts"
  ADD CONSTRAINT "chart_of_accounts_normal_balance_check"
  CHECK (normal_balance IN ('debit', 'credit'));

-- ----- journal_entries -----

ALTER TABLE "journal_entries" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "journal_entries_account_select" ON "journal_entries"
  FOR SELECT
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);

CREATE POLICY "journal_entries_account_insert" ON "journal_entries"
  FOR INSERT
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);

-- ----- journal_lines -----

ALTER TABLE "journal_lines" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "journal_lines_account_select" ON "journal_lines"
  FOR SELECT
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);

CREATE POLICY "journal_lines_account_insert" ON "journal_lines"
  FOR INSERT
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_side_check"
  CHECK (side IN ('debit', 'credit'));

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_amount_positive_check"
  CHECK (amount > 0);

-- ----- balance invariant -----
--
-- Every journal_entry must, at commit, satisfy:
--   1. SUM(CASE side WHEN 'debit' THEN amount ELSE -amount END) = 0
--   2. COUNT(lines) >= 2  (a single-line entry can only balance at amount=0,
--      which the amount-positive check already blocks, but the count guard
--      catches zero-line entries explicitly)
--
-- Implemented as a deferrable constraint trigger AFTER INSERT/UPDATE/DELETE
-- on journal_lines, so the posting helper can write the header + N lines in
-- any order and the invariant is verified once at commit. Plain CHECK
-- constraints can't reference other rows, and ordinary triggers fire
-- mid-statement which would block valid multi-line writes.
--
-- The function joins back to journal_entries via LEFT JOIN so a cascaded
-- delete of the parent entry (lines disappear with it) passes the check:
-- the entry is gone, the GROUP BY yields no row, no violation raised.

CREATE OR REPLACE FUNCTION journal_entry_balance_check()
RETURNS trigger AS $$
DECLARE
  affected_entry_id uuid := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  bad_entry uuid;
BEGIN
  SELECT je.id
    INTO bad_entry
    FROM journal_entries je
    LEFT JOIN journal_lines jl ON jl.journal_entry_id = je.id
    WHERE je.id = affected_entry_id
    GROUP BY je.id
    HAVING COUNT(jl.id) < 2
        OR SUM(CASE jl.side WHEN 'debit' THEN jl.amount ELSE -jl.amount END) <> 0;
  IF bad_entry IS NOT NULL THEN
    RAISE EXCEPTION
      'journal_entry % is unbalanced or has fewer than 2 lines', bad_entry
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "journal_lines_balance_check"
  AFTER INSERT OR UPDATE OR DELETE ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION journal_entry_balance_check();
