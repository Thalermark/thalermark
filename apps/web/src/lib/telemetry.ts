import type { ClientTelemetryEvent } from '@thalermark/validation';

// Client-side telemetry emitter (TELEMETRY.md client ingest). Buffers
// browser-only events and flushes them to the same-origin /telemetry-ingest
// proxy (which forwards to the API with the session cookie + x-account-id the
// browser can't stamp itself). The server stages an event only if the account
// opted in, but we also gate here so an opted-out account never even sends:
// the (app) layout calls setTelemetryEnabled from the consent state.

let enabled = false;
let buffer: ClientTelemetryEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let listenersBound = false;

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

// Queue an event. No-op unless opted in and in the browser. Coalesces a burst
// into one POST via a short debounce; the visibility-hidden flush catches a
// quick visit that leaves before the timer fires.
export function trackEvent(event: ClientTelemetryEvent): void {
  if (!enabled || typeof window === 'undefined') return;
  buffer.push(event);
  bindFlushListeners();
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
    await fetch('/telemetry-ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
      // Let the request outlive the page when flushing on tab-hide.
      keepalive: true,
    });
  } catch {
    // Best-effort: drop on failure (these are low-value, fire-and-forget).
  }
}

function bindFlushListeners(): void {
  if (listenersBound || typeof document === 'undefined') return;
  listenersBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushTelemetry();
  });
}
