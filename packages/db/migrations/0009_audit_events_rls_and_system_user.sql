-- audit_events RLS: SELECT and INSERT are scoped to the request's account_id;
-- UPDATE and DELETE have no policy and are therefore denied under RLS, which
-- is what makes the table append-only for the app role. Staff readonly is
-- BYPASSRLS and only holds SELECT grants, so it can read the audit trail
-- across accounts but still cannot mutate it.
--
-- Same NULLIF idiom as the other tenant tables (see migration 0007): an unset
-- GUC reads as empty string, which would otherwise fail to cast to uuid.

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_events_account_select" ON "audit_events"
  FOR SELECT
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);

CREATE POLICY "audit_events_account_insert" ON "audit_events"
  FOR INSERT
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);

-- Synthetic system actor for mutations with no human in the loop (recurring
-- invoice auto-generation, Stripe webhook handlers, future bank-feed imports).
-- The email is at a domain we own but don't accept mail for, and there is no
-- auth_account row, so there is no path to authenticate as this user.
-- Deterministic UUID so application code can reference it by constant.
INSERT INTO "auth_user" ("id", "email", "email_verified", "name", "is_staff", "is_system")
VALUES (
  '00000000-0000-7000-8000-000000000001',
  'system@thalermark.internal',
  false,
  'System',
  false,
  true
)
ON CONFLICT ("id") DO NOTHING;
