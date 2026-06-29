-- The collapsed 0000_baseline is a pg_dump that empties the session search_path,
-- and drizzle-kit's generated DDL is unqualified — restore it as the first
-- statement so a fresh-DB session can apply this file (0001–0005 do the same).
SET search_path TO public;--> statement-breakpoint
CREATE TABLE "app_rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
-- Infrastructure counter, NOT tenant data: no RLS (the unauthenticated public
-- payment routes hit it with no app.current_account_id set) and no account_id /
-- FK. Keys are namespaced by bucket (see apps/api middleware/rate-limit.ts). The
-- runtime app role runs the fixed-window upsert; no staff_readonly grant —
-- there's nothing to impersonate here.
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE "app_rate_limit" TO thalermark_app;
