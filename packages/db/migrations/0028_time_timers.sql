-- A running stopwatch (TMC-180). A row exists only while a timer runs.
--
-- PER JOB, but ONE AT A TIME PER PERSON — the unique index on
-- (account_id, user_id) makes a second concurrent timer impossible rather than
-- merely discouraged. Starting a second one is refused, naming the one already
-- running, instead of auto-stopping it: the classic failure is forgetting to
-- stop at house 1, driving 25 minutes and starting at house 2, and auto-stop
-- would silently log house 1 with the drive inside it.
--
-- Elapsed time is always computed from started_at, never accumulated, so a shut
-- laptop or a client clock that disagrees cannot drift it.
--
-- This is UI state that needs to outlive a device, not time DATA. The record of
-- work is time_entries; a timer nobody stops has recorded nothing, which is the
-- honest outcome for work nobody logged.
SET search_path TO public;--> statement-breakpoint
CREATE TABLE "time_timers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "time_timers" ADD CONSTRAINT "time_timers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_timers" ADD CONSTRAINT "time_timers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_timers" ADD CONSTRAINT "time_timers_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_timers" ADD CONSTRAINT "time_timers_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_timers_account_id_idx" ON "time_timers" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "time_timers_user_uq" ON "time_timers" USING btree ("account_id","user_id");--> statement-breakpoint
CREATE INDEX "time_timers_job_id_idx" ON "time_timers" USING btree ("account_id","job_id");--> statement-breakpoint
ALTER TABLE "time_timers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "time_timers_tenant_isolation" ON "time_timers" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "time_timers" TO thalermark_app;--> statement-breakpoint
GRANT SELECT ON TABLE "time_timers" TO thalermark_staff_readonly;