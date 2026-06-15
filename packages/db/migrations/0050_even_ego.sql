CREATE TABLE "auth_rate_limit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" bigint NOT NULL,
	"last_request" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_rate_limit_key_idx" ON "auth_rate_limit" USING btree ("key");