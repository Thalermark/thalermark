-- Enable row-level security on tenant-scoped tables and install policies that
-- isolate rows to the current request's account_id.
--
-- Request convention: the API wraps every request in a transaction and runs
--   SET LOCAL app.current_account_id = '<uuid>';
--   SET LOCAL app.current_user_id    = '<uuid>';
-- before any query. The policies below read those GUCs with missing_ok=true,
-- so an unset GUC reads as NULL and the comparison fails closed (no rows).
--
-- The `thalermark_app` role is subject to these policies because it is not the
-- table owner and lacks BYPASSRLS. The `thalermark_staff_readonly` role has
-- BYPASSRLS and is the supported path for staff impersonation; do NOT widen
-- the policies below to accommodate it.
--
-- auth_* tables are intentionally left without RLS: Better Auth queries them
-- directly with user-id filters and they are not account-scoped.

ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "accounts_tenant_isolation" ON "accounts"
  USING (id = current_setting('app.current_account_id', true)::uuid)
  WITH CHECK (id = current_setting('app.current_account_id', true)::uuid);

CREATE POLICY "companies_tenant_isolation" ON "companies"
  USING (account_id = current_setting('app.current_account_id', true)::uuid)
  WITH CHECK (account_id = current_setting('app.current_account_id', true)::uuid);

-- Memberships need two visibility rules combined with OR (PERMISSIVE policies
-- are ORed together): the normal account-scoped view, plus a user-scoped view
-- for the auth-bootstrap "list my accounts" flow before an account context is
-- chosen. Writes still require the account context — only SELECT is widened.
CREATE POLICY "memberships_account_scope" ON "memberships"
  USING (account_id = current_setting('app.current_account_id', true)::uuid)
  WITH CHECK (account_id = current_setting('app.current_account_id', true)::uuid);

CREATE POLICY "memberships_user_self_select" ON "memberships"
  FOR SELECT
  USING (user_id = current_setting('app.current_user_id', true)::uuid);
