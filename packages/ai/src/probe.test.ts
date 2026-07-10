import { describe, expect, it, vi } from 'vitest';
import { type ProbeRunner, probeCredential } from './probe.js';
import type { LlmCredential } from './provider.js';

const anthropic: LlmCredential = { provider: 'anthropic', apiKey: 'sk-ant-secret-key' };

const custom = (over: Partial<LlmCredential> = {}): LlmCredential => ({
  provider: 'custom',
  apiKey: 'sk-x',
  baseUrl: 'https://api.example.com/v1',
  modelVision: 'm',
  modelReasoning: 'm',
  modelFast: 'm',
  ...over,
});

const ok: ProbeRunner = async () => ({ ok: true });
const fails =
  (error: unknown): ProbeRunner =>
  async () => ({ ok: false, error });

describe('probeCredential', () => {
  it('refuses an incomplete credential without calling the model', async () => {
    const run = vi.fn<ProbeRunner>();
    const result = await probeCredential({ provider: 'anthropic' }, { run });
    expect(result.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('reports healthy for a known provider without freezing a structured value', async () => {
    const result = await probeCredential(anthropic, { run: ok });
    expect(result.ok).toBe(true);
    // Omitted for presets so the stored row keeps tracking the preset in code.
    if (result.ok) expect(result.structured).toBeUndefined();
  });

  it('probes a known provider exactly once', async () => {
    const run = vi.fn<ProbeRunner>(fails(new Error('invalid x-api-key')));
    await probeCredential(anthropic, { run });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('surfaces the provider error, so the admin sees it at config time', async () => {
    const result = await probeCredential(anthropic, { run: fails(new Error('invalid x-api-key')) });
    expect(result).toMatchObject({ ok: false, error: 'invalid x-api-key' });
  });

  // The error text lands on an admin's screen and in last_error.
  it('redacts the api key from the error text', async () => {
    const result = await probeCredential(anthropic, {
      run: fails(new Error('401 from https://api/x with key sk-ant-secret-key')),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).not.toContain('sk-ant-secret-key');
    expect(result.error).toContain('••••');
  });

  it('truncates a runaway error body', async () => {
    const result = await probeCredential(anthropic, { run: fails(new Error('x'.repeat(5000))) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.length).toBeLessThanOrEqual(300);
  });
});

// The detection contract: a custom endpoint's `structured` is measured, never
// asked. A reliable negative, an imperfect positive.
describe('probeCredential — structured detection on custom endpoints', () => {
  it('detects support when constrained decoding works first try', async () => {
    const run = vi.fn<ProbeRunner>(ok);
    const result = await probeCredential(custom(), { run });
    expect(result).toMatchObject({ ok: true, structured: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ structured: true });
  });

  it('falls back and records structured:false when response_format is rejected', async () => {
    const run = vi
      .fn<ProbeRunner>()
      .mockResolvedValueOnce({ ok: false, error: new Error('unknown param response_format') })
      .mockResolvedValueOnce({ ok: true });

    const result = await probeCredential(custom(), { run });
    expect(result).toMatchObject({ ok: true, structured: false });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toMatchObject({ structured: false });
  });

  it('reports the FIRST error when both attempts fail (a bad key, not a format issue)', async () => {
    const run = vi
      .fn<ProbeRunner>()
      .mockResolvedValueOnce({ ok: false, error: new Error('401 unauthorized') })
      .mockResolvedValueOnce({ ok: false, error: new Error('401 unauthorized again') });

    const result = await probeCredential(custom(), { run });
    expect(result).toMatchObject({ ok: false, error: '401 unauthorized' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  // A timeout says nothing about response_format support — the endpoint never
  // answered. Retrying it just doubles the wait before reporting the same abort,
  // which is exactly what a cold local model would suffer.
  it('does not retry detection when the first attempt timed out', async () => {
    const run = vi.fn<ProbeRunner>(async () => ({
      ok: false,
      error: new Error('aborted due to timeout'),
      aborted: true,
    }));
    const result = await probeCredential(custom(), { run });
    expect(result).toMatchObject({ ok: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not re-detect once structured is already stored', async () => {
    const run = vi.fn<ProbeRunner>(ok);
    const result = await probeCredential(custom({ structured: false }), { run });
    // Probes with the stored value, once — and does not re-report it (the column
    // already holds it; recordProbeResult leaves it untouched).
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.structured).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ structured: false });
  });

  it('never double-probes a preset provider', async () => {
    const run = vi.fn<ProbeRunner>(fails(new Error('nope')));
    await probeCredential({ provider: 'ollama' }, { run });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
