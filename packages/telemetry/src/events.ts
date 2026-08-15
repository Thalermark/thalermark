// Event definitions for the Thalermark telemetry stream.
// One-to-one with the tables in TELEMETRY.md; any change here requires a
// matching documentation update in the same PR.

// The install/identity block (deployment_type, product_version, …) rides the
// transport envelope on every batch, so session_start carries no payload of its
// own — its signal is the timestamp plus the fact that a session began.
export type SessionStartEvent = {
  name: 'session_start';
};

export type SessionEndEvent = {
  name: 'session_end';
  // Rounded to the nearest minute (60s granularity).
  duration_seconds: number;
};

export type InvoiceCreatedEvent = {
  name: 'invoice_created';
  line_item_count: number;
};

export type InvoiceSentEvent = {
  name: 'invoice_sent';
  delivery_method: 'email' | 'link';
};

export type InvoiceMarkedPaidEvent = {
  name: 'invoice_marked_paid';
};

export type ExpenseLoggedEvent = {
  name: 'expense_logged';
  has_receipt_attached: boolean;
};

export type ExpenseCategorisedEvent = {
  name: 'expense_categorised';
  method: 'manual' | 'ai_suggested';
};

export type ReportViewedEvent = {
  name: 'report_viewed';
  // One slug per /reports/<slug> route (web) / report screen (mobile). Kept in
  // sync with TELEMETRY_REPORT_TYPES in @thalermark/validation, which the
  // client-ingest endpoint validates against.
  report_type:
    | 'profit-and-loss'
    | 'balance-sheet'
    | 'ar-aging'
    | 'revenue-over-time'
    | 'expenses-by-category'
    | 'sales-by-customer'
    | 'sales-tax'
    | 'estimate-win-rate'
    | 'top-products'
    | 'general-ledger';
};

export type ClientCreatedEvent = {
  name: 'client_created';
};

export type CompanyCreatedEvent = {
  name: 'company_created';
};

export type EstimateCreatedEvent = {
  name: 'estimate_created';
};

export type EstimateConvertedEvent = {
  name: 'estimate_converted';
};

export type AiInsightType = 'cashflow' | 'anomaly' | 'late_payer' | 'tax_estimate' | 'seasonal';

export type AiInsightViewedEvent = {
  name: 'ai_insight_viewed';
  insight_type: AiInsightType;
};

export type AiInsightDismissedEvent = {
  name: 'ai_insight_dismissed';
  insight_type: AiInsightType;
};

export type AiQuerySubmittedEvent = {
  name: 'ai_query_submitted';
  query_length_bucket: 'short' | 'medium' | 'long';
};

export type AiSuggestionType = 'category' | 'client' | 'amount_check';

export type AiSuggestionAcceptedEvent = {
  name: 'ai_suggestion_accepted';
  suggestion_type: AiSuggestionType;
};

export type AiSuggestionRejectedEvent = {
  name: 'ai_suggestion_rejected';
  suggestion_type: AiSuggestionType;
};

export type OnboardingStep = 'company_setup' | 'first_client' | 'first_invoice' | 'first_expense';

export type OnboardingStepCompletedEvent = {
  name: 'onboarding_step_completed';
  step: OnboardingStep;
};

export type OnboardingAbandonedEvent = {
  name: 'onboarding_abandoned';
  last_completed_step: OnboardingStep | null;
};

export type InvoiceFlowAbandonedEvent = {
  name: 'invoice_flow_abandoned';
  step_reached: 'details' | 'line_items' | 'preview' | 'send';
};

export type ExpenseFlowAbandonedEvent = {
  name: 'expense_flow_abandoned';
  step_reached: 'amount' | 'category' | 'receipt' | 'save';
};

// ---------------------------------------------------------------------------
// DEFINED BUT NOT COLLECTED. Nothing emits the three events below, and they are
// not client-ingest variants, so the ingest endpoint rejects them (see the note
// in apps/api/tests/telemetry.integration.test.ts). TELEMETRY.md marks them the
// same way — the doc and these types have to keep saying the same thing, or the
// public spec starts promising collection that does not happen.
//
// They stay declared rather than deleted because the envelope and receiver
// contract is shared with the commercial receiver (TMCLD-103), so removing a
// member of this union is a cross-repo change rather than a cleanup.
//
// Why each is unbuilt, so the decision is not re-litigated (TMC-153):
//
//   error_occurred    — the operational error tracker already captures these
//                       WITH stack traces and request context, which this event
//                       is forbidden from carrying. It would learn strictly
//                       less about the same failures. The one case it would
//                       serve is aggregate error rates across self-hosted
//                       installs, which no per-instance tracker can see.
//
//   page_load_time    — fires on every navigation.
//   api_response_time — fires on every request, and there is no timing
//                       middleware to fire from.
//
// Both perf events need a sampling strategy first: the pipeline stages one row
// per event with no sampling, so unsampled timings would dominate the stream.
// Worth pricing tracing in the existing error tracker before building either —
// it answers "is this deployment slow" without a new pipeline, where these
// answer the broader and much more expensive "are the community's installs
// slow".
// ---------------------------------------------------------------------------

export type PageLoadTimeEvent = {
  name: 'page_load_time';
  // Enum tightens as features land; until then string keeps the spec honest.
  page: string;
  // Rounded to nearest 100ms.
  duration_ms: number;
};

export type ApiResponseTimeEvent = {
  name: 'api_response_time';
  endpoint_category: string;
  duration_ms: number;
};

export type ErrorOccurredEvent = {
  name: 'error_occurred';
  error_code: string;
  component: string;
  product_version: string;
};

export type Event =
  | SessionStartEvent
  | SessionEndEvent
  | InvoiceCreatedEvent
  | InvoiceSentEvent
  | InvoiceMarkedPaidEvent
  | ExpenseLoggedEvent
  | ExpenseCategorisedEvent
  | ReportViewedEvent
  | ClientCreatedEvent
  | CompanyCreatedEvent
  | EstimateCreatedEvent
  | EstimateConvertedEvent
  | AiInsightViewedEvent
  | AiInsightDismissedEvent
  | AiQuerySubmittedEvent
  | AiSuggestionAcceptedEvent
  | AiSuggestionRejectedEvent
  | OnboardingStepCompletedEvent
  | OnboardingAbandonedEvent
  | InvoiceFlowAbandonedEvent
  | ExpenseFlowAbandonedEvent
  | PageLoadTimeEvent
  | ApiResponseTimeEvent
  | ErrorOccurredEvent;

export type EventName = Event['name'];

export type DeploymentType = 'cloud' | 'self-hosted';

// Envelope fields attached to every event by the transport, sourced from the
// host environment. Not part of the per-event payload above.
export type InstallContext = {
  install_id: string;
  product_version: string;
  deployment_type: DeploymentType;
  os_platform: 'linux' | 'macos' | 'windows';
  node_version: string;
};
