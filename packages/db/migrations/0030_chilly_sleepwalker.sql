ALTER TABLE "companies" ADD COLUMN "cash_flow_nudges" jsonb;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "nudges_input_hash" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "nudges_generated_at" timestamp with time zone;