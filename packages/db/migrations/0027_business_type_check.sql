-- companies.business_type CHECK constraint. Column itself landed in 0025
-- (slice L1) as a free-text nullable column. Slice L3 surfaces a wizard
-- that writes one of five enum-shaped values; this constraint pins the
-- column to that set so a stray write can't smuggle in a value the v1.x
-- entity-aware seeder won't recognise.
--
-- Null stays allowed: existing rows pre-wizard carry null, and the seeder
-- falls back to the sole-prop COA on null per [[project_ledger_decision]].

ALTER TABLE "companies"
  ADD CONSTRAINT "companies_business_type_check"
  CHECK (
    business_type IS NULL
    OR business_type IN (
      'sole_prop',
      'llc_single_member',
      'partnership',
      's_corp',
      'c_corp'
    )
  );
