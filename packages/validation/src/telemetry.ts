import { z } from 'zod';

// Body for PATCH /api/account/telemetry — the per-account consent toggle.
// `enabled: true` is "Yes, help improve the product"; `false` is "No thanks".
// Either answer stamps telemetry_decided_at server-side so the first-run
// prompt never reappears. See TELEMETRY.md for the consent flow.
export const telemetryUpdateSchema = z.object({
  enabled: z.boolean(),
});

export type TelemetryUpdate = z.infer<typeof telemetryUpdateSchema>;

// Client-ingest pipeline (TELEMETRY.md "client ingest"). Events that can only
// originate in the browser/app — report_viewed and ai_insight_viewed — POST to
// /api/telemetry/ingest, which stages them via the same opt-in-gated emit() the
// server-side events use. The discriminated union grows as more client surfaces
// are wired; the API rejects any shape not listed here, so an unwired event
// name can never stage. Must stay structurally compatible with the matching
// variants of the Event union in @thalermark/telemetry.

// The report slugs match the /reports/<slug> routes 1:1 (web) and the mobile
// report screens. Answers "which reports get used" without any row content.
export const TELEMETRY_REPORT_TYPES = [
  'profit-and-loss',
  'balance-sheet',
  'ar-aging',
  'revenue-over-time',
  'expenses-by-category',
  'sales-by-customer',
  'sales-tax',
  'estimate-win-rate',
  'top-products',
  'general-ledger',
] as const;

// AI insight kinds — kept in sync with the AiInsightType union in
// @thalermark/telemetry (events.ts). Only `cashflow` (the dashboard "What to
// watch" nudges) and `anomaly` (the "Unusual spending" section) have a rendered
// surface today, so those are the only two the client fires; the other three are
// listed to stay structurally compatible with the Event union and will fire when
// their surface lands.
export const AI_INSIGHT_TYPES = [
  'cashflow',
  'anomaly',
  'late_payer',
  'tax_estimate',
  'seasonal',
] as const;

export const clientTelemetryEventSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('report_viewed'), report_type: z.enum(TELEMETRY_REPORT_TYPES) }),
  z.object({ name: z.literal('ai_insight_viewed'), insight_type: z.enum(AI_INSIGHT_TYPES) }),
]);

export type ClientTelemetryEvent = z.infer<typeof clientTelemetryEventSchema>;

// Cap a single ingest batch. Client emitters buffer a handful of low-frequency
// events and flush; this bounds an abusive or buggy client.
export const TELEMETRY_INGEST_MAX = 50;

export const telemetryIngestSchema = z.object({
  events: z.array(clientTelemetryEventSchema).min(1).max(TELEMETRY_INGEST_MAX),
});

export type TelemetryIngest = z.infer<typeof telemetryIngestSchema>;
