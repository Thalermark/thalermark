-- Depreciation chart-of-accounts backfill. Adds two accounts the manual-
-- adjustment portal ("The Ledger") posts the year-end depreciation figure to:
--   6350 Depreciation Expense    (expense, debit-normal, Schedule C line 13)
--   1900 Accumulated Depreciation (CONTRA-asset; see below)
-- New companies get both from the updated SOLE_PROP_COA seed; this backfills
-- companies created before this migration. Pure data backfill, no DDL.
--
-- Accumulated Depreciation is a contra-asset (it carries a credit balance,
-- netting against gross assets), but we seed its normal_balance as 'debit'.
-- The balance-sheet/P&L code nets each account in its normal_balance direction;
-- 'debit' makes a credit posting come out negative, so the account reduces
-- total assets and Assets = Liabilities + Equity still holds with no contra
-- special-casing. The GL/trial-balance export reads the actual posting `side`,
-- so it still shows the real credit balance — normal_balance is display-only.
-- This mirrors the SOLE_PROP_COA seed comment.
--
-- Idempotent via NOT EXISTS on (company_id, code), matching 0001's AP backfill.
-- The empty search_path the pg_dump baseline leaves behind is already restored
-- by 0001 for the session, but set it again so this file is safe to apply on
-- its own.
SET search_path TO public;--> statement-breakpoint
INSERT INTO "chart_of_accounts" ("id", "account_id", "company_id", "code", "name", "account_type", "normal_balance", "tax_mapping", "is_active")
SELECT gen_random_uuid(), c."account_id", c."id", '1900', 'Accumulated Depreciation', 'asset', 'debit', NULL, true
FROM "companies" c
WHERE NOT EXISTS (
  SELECT 1 FROM "chart_of_accounts" coa WHERE coa."company_id" = c."id" AND coa."code" = '1900'
);--> statement-breakpoint
INSERT INTO "chart_of_accounts" ("id", "account_id", "company_id", "code", "name", "account_type", "normal_balance", "tax_mapping", "is_active")
SELECT gen_random_uuid(), c."account_id", c."id", '6350', 'Depreciation Expense', 'expense', 'debit', 'Schedule C, Line 13', true
FROM "companies" c
WHERE NOT EXISTS (
  SELECT 1 FROM "chart_of_accounts" coa WHERE coa."company_id" = c."id" AND coa."code" = '6350'
);
