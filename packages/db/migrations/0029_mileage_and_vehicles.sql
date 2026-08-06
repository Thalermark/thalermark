-- The collapsed 0000_baseline is a pg_dump that empties the session search_path,
-- and drizzle-kit's generated DDL is unqualified — restore it as the first
-- statement so a fresh-DB session can apply this file (0001–0028 do the same).
SET search_path TO public;--> statement-breakpoint
-- Mileage: business trips, the vehicles they were driven in, and how this
-- business elects to deduct vehicle costs (TMC-179).
--
-- NEITHER TABLE POSTS TO THE LEDGER, FOR ANY ENTITY TYPE. No money moves when
-- you drive. Standard mileage is a statutory substitute for actual costs — a tax
-- figure, not a bookkeeping one — so a journal entry here would invent cash that
-- never left the bank and break reconciliation. There is an integration test
-- asserting the balance sheet, the P&L and job margin are byte-identical after
-- logging trips, and it is the load-bearing test of the whole feature.
--
-- What the deduction is worth is computed per trip from an IRS rate table keyed
-- by EFFECTIVE DATE, not by year — the IRS has split a year mid-way twice
-- recently (2022, and 2026 at 72.5c through June then 76c from July).
--
-- `vehicles` exists because Schedule C Part IV "Information on Your Vehicle" is
-- a PER-VEHICLE disclosure: line 43 wants the date placed in service, line 44
-- splits the year's miles into business / commuting / other, and lines 45–46 ask
-- about personal availability. The instructions are explicit that more than one
-- vehicle means a separate attached statement for each. Note the table does NOT
-- carry the standard-vs-actual election — see companies.vehicle_expense_method
-- below and the DO NOT MOVE note on the schema file.
CREATE TABLE "mileage_trips" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"trip_date" date NOT NULL,
	"miles" numeric(15, 4) NOT NULL,
	"purpose" text NOT NULL,
	"vehicle_id" uuid,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"label" text NOT NULL,
	"placed_in_service_on" date,
	"personal_use" text,
	"another_vehicle_available" boolean,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- How this business deducts vehicle costs: 'standard' | 'actual'. The IRS lets
-- you take EITHER a flat rate per business mile OR your actual gas / repairs /
-- insurance / depreciation, never both for one vehicle, because the standard
-- rate is a statutory substitute that already absorbs all of them.
--
-- DEFAULT 'standard': it is what this audience uses, it needs no receipts beyond
-- the trip log, and it is the only one of the two this schema can compute. There
-- is no vehicle dimension on expenses and no business-use percentage, so
-- choosing 'actual' means "keep mileage off my return", not "work out the other
-- number for me".
--
-- COMPANY-LEVEL, though the IRS rule is per-vehicle, and it stays that way even
-- now that a vehicles table exists. The lock that actually bites is the
-- irreversible one — claiming actual expenses with MACRS in a vehicle's first
-- year bars it from the standard rate for that vehicle's life — and we hold no
-- year-one history to enforce it against, so a per-vehicle field would look
-- authoritative and enforce nothing.
--
-- Same restatement hazard accounting_method and depreciation_convention carry:
-- it is a current-value column, so changing it in 2027 restates the 2025
-- worksheet. The ?method= override on the tax-worksheet endpoint exists so
-- nobody has to flip the saved election merely to compare.
--
-- text + app-layer validation rather than a CHECK, matching accounting_method
-- and depreciation_convention — the enum is owned by packages/validation so the
-- API boundary rejects unknown values before they reach SQL.
--
-- Adding a NOT NULL column WITH a constant default is metadata-only on
-- PostgreSQL 11+ — no table rewrite, brief lock.
ALTER TABLE "companies" ADD COLUMN "vehicle_expense_method" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "mileage_trips" ADD CONSTRAINT "mileage_trips_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mileage_trips" ADD CONSTRAINT "mileage_trips_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- SET NULL on both, and for the same reason: this is IRS substantiation, so
-- deleting a vehicle or a job must not destroy the evidence for a deduction
-- already claimed. (time_entries CASCADE off their job — hours have no meaning
-- without the job worked. Miles do.)
ALTER TABLE "mileage_trips" ADD CONSTRAINT "mileage_trips_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mileage_trips" ADD CONSTRAINT "mileage_trips_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mileage_trips" ADD CONSTRAINT "mileage_trips_miles_positive_check" CHECK ("miles" > 0);--> statement-breakpoint
CREATE INDEX "mileage_trips_account_id_idx" ON "mileage_trips" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "mileage_trips_trip_date_idx" ON "mileage_trips" USING btree ("account_id","company_id","trip_date");--> statement-breakpoint
CREATE INDEX "mileage_trips_job_id_idx" ON "mileage_trips" USING btree ("account_id","company_id","job_id");--> statement-breakpoint
CREATE INDEX "mileage_trips_vehicle_id_idx" ON "mileage_trips" USING btree ("account_id","company_id","vehicle_id");--> statement-breakpoint
CREATE INDEX "vehicles_account_id_idx" ON "vehicles" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "vehicles_company_idx" ON "vehicles" USING btree ("account_id","company_id");--> statement-breakpoint
-- CORRECTNESS, not tidiness: two rows for one truck would split its business
-- miles across two Part IV disclosures, each understating. Partial so a retired
-- vehicle's label can be reused, and case/whitespace-insensitive because
-- "F-150" and "f-150 " are never two vehicles.
CREATE UNIQUE INDEX "vehicles_company_label_active_uq" ON "vehicles" USING btree ("company_id",lower(btrim("label"))) WHERE "vehicles"."retired_at" is null;--> statement-breakpoint
ALTER TABLE "mileage_trips" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "mileage_trips_tenant_isolation" ON "mileage_trips" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "mileage_trips" TO thalermark_app;--> statement-breakpoint
GRANT SELECT ON TABLE "mileage_trips" TO thalermark_staff_readonly;--> statement-breakpoint
ALTER TABLE "vehicles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "vehicles_tenant_isolation" ON "vehicles" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "vehicles" TO thalermark_app;--> statement-breakpoint
GRANT SELECT ON TABLE "vehicles" TO thalermark_staff_readonly;
