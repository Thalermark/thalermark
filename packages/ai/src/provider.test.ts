import { describe, expect, it } from 'vitest';
import {
  type LlmCredential,
  type ModelRole,
  PRESETS,
  isCredentialUsable,
  normalizeBaseUrl,
  resolveModel,
} from './provider.js';

const ROLES: readonly ModelRole[] = ['vision', 'reasoning', 'fast'];

// A `custom` credential is only usable when it supplies an endpoint AND every
// role's model — see the invariant test at the bottom.
const custom = (over: Partial<LlmCredential> = {}): LlmCredential => ({
  provider: 'custom',
  apiKey: 'sk-x',
  baseUrl: 'https://api.x.ai/v1',
  modelVision: 'grok-vision',
  modelReasoning: 'grok',
  modelFast: 'grok-mini',
  ...over,
});

// isCredentialUsable is the vetting the credential resolver relies on: it must
// return true exactly when resolveModel would return a model, so a vetted
// credential never yields a null model at the call site.
describe('isCredentialUsable', () => {
  it('anthropic/openai need a non-blank key', () => {
    expect(isCredentialUsable({ provider: 'anthropic', apiKey: 'sk-x' })).toBe(true);
    expect(isCredentialUsable({ provider: 'openai', apiKey: 'sk-x' })).toBe(true);
    expect(isCredentialUsable({ provider: 'anthropic' })).toBe(false);
    expect(isCredentialUsable({ provider: 'anthropic', apiKey: '   ' })).toBe(false);
  });

  it('defaults to anthropic when provider is unset', () => {
    expect(isCredentialUsable({ apiKey: 'sk-x' })).toBe(true);
    expect(isCredentialUsable({})).toBe(false);
  });

  it('ollama needs no key', () => {
    expect(isCredentialUsable({ provider: 'ollama' })).toBe(true);
  });

  it('an unknown provider is never usable', () => {
    expect(isCredentialUsable({ provider: 'gemini', apiKey: 'x' })).toBe(false);
  });

  it('is case/whitespace-insensitive on the provider name', () => {
    expect(isCredentialUsable({ provider: '  Anthropic ', apiKey: 'sk-x' })).toBe(true);
  });

  it('custom needs a key, a base url, and every role model', () => {
    expect(isCredentialUsable(custom())).toBe(true);
    expect(isCredentialUsable(custom({ apiKey: undefined }))).toBe(false);
    expect(isCredentialUsable(custom({ baseUrl: undefined }))).toBe(false);
    expect(isCredentialUsable(custom({ baseUrl: '  ' }))).toBe(false);
  });

  // The invariant's teeth: custom ships no default models, so a partially
  // configured credential must not vet — otherwise resolveModel(cred,'vision')
  // returns null for a credential the resolver already declared usable.
  it.each(['modelVision', 'modelReasoning', 'modelFast'] as const)(
    'custom is unusable when %s is missing',
    (field) => {
      expect(isCredentialUsable(custom({ [field]: undefined }))).toBe(false);
    },
  );
});

describe('resolveModel', () => {
  const each = (cred: LlmCredential) => ROLES.map((r) => resolveModel(cred, r));

  it('returns a model for every role when the credential is usable', () => {
    for (const m of each({ provider: 'anthropic', apiKey: 'sk-x' })) expect(m).not.toBeNull();
    for (const m of each({ provider: 'openai', apiKey: 'sk-x' })) expect(m).not.toBeNull();
    for (const m of each({ provider: 'ollama' })) expect(m).not.toBeNull();
    for (const m of each(custom())) expect(m).not.toBeNull();
  });

  it('returns null for every role when the credential is not usable', () => {
    for (const m of each({ provider: 'anthropic' })) expect(m).toBeNull();
    for (const m of each({ provider: 'gemini', apiKey: 'x' })) expect(m).toBeNull();
    for (const m of each({})) expect(m).toBeNull();
    for (const m of each(custom({ modelVision: undefined }))) expect(m).toBeNull();
  });

  it('accepts a baseUrl override on an openai-wire preset', () => {
    expect(
      resolveModel({ provider: 'ollama', baseUrl: 'http://ollama:11434' }, 'fast'),
    ).not.toBeNull();
  });

  // The contract isCredentialUsable promises the resolver, asserted directly.
  it.each([
    { provider: 'anthropic', apiKey: 'sk-x' },
    { provider: 'anthropic' },
    { provider: 'openai', apiKey: 'sk-x' },
    { provider: 'ollama' },
    { provider: 'gemini', apiKey: 'x' },
    { apiKey: 'sk-x' },
    {},
    custom(),
    custom({ baseUrl: undefined }),
    custom({ modelFast: undefined }),
  ] satisfies LlmCredential[])('usable ⇔ every role resolves (%j)', (cred) => {
    const usable = isCredentialUsable(cred);
    for (const role of ROLES) expect(resolveModel(cred, role) !== null).toBe(usable);
  });
});

describe('normalizeBaseUrl', () => {
  // OLLAMA_BASE_URL is documented without /v1; the pre-refactor code appended it.
  it('appends /v1 when absent', () => {
    expect(normalizeBaseUrl('http://localhost:11434')).toBe('http://localhost:11434/v1');
    expect(normalizeBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434/v1');
    expect(normalizeBaseUrl('  http://ollama:11434//  ')).toBe('http://ollama:11434/v1');
  });

  it('leaves an endpoint that already ends in /v1 alone', () => {
    expect(normalizeBaseUrl('https://api.x.ai/v1')).toBe('https://api.x.ai/v1');
    expect(normalizeBaseUrl('https://api.x.ai/v1/')).toBe('https://api.x.ai/v1');
  });

  // The base url is user input once the settings UI lands. A trailing-strip
  // regex (/\/+$/) backtracks quadratically on an interior run of slashes that
  // does not reach the end — CodeQL js/polynomial-redos. Index-scan instead.
  it('stays linear on a long interior slash run', () => {
    const hostile = `http://h/${'/'.repeat(100_000)}x`;
    const started = performance.now();
    expect(normalizeBaseUrl(hostile)).toBe(`${hostile}/v1`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('PRESETS', () => {
  it('every preset either ships all three role models or demands them', () => {
    for (const [id, preset] of Object.entries(PRESETS)) {
      if (preset.models) {
        for (const role of ROLES) expect(preset.models[role], `${id}.${role}`).toBeTruthy();
      } else {
        // No defaults ⇒ the credential must supply them, so the preset has to be
        // one the UI marks as fully hand-configured.
        expect(preset.requiresBaseUrl, `${id} without models must require a base url`).toBe(true);
      }
    }
  });

  it('every openai-wire preset has a default endpoint or requires one', () => {
    for (const [id, preset] of Object.entries(PRESETS)) {
      if (preset.adapter !== 'openai-wire') continue;
      expect(Boolean(preset.baseUrl) || preset.requiresBaseUrl === true, id).toBe(true);
    }
  });

  it('custom fails safe on structured output until the probe proves otherwise', () => {
    expect(PRESETS.custom?.structured).toBe(false);
    expect(PRESETS.ollama?.structured).toBe(true);
  });

  it('xai is a ready-to-use preset (key + models + default endpoint, openai-wire)', () => {
    expect(PRESETS.xai).toMatchObject({
      adapter: 'openai-wire',
      needsKey: true,
      structured: true,
      baseUrl: 'https://api.x.ai/v1',
    });
    // Usable with just a key — every role resolves from the preset's models.
    const cred: LlmCredential = { provider: 'xai', apiKey: 'xai-key' };
    expect(isCredentialUsable(cred)).toBe(true);
    for (const role of ROLES) expect(resolveModel(cred, role)).not.toBeNull();
  });
});
