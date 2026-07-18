import { beforeNavigate } from '$app/navigation';
import type { ClientTelemetryEvent } from '@thalermark/validation';
import { flushTelemetry, trackEvent } from './telemetry';

// Emit a *_flow_abandoned event when the user leaves a single-page create flow
// without submitting. beforeNavigate covers both a client-side nav (Cancel link,
// the nav menu) and a tab/window unload, so it's the one hook we need. Call once
// at component init — beforeNavigate must be registered during initialisation.
//
// The invoice/expense "new" screens are single-page forms, so `steps` is the
// subset of the event's step_reached ladder the UI can actually reach, in order
// (e.g. the invoice form exposes 'details' then 'line_items'; 'preview'/'send'
// are inline/terminal). reach() only advances; on leave we emit the furthest
// step reached. trackEvent no-ops server-side and when opted out.
type FlowName = 'invoice_flow_abandoned' | 'expense_flow_abandoned';

export function trackFlowAbandonment(name: FlowName, steps: readonly string[]) {
  let furthest = -1;
  let submitted = false;

  beforeNavigate(() => {
    if (submitted || furthest < 0) return;
    const step = steps[furthest];
    furthest = -1; // fire at most once per visit
    if (!step) return;
    trackEvent({ name, step_reached: step } as ClientTelemetryEvent);
    // Flush now rather than wait for the debounce — an unload nav won't wait.
    void flushTelemetry();
  });

  return {
    // Mark the furthest section the user has engaged (focused a field in).
    reach(step: string) {
      const i = steps.indexOf(step);
      if (i > furthest) furthest = i;
    },
    // Call once the create actually succeeds so leaving afterwards isn't counted
    // as abandonment.
    markSubmitted() {
      submitted = true;
    },
  };
}
