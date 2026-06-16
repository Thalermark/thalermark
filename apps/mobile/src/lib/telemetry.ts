import type { ClientTelemetryEvent } from '@thalermark/validation';
import { api } from './api';

// Client-side telemetry emitter (TELEMETRY.md client ingest) — mobile mirror of
// apps/web's $lib/telemetry. Buffers app-only events and flushes them to
// /api/telemetry/ingest (the mobile api client already stamps the bearer token
// + x-account-id, so no proxy is needed as on web). The server stages an event
// only if the account opted in, but we also gate here so an opted-out account
// never sends: the (app) layout calls setTelemetryEnabled from the consent state.

let enabled = false;
let buffer: ClientTelemetryEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export function setTelemetryEnabled(value: boolean): void {
  enabled = value;
  if (!enabled) {
    buffer = [];
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
}

// Queue an event. No-op unless opted in. Coalesces a burst into one POST via a
// short debounce; the app-backgrounded flush (registered in the (app) layout)
// catches a quick visit that leaves before the timer fires.
export function trackEvent(event: ClientTelemetryEvent): void {
  if (!enabled) return;
  buffer.push(event);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flushTelemetry(), 2000);
}

export async function flushTelemetry(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!enabled || buffer.length === 0) return;
  const events = buffer;
  buffer = [];
  try {
    await api.api.telemetry.ingest.$post({ json: { events } });
  } catch {
    // Best-effort: drop on failure (low-value, fire-and-forget events).
  }
}
