import { APICallError, LoadAPIKeyError, RetryError } from 'ai';

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
// A 5xx whose body says the MODEL failed to load is not a hiccup — it fails
// identically on every future call until the operator changes something, which
// makes it exactly the class the chip exists for (TMC-296: Ollama serves
// "unknown model architecture" as a retryable 500, so a dead vision model was
// classed as a blip and never recorded anywhere). Matched on the provider's
// wording because the status code alone cannot tell it apart from a real
// transient 500; the list is Ollama-shaped since that is where load failures
// present as 5xx — hosted APIs say "model not found" with a 404, which the
// status check below already treats as permanent.
const MODEL_LOAD_FAILURE =
  /error loading model|unknown model architecture|unable to load model|llama.server process has terminated|llama runner process has terminated/i;

export function isConnectionHealthError(error: unknown): boolean {
  // Live calls run with retries (AI_MAX_RETRIES), and when the SDK exhausts
  // them it throws a RetryError WRAPPING the provider errors — so a retryable
  // failure from a real route never arrives here as a bare APICallError.
  // Classify the last underlying attempt instead (TMC-296: this is the second
  // half of how a permanently failing model was never recorded — the probe's
  // maxRetries:0 path threw bare and classified fine, the live path did not).
  if (RetryError.isInstance(error)) return isConnectionHealthError(error.lastError);
  if (LoadAPIKeyError.isInstance(error)) return true;
  if (APICallError.isInstance(error)) {
    if (error.isRetryable) {
      return MODEL_LOAD_FAILURE.test(error.responseBody ?? error.message);
    }
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
