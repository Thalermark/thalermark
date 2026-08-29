-- An account's KIND and its DIRECTION must agree.
--
-- Every chart_of_accounts row carries two labels: what the account is
-- (account_type) and which way its balance grows (normal_balance). The balance
-- sheet reads BOTH — the sign comes from normal_balance, the bucket from
-- account_type:
--
--   sum(case when line.side = coa.normal_balance then amount else -amount end)
--
-- If the two disagree, the amount lands in the right bucket with the wrong sign,
-- and Assets = Liabilities + Equity quietly stops holding. Nothing else notices:
-- every journal entry still balances, the trigger is satisfied, and the trial
-- balance still sums to zero, because those check the ENTRIES rather than the
-- account definitions. The only symptom is a report that no longer adds up,
-- months later, seen by whoever happens to open it.
--
-- Until now each column was constrained separately (valid enum values) with
-- nothing tying the pair together, so the bad combination was writable. The
-- realistic way in is not a typo but a fall-through: routes/money-accounts.ts
-- mapped credit_card to liability/credit and EVERYTHING ELSE to asset/debit, so
-- the next money-account kind that is a liability would have been filed as an
-- asset without anyone editing that line.
--
-- ACCUMULATED DEPRECIATION IS NOT AN EXCEPTION, though it looks like one. It is
-- a contra-asset and textbooks give it a credit balance, which this constraint
-- would refuse. Thalermark models it as asset/debit (code 1900) carrying a
-- naturally NEGATIVE balance, because its credits exceed its debits — which
-- subtracts from total assets and is arithmetically identical. Verified against
-- both dev and the live cloud instance before writing this: zero rows violate it.
--
-- If a future contra account genuinely needs the textbook shape, this constraint
-- is the thing that will stop it, and that is deliberate: it forces the decision
-- to be made once, here, rather than discovered on a balance sheet.
SET search_path TO public;--> statement-breakpoint
-- NOT VALID first: adding a validated CHECK takes a lock while it scans every
-- row. Split so the write path is protected immediately and the backfill scan
-- happens under a weaker lock in the next statement.
ALTER TABLE "chart_of_accounts"
  ADD CONSTRAINT "chart_of_accounts_type_balance_check"
  CHECK (
    (account_type IN ('asset', 'expense') AND normal_balance = 'debit')
    OR (account_type IN ('liability', 'equity', 'revenue') AND normal_balance = 'credit')
  ) NOT VALID;--> statement-breakpoint
ALTER TABLE "chart_of_accounts" VALIDATE CONSTRAINT "chart_of_accounts_type_balance_check";
