import { APICallError, LoadAPIKeyError } from 'ai';

// Should a FAILED live AI call update the stored connection's health?
//
// Only a permanent, connection-level failure should: a bad or revoked key
// (401/403), or a bad model / malformed request (400/404/422). A transient
// failure — rate limit, provider 5xx, timeout, network blip — must NOT demote a
// working connection, or the status chip cries wolf on every hiccup. The SDK's
// own `isRetryable` is the transient signal; `statusCode` splits auth/config out
// of the permanent ones. An unrecognized throw is treated as transient (fail
// safe — never demote on something we can't classify).
//
// This governs the LIVE-call path only. The verify probe records unconditionally
// (the user is actively testing and wants to see even a transient failure).
export function isConnectionHealthError(error: unknown): boolean {
  if (LoadAPIKeyError.isInstance(error)) return true;
  if (APICallError.isInstance(error)) {
    if (error.isRetryable) return false;
    const status = error.statusCode;
    return status === 400 || status === 401 || status === 403 || status === 404 || status === 422;
  }
  return false;
}

// A short, key-redacted description of a provider error, for the connection's
// last_error (which is shown to the admin on the status chip). Some SDKs echo the
// key inside the failing request, so redact it; truncate so a response body can't
// bloat the column.
export function describeLlmError(error: unknown, apiKey?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const key = apiKey?.trim();
  const redacted = key ? raw.split(key).join('••••') : raw;
  return redacted.slice(0, 300);
}
