CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid,
	"category_account_id" uuid NOT NULL,
	"payment_account_id" uuid NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"expense_date" date NOT NULL,
	"merchant" text NOT NULL,
	"memo" text,
	"receipt_storage_key" text,
	"receipt_uploaded_at" timestamp with time zone,
	"extraction_status" text DEFAULT 'none' NOT NULL,
	"extraction_payload" jsonb,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("category_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payment_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("payment_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_account_id_idx" ON "expenses" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "expenses_company_id_idx" ON "expenses" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "expenses_customer_id_idx" ON "expenses" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "expenses_category_account_id_idx" ON "expenses" USING btree ("category_account_id");--> statement-breakpoint
CREATE INDEX "expenses_payment_account_id_idx" ON "expenses" USING btree ("payment_account_id");--> statement-breakpoint
CREATE INDEX "expenses_expense_date_idx" ON "expenses" USING btree ("expense_date");