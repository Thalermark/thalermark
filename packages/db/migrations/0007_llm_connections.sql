-- The collapsed 0000_baseline is a pg_dump that empties the session search_path,
-- and drizzle-kit's generated DDL is unqualified — restore it as the first
-- statement so a fresh-DB session can apply this file (0001–0006 do the same).
SET search_path TO public;--> statement-breakpoint
CREATE TABLE "llm_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"base_url" text,
	"api_key_ciphertext" text,
	"model_vision" text,
	"model_reasoning" text,
	"model_fast" text,
	"structured" boolean,
	"last_ok_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_connections" ADD CONSTRAINT "llm_connections_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_connections" ADD CONSTRAINT "llm_connections_updated_by_auth_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- One connection per account. Also serves the resolver's per-call lookup and the
-- RLS policy's account_id filter, so no separate btree index is needed.
CREATE UNIQUE INDEX "llm_connections_account_uq" ON "llm_connections" USING btree ("account_id");--> statement-breakpoint
-- Row-level tenant isolation — same NULLIF idiom as every other tenant table.
-- drizzle-kit generate emits only table/FK/index DDL; RLS + grants live in
-- hand-written SQL (the policy model is not declared in the Drizzle schema).
ALTER TABLE "llm_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "llm_connections_tenant_isolation" ON "llm_connections" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "llm_connections" TO thalermark_app;--> statement-breakpoint
-- Deliberately NOT granted to thalermark_staff_readonly, unlike every other
-- tenant table. This REVOKE is load-bearing, not decorative: 0000_baseline runs
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO
-- thalermark_staff_readonly`, so a new table is granted SELECT automatically.
-- This row holds an encrypted third-party API key; read-only support
-- impersonation has no reason to reach it, and keeping the secret outside that
-- surface entirely is cheaper than reasoning about whether the ciphertext is
-- harmless without the key. If impersonation ever needs to show AI health, add
-- a column-level grant that excludes api_key_ciphertext rather than widening
-- this back to the whole table.
REVOKE ALL ON TABLE "llm_connections" FROM thalermark_staff_readonly;
