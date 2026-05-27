CREATE TABLE "estimate_line_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"position" bigint NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(15, 4) NOT NULL,
	"unit_price" numeric(15, 2) NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"issue_date" date NOT NULL,
	"expires_on" date,
	"currency" text DEFAULT 'USD' NOT NULL,
	"subtotal" numeric(15, 2) DEFAULT '0' NOT NULL,
	"tax" numeric(15, 2) DEFAULT '0' NOT NULL,
	"total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"converted_invoice_id" uuid,
	"public_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_converted_invoice_id_invoices_id_fk" FOREIGN KEY ("converted_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "estimate_line_items_account_id_idx" ON "estimate_line_items" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "estimate_line_items_estimate_id_idx" ON "estimate_line_items" USING btree ("estimate_id");--> statement-breakpoint
CREATE INDEX "estimates_account_id_idx" ON "estimates" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "estimates_company_id_idx" ON "estimates" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "estimates_customer_id_idx" ON "estimates" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "estimates_status_idx" ON "estimates" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "estimates_company_number_uq" ON "estimates" USING btree ("company_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "estimates_public_token_uq" ON "estimates" USING btree ("public_token");