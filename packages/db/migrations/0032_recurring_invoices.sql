CREATE TABLE "recurring_invoice_line_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"recurring_invoice_id" uuid NOT NULL,
	"position" bigint NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(15, 4) NOT NULL,
	"unit_price" numeric(15, 2) NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"frequency" text NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"start_date" date NOT NULL,
	"next_run_date" date NOT NULL,
	"end_date" date,
	"max_occurrences" integer,
	"occurrence_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"net_terms_days" integer DEFAULT 30 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"subtotal" numeric(15, 2) DEFAULT '0' NOT NULL,
	"tax" numeric(15, 2) DEFAULT '0' NOT NULL,
	"total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "recurring_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "recurring_invoice_line_items" ADD CONSTRAINT "recurring_invoice_line_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_line_items" ADD CONSTRAINT "recurring_invoice_line_items_recurring_invoice_id_recurring_invoices_id_fk" FOREIGN KEY ("recurring_invoice_id") REFERENCES "public"."recurring_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_invoice_line_items_account_id_idx" ON "recurring_invoice_line_items" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "recurring_invoice_line_items_recurring_invoice_id_idx" ON "recurring_invoice_line_items" USING btree ("recurring_invoice_id");--> statement-breakpoint
CREATE INDEX "recurring_invoices_account_id_idx" ON "recurring_invoices" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "recurring_invoices_company_id_idx" ON "recurring_invoices" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "recurring_invoices_customer_id_idx" ON "recurring_invoices" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "recurring_invoices_sweep_idx" ON "recurring_invoices" USING btree ("status","next_run_date");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_recurring_invoice_id_recurring_invoices_id_fk" FOREIGN KEY ("recurring_invoice_id") REFERENCES "public"."recurring_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_recurring_invoice_id_idx" ON "invoices" USING btree ("recurring_invoice_id");