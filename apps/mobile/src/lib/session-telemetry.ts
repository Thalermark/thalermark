import { flushTelemetry, trackEvent } from './telemetry';

// Coarse session tracking for telemetry (TELEMETRY.md Session Events).
// beginSession on app entry / foreground, endSession (active duration rounded to
// the nearest minute) on background. A background → foreground cycle is two
// sessions. trackEvent no-ops when opted out. Best-effort: a force-kill won't
// run endSession.
let sessionStart: number | null = null;

export function beginSession(): void {
  if (sessionStart !== null) return;
  sessionStart = Date.now();
  trackEvent({ name: 'session_start' });
}

export function endSession(): void {
  if (sessionStart === null) return;
  const seconds = Math.round((Date.now() - sessionStart) / 60000) * 60;
  sessionStart = null;
  trackEvent({ name: 'session_end', duration_seconds: seconds });
  void flushTelemetry();
}
