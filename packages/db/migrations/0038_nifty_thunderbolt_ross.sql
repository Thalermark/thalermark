CREATE TABLE "items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"unit_price" numeric(15, 2) DEFAULT '0' NOT NULL,
	"unit_label" text,
	"default_quantity" numeric(15, 4) DEFAULT '1' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD COLUMN "source_item_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "source_item_id" uuid;--> statement-breakpoint
ALTER TABLE "recurring_invoice_line_items" ADD COLUMN "source_item_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_account_id_idx" ON "items" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "items_company_id_idx" ON "items" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "items_company_name_idx" ON "items" USING btree ("company_id","name");--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_source_item_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_source_item_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_line_items" ADD CONSTRAINT "recurring_line_items_source_item_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "estimate_line_items_source_item_id_idx" ON "estimate_line_items" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "invoice_line_items_source_item_id_idx" ON "invoice_line_items" USING btree ("source_item_id");--> statement-breakpoint
CREATE INDEX "recurring_invoice_line_items_source_item_id_idx" ON "recurring_invoice_line_items" USING btree ("source_item_id");