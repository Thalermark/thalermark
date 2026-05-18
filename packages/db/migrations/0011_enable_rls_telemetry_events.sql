-- telemetry_events RLS: tenant-scoped SELECT + INSERT + UPDATE + DELETE.
-- Unlike audit_events (append-only), telemetry_events is a staging table —
-- the HTTP transport deletes rows on successful send (Slice 2.4) and the
-- opt-out helper purges remaining rows (Slice 2.3), so the app role needs
-- mutation rights within its own tenant scope.
--
-- Staff readonly is BYPASSRLS + SELECT-only, so it can read telemetry from
-- any account for support purposes but cannot mutate it. Default grants from
-- migration 0005 already gave the app role SELECT/INSERT/UPDATE/DELETE on
-- new tables in the public schema.
--
-- Same NULLIF idiom as the other tenant tables (see migration 0007): an unset
-- GUC reads as empty string, which would otherwise fail to cast to uuid.

ALTER TABLE "telemetry_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "telemetry_events_tenant_isolation" ON "telemetry_events"
  USING (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.current_account_id', true), '')::uuid);
