-- Fix to migration 0006: current_setting(name, missing_ok=true) returns the
-- empty string when the GUC is unset, NOT NULL. Casting '' to uuid throws
-- '22P02 invalid input syntax for type uuid', which surfaces as a query error
-- instead of silently returning zero rows ("fail closed"). Wrap each
-- current_setting() in NULLIF(..., '') so an unset GUC becomes NULL and the
-- comparison evaluates to NULL → false → row excluded, no error.

DROP POLICY "accounts_tenant_isolation" ON "accounts";
DROP POLICY "companies_tenant_isolation" ON "companies";
DROP POLICY "memberships_account_scope" ON "memberships";
DROP POLICY "memberships_user_self_select" ON "memberships";

CREATE POLICY "accounts_tenant_isolation" ON "accounts"
  USING (id = NULLIF(current_setting('app.current_account_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);

CREATE POLICY "companies_tenant_isolation" ON "companies"
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);

CREATE POLICY "memberships_account_scope" ON "memberships"
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);

CREATE POLICY "memberships_user_self_select" ON "memberships"
  FOR SELECT
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
