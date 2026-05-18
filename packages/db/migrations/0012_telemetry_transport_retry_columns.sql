ALTER TABLE "telemetry_events" ADD COLUMN "retry_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "telemetry_events" ADD COLUMN "last_attempt_at" timestamp with time zone;