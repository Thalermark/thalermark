import { describe, expect, it } from 'vitest';
import { emit } from './emit.js';
import type { Event, EventName } from './events.js';

// One canonical example per event name. The TELEMETRY.md spec lists each
// event's payload exactly; this fixture is the runtime mirror. If the spec
// gains an event, this map MUST gain a row — the `Record<EventName, Event>`
// type makes that a compile error.
const SAMPLES: Record<EventName, Event> = {
  session_start: { name: 'session_start', deployment_type: 'cloud', product_version: '0.1.0' },
  session_end: { name: 'session_end', duration_seconds: 60 },
  invoice_created: { name: 'invoice_created', line_item_count: 3 },
  invoice_sent: { name: 'invoice_sent', delivery_method: 'email' },
  invoice_marked_paid: { name: 'invoice_marked_paid' },
  expense_logged: { name: 'expense_logged', has_receipt_attached: true },
  expense_categorised: { name: 'expense_categorised', method: 'ai_suggested' },
  report_viewed: { name: 'report_viewed', report_type: 'income' },
  client_created: { name: 'client_created' },
  company_created: { name: 'company_created' },
  estimate_created: { name: 'estimate_created' },
  estimate_converted: { name: 'estimate_converted' },
  ai_insight_viewed: { name: 'ai_insight_viewed', insight_type: 'cashflow' },
  ai_insight_dismissed: { name: 'ai_insight_dismissed', insight_type: 'anomaly' },
  ai_query_submitted: { name: 'ai_query_submitted', query_length_bucket: 'short' },
  ai_suggestion_accepted: { name: 'ai_suggestion_accepted', suggestion_type: 'category' },
  ai_suggestion_rejected: { name: 'ai_suggestion_rejected', suggestion_type: 'client' },
  onboarding_step_completed: { name: 'onboarding_step_completed', step: 'first_invoice' },
  onboarding_abandoned: { name: 'onboarding_abandoned', last_completed_step: 'company_setup' },
  invoice_flow_abandoned: { name: 'invoice_flow_abandoned', step_reached: 'line_items' },
  expense_flow_abandoned: { name: 'expense_flow_abandoned', step_reached: 'receipt' },
  page_load_time: { name: 'page_load_time', page: 'dashboard', duration_ms: 200 },
  api_response_time: { name: 'api_response_time', endpoint_category: 'invoices', duration_ms: 100 },
  error_occurred: {
    name: 'error_occurred',
    error_code: 'E_OCR_TIMEOUT',
    component: 'receipts',
    product_version: '0.1.0',
  },
};

describe('emit', () => {
  it('accepts every event variant without throwing', () => {
    for (const event of Object.values(SAMPLES)) {
      expect(() => emit(event)).not.toThrow();
    }
  });

  it('returns void', () => {
    const result = emit({ name: 'invoice_marked_paid' });
    expect(result).toBeUndefined();
  });

  it('covers every event name declared in the union', () => {
    // Sanity guard for the SAMPLES map. If a new event is added to the union
    // but missed here, the Record<EventName, Event> typing already breaks the
    // build; this test just catches accidental empty fixtures.
    const names = Object.keys(SAMPLES);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });
});
