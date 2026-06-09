DROP INDEX "audit_events_account_created_at_idx";--> statement-breakpoint
CREATE INDEX "customers_account_created_at_idx" ON "customers" USING btree ("account_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "estimates_account_created_at_idx" ON "estimates" USING btree ("account_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "expenses_account_date_idx" ON "expenses" USING btree ("account_id","expense_date" DESC NULLS LAST,"created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "invoices_account_created_at_idx" ON "invoices" USING btree ("account_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "items_account_name_idx" ON "items" USING btree ("account_id","name","id");--> statement-breakpoint
CREATE INDEX "recurring_invoices_account_created_at_idx" ON "recurring_invoices" USING btree ("account_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_account_created_at_idx" ON "audit_events" USING btree ("account_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);