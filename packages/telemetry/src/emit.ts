import type { Event } from './events.js';

// Sink for telemetry events. Slice 2.2 swaps the body for the local transport
// (write to telemetry_events table, gated by accounts.telemetry_enabled).
// Until then, the call surface exists so feature code can be wired up safely.
export function emit(event: Event): void {
  void event;
}
