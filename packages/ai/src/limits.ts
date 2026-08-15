// Wall-clock ceilings for the three production model calls.
//
// WHY THIS FILE EXISTS. None of advise/categorize/extract bounded themselves.
// With no `abortSignal` and no `maxRetries`, two defaults stacked:
//
//   - the AI SDK retries twice by default, so one call is three attempts
//   - createGuardedFetch pins undici's dns lookup for SSRF but sets no
//     headersTimeout or bodyTimeout, leaving both at undici's 300s default
//
// So a provider that accepts a connection and then goes quiet held a request for
// roughly fifteen minutes. On the synchronous suggest path that is a spinner the
// user cannot cancel, and underneath it a Postgres pool connection held for the
// duration — which is the part that matters, because pool pressure is a known
// constraint here rather than a theoretical one (TMC-32).
//
// probe.ts already had this right, and its 60s budget carries the measurement
// these numbers are calibrated against: a 14B model on CPU took ~37s to become
// ready on a cold load. That is the case a tighter bound would break, and it is
// exactly the self-hoster the BYOK path exists for. A dead endpoint still fails
// in milliseconds on connection refused, so these only lengthen the
// slow-but-alive case.
//
// The signal is created ONCE per call and shared across retries, so each number
// is a TOTAL budget rather than a per-attempt one. A slow first attempt eats the
// retry's headroom, which is the correct direction to fail.

// Short prompt, small JSON back, on the `fast` model. The same order as a probe,
// because on a local stack the cold load dominates and the prompt does not.
export const CATEGORIZE_TIMEOUT_MS = 60_000;

// The `reasoning` model writing a few sentences. More output than a categorize,
// and the model is the larger of the pair on every preset.
export const ADVISE_TIMEOUT_MS = 90_000;

// Slowest of the three by construction: a vision model with a full-page image
// attached, and for a PDF a render step before the request is even built.
export const EXTRACT_TIMEOUT_MS = 120_000;

// One retry, not the SDK's two. A retry earns its keep against a transient
// connection blip, which is real. A second does not: by then the endpoint is
// down or wrong, and each extra attempt is another slice of the budget above
// spent to learn the same thing. The probe uses 0 for a stricter reason — it
// exists to report the first error truthfully, and retries would hide it.
export const AI_MAX_RETRIES = 1;
