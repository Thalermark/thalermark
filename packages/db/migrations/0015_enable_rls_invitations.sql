-- invitations RLS: tenant-scoped SELECT + INSERT + UPDATE for the inviting
-- account. The accept endpoint runs *outside* RLS context (bootstrap pattern,
-- see apps/api rls-context middleware) because the accepting user is not yet
-- a member, so no invitee-side policy is needed here. UPDATE is allowed so
-- account members can revoke pending invites (stamping a future deleted_at,
-- post-MVP) — the accept-side mutation also runs as bootstrap/superuser.
--
-- Same NULLIF idiom as the other tenant tables (see migration 0007).

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invitations_tenant_isolation" ON "invitations"
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);
