-- The collapsed 0000_baseline is a pg_dump that empties the session search_path,
-- and drizzle-kit's generated DDL is unqualified — restore it as the first
-- statement so a fresh-DB session can apply this file (0001–0008 do the same).
SET search_path TO public;--> statement-breakpoint
CREATE TABLE "legal_acceptances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"terms_version" text NOT NULL,
	"terms_url" text NOT NULL,
	"privacy_version" text NOT NULL,
	"privacy_url" text NOT NULL,
	"account_id" uuid,
	"ip" text,
	"user_agent" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legal_acceptances_user_id_idx" ON "legal_acceptances" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_acceptances_user_version_uq" ON "legal_acceptances" USING btree ("user_id","terms_version","privacy_version");--> statement-breakpoint
-- USER-scoped RLS (defense-in-depth). This table is keyed on the person, not the
-- tenant, so it uses the app.current_user_id GUC — the same idiom as
-- memberships_user_self_select — rather than app.current_account_id. Routes read
-- and write it via the bootstrap (RLS-bypass) handle since acceptance can precede
-- account selection; these policies fence any app-role access. drizzle-kit emits
-- only table/FK/index DDL; RLS + grants are hand-written.
ALTER TABLE "legal_acceptances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "legal_acceptances_user_self_select" ON "legal_acceptances" FOR SELECT USING ((user_id = (NULLIF(current_setting('app.current_user_id'::text, true), ''::text))::uuid));--> statement-breakpoint
CREATE POLICY "legal_acceptances_user_self_insert" ON "legal_acceptances" FOR INSERT WITH CHECK ((user_id = (NULLIF(current_setting('app.current_user_id'::text, true), ''::text))::uuid));--> statement-breakpoint
-- Append-only: SELECT + INSERT only, no UPDATE/DELETE policy (same rule as
-- audit_events) — an acceptance is a permanent historical fact.
GRANT SELECT,INSERT ON TABLE "legal_acceptances" TO thalermark_app;--> statement-breakpoint
-- Deliberately NOT granted to thalermark_staff_readonly. 0000_baseline runs
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO
-- thalermark_staff_readonly`, so a new table is auto-granted SELECT; this row
-- carries PII (ip / user_agent on the commercial build), and read-only support
-- impersonation has no reason to reach a person's legal-consent record — same
-- REVOKE as llm_connections (0007).
REVOKE ALL ON TABLE "legal_acceptances" FROM thalermark_staff_readonly;
