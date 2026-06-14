CREATE TABLE "tax_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rate_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD COLUMN "taxable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD COLUMN "tax_rate_pct" numeric(7, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD COLUMN "tax_amount" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD COLUMN "tax_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "taxable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "tax_rate_pct" numeric(7, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "tax_amount" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "tax_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "taxable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "tax_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "recurring_invoice_line_items" ADD COLUMN "taxable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_invoice_line_items" ADD COLUMN "tax_rate_pct" numeric(7, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_invoice_line_items" ADD COLUMN "tax_amount" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_invoice_line_items" ADD COLUMN "tax_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "tax_policies" ADD CONSTRAINT "tax_policies_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_policies" ADD CONSTRAINT "tax_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tax_policies_account_id_idx" ON "tax_policies" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "tax_policies_company_id_idx" ON "tax_policies" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "tax_policies_company_name_idx" ON "tax_policies" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "tax_policies_account_name_idx" ON "tax_policies" USING btree ("account_id","name","id");--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_tax_policy_fk" FOREIGN KEY ("tax_policy_id") REFERENCES "public"."tax_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_tax_policy_fk" FOREIGN KEY ("tax_policy_id") REFERENCES "public"."tax_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_tax_policy_id_tax_policies_id_fk" FOREIGN KEY ("tax_policy_id") REFERENCES "public"."tax_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_line_items" ADD CONSTRAINT "recurring_line_items_tax_policy_fk" FOREIGN KEY ("tax_policy_id") REFERENCES "public"."tax_policies"("id") ON DELETE set null ON UPDATE no action;