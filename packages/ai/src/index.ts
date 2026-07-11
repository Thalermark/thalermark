export * from './types.js';
export { createReceiptExtractor } from './extractor.js';
export { createExpenseCategorizer } from './categorizer.js';
export { createCashFlowAdvisor, CASH_FLOW_NUDGE_VERSION } from './advisor.js';
export type { LlmCredential, ModelRole, ProviderPreset } from './provider.js';
export { isCredentialUsable, PRESETS } from './provider.js';
export type { ProbeResult, ProbeRunner } from './probe.js';
export { probeCredential } from './probe.js';
export { isConnectionHealthError, describeLlmError } from './health.js';
// Re-exported on the AI boundary: consumers classify/construct SDK call errors
// through @thalermark/ai rather than reaching into the 'ai' package directly.
export { APICallError } from 'ai';
export { normalizeExtraction, constrainCode } from './normalize.js';
export type { RawExtraction } from './normalize.js';
export { renderPdfFirstPageToPng } from './pdf.js';
