-- Per-connection AI timeout (TMC-296 follow-up).
--
-- NULL means the per-purpose defaults in @thalermark/ai/limits apply; set, it
-- becomes the ceiling for every AI call on the connection — extraction,
-- categorization, nudges, and the verify probes, so verify tests exactly what
-- the features will get. The knob exists for slow self-host hardware: a
-- CPU-only Ollama can need minutes where a hosted API needs seconds, and the
-- fixed 120s extraction budget was observed dying with the model mid-answer.
--
-- Bounds (30-300s) are enforced by the validation schema, not a CHECK: the
-- ceiling tracks what the HTTP stack tolerates, which is a code fact that
-- would go stale carved into the database.
SET search_path TO public;--> statement-breakpoint
ALTER TABLE "llm_connections" ADD COLUMN "timeout_seconds" bigint;
