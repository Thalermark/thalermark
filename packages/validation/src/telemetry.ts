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
// originate in the browser/app — report_viewed, ai_insight_viewed, the
// onboarding company_setup + abandoned events, and invoice/expense flow
// abandonment — POST to /api/telemetry/ingest, which stages them via the same
// opt-in-gated emit() the server-side events use. The discriminated union grows
// as more client surfaces are wired; the API rejects any shape not listed here,
// so an unwired event name can never stage. Must stay structurally compatible
// with the matching variants of the Event union in @thalermark/telemetry.

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

// Invoice / expense "new" screens are single-page forms, so step_reached is the
// furthest section the user engaged before leaving without submitting. Mirrors
// InvoiceFlowAbandonedEvent / ExpenseFlowAbandonedEvent in @thalermark/telemetry.
// `preview`/`send` and `receipt`/`save` are inline/terminal and don't fire from
// the current forms, but are listed to match the Event union.
export const INVOICE_FLOW_STEPS = ['details', 'line_items', 'preview', 'send'] as const;
export const EXPENSE_FLOW_STEPS = ['amount', 'category', 'receipt', 'save'] as const;

// Onboarding steps — mirror OnboardingStep in @thalermark/telemetry. The client
// only fires `company_setup` (the /welcome business-setup step); the first_*
// milestones are emitted SERVER-side (a count-check in the create handlers), so
// onboarding_step_completed is restricted to company_setup here to keep first_*
// server-authoritative. onboarding_abandoned's last_completed_step allows the
// full set (nullable) for structural compatibility with the Event union.
export const ONBOARDING_STEPS = [
  'company_setup',
  'first_client',
  'first_invoice',
  'first_expense',
] as const;

export const clientTelemetryEventSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('report_viewed'), report_type: z.enum(TELEMETRY_REPORT_TYPES) }),
  z.object({ name: z.literal('ai_insight_viewed'), insight_type: z.enum(AI_INSIGHT_TYPES) }),
  z.object({ name: z.literal('onboarding_step_completed'), step: z.literal('company_setup') }),
  z.object({
    name: z.literal('onboarding_abandoned'),
    last_completed_step: z.enum(ONBOARDING_STEPS).nullable(),
  }),
  z.object({ name: z.literal('invoice_flow_abandoned'), step_reached: z.enum(INVOICE_FLOW_STEPS) }),
  z.object({ name: z.literal('expense_flow_abandoned'), step_reached: z.enum(EXPENSE_FLOW_STEPS) }),
  // Session boundary events. session_start has no payload — the envelope already
  // carries product_version + deployment_type. duration_seconds is rounded to
  // the nearest minute client-side.
  z.object({ name: z.literal('session_start') }),
  z.object({ name: z.literal('session_end'), duration_seconds: z.number().int().nonnegative() }),
]);

export type ClientTelemetryEvent = z.infer<typeof clientTelemetryEventSchema>;

// Cap a single ingest batch. Client emitters buffer a handful of low-frequency
// events and flush; this bounds an abusive or buggy client.
export const TELEMETRY_INGEST_MAX = 50;

export const telemetryIngestSchema = z.object({
  events: z.array(clientTelemetryEventSchema).min(1).max(TELEMETRY_INGEST_MAX),
});

export type TelemetryIngest = z.infer<typeof telemetryIngestSchema>;
