import { flushTelemetry, trackEvent } from './telemetry';

// Coarse session tracking for telemetry (TELEMETRY.md Session Events).
// session_start when the app becomes visible, session_end (active duration,
// rounded to the nearest minute) when it's hidden. A show → hide → show cycle is
// two sessions. trackEvent no-ops when opted out, so these are safe to call
// unconditionally. Best-effort: a hard tab-close may not deliver session_end.
let sessionStart: number | null = null;

function begin(): void {
  if (sessionStart !== null) return;
  sessionStart = Date.now();
  trackEvent({ name: 'session_start' });
}

function end(): void {
  if (sessionStart === null) return;
  const seconds = Math.round((Date.now() - sessionStart) / 60000) * 60;
  sessionStart = null;
  trackEvent({ name: 'session_end', duration_seconds: seconds });
  // Flush now — a hide/unload won't wait for the debounce.
  void flushTelemetry();
}

// Begin a session and listen for visibility changes. Returns a teardown for the
// caller's onMount (removes the listener and closes the open session).
export function startSessionTracking(): () => void {
  if (typeof document === 'undefined') return () => {};
  begin();
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') end();
    else begin();
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    end();
  };
}
