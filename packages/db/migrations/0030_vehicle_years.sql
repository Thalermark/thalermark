-- The collapsed 0000_baseline is a pg_dump that empties the session search_path,
-- and drizzle-kit's generated DDL is unqualified — restore it as the first
-- statement so a fresh-DB session can apply this file (0001–0029 do the same).
SET search_path TO public;--> statement-breakpoint
-- The per-year half of Schedule C Part IV — line 44, "of the total number of
-- miles you drove your vehicle during <year>, enter the number of miles you used
-- your vehicle for: a Business  b Commuting  c Other".
--
-- Split from `vehicles` by WHEN THE USER CAN ANSWER. The date a truck was placed
-- in service and whether it is ever driven personally are standing facts,
-- knowable any day, so they live on the vehicle. How far it went in total is
-- only knowable once the year is over.
--
-- Only ONE figure is asked for: total_miles. Business miles come from the trip
-- log, and OTHER MILES ARE NEVER STORED — they are total − business − commuting.
-- Storing all three would create a reconciliation problem that can drift;
-- storing two closes the arithmetic.
--
-- NOT PERIOD-LOCKED, unlike mileage_trips. A trip changes the dollar figure on
-- line 9; nothing here changes a dollar figure on any form. A corporation that
-- closes 2026 in January must still be able to answer in March.
CREATE TABLE "vehicle_years" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"tax_year" bigint NOT NULL,
	"total_miles" numeric(15, 4),
	"commuting_miles" numeric(15, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vehicle_years" ADD CONSTRAINT "vehicle_years_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_years" ADD CONSTRAINT "vehicle_years_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- CASCADE, unlike mileage_trips.vehicle_id which SET NULLs. A trip is evidence
-- that stands on its own — "24.5 miles to the Miller place" means something with
-- no vehicle attached. A year row is nothing but a fact ABOUT a vehicle;
-- orphaned, it says "something did 12,000 miles".
ALTER TABLE "vehicle_years" ADD CONSTRAINT "vehicle_years_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_years" ADD CONSTRAINT "vehicle_years_miles_nonnegative_check" CHECK ("total_miles" IS NULL OR "total_miles" >= 0);--> statement-breakpoint
ALTER TABLE "vehicle_years" ADD CONSTRAINT "vehicle_years_commuting_nonnegative_check" CHECK ("commuting_miles" >= 0);--> statement-breakpoint
CREATE INDEX "vehicle_years_account_id_idx" ON "vehicle_years" USING btree ("account_id");--> statement-breakpoint
-- One row per vehicle per year: a second would make "what did this truck do in
-- 2026" ambiguous on a federal disclosure.
CREATE UNIQUE INDEX "vehicle_years_vehicle_year_uq" ON "vehicle_years" USING btree ("vehicle_id","tax_year");--> statement-breakpoint
ALTER TABLE "vehicle_years" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "vehicle_years_tenant_isolation" ON "vehicle_years" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "vehicle_years" TO thalermark_app;--> statement-breakpoint
GRANT SELECT ON TABLE "vehicle_years" TO thalermark_staff_readonly;
