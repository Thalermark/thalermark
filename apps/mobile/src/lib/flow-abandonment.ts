import type { ClientTelemetryEvent } from '@thalermark/validation';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';
import { flushTelemetry, trackEvent } from './telemetry';

// Emit a *_flow_abandoned event when the user leaves a single-page create screen
// without submitting. useFocusEffect's cleanup runs on blur / unmount (the user
// navigated away); computeStep() inspects the current form state to decide the
// furthest section reached (null = never engaged → no event). computeStep is
// held in a ref so the blur callback reads the latest state, not a stale closure
// from the effect's initial run. trackEvent no-ops when opted out.
export function useFlowAbandonment(
  name: 'invoice_flow_abandoned' | 'expense_flow_abandoned',
  computeStep: () => string | null,
): { markSubmitted: () => void } {
  const submitted = useRef(false);
  const compute = useRef(computeStep);
  compute.current = computeStep;

  useFocusEffect(
    useCallback(() => {
      submitted.current = false; // fresh visit to the screen
      return () => {
        if (submitted.current) return;
        const step = compute.current();
        if (!step) return;
        trackEvent({ name, step_reached: step } as ClientTelemetryEvent);
        // Flush now — a nav away won't wait for the debounce.
        void flushTelemetry();
      };
    }, [name]),
  );

  return {
    // Call once the create succeeds so the follow-on navigation isn't counted.
    markSubmitted() {
      submitted.current = true;
    },
  };
}
