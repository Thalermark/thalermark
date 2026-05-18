// Event definitions for the Thalermark telemetry stream.
// One-to-one with the tables in TELEMETRY.md; any change here requires a
// matching documentation update in the same PR.

export type SessionStartEvent = {
  name: 'session_start';
  deployment_type: DeploymentType;
  product_version: string;
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
  report_type: 'income' | 'expenses' | 'summary' | 'custom';
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
