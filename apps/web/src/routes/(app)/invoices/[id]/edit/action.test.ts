import { describe, expect, it, vi } from 'vitest';

// TMC-248. Every fix in this chain was verified by a test that cannot see a
// browser, and each one shipped still broken. This calls the real action with a
// dead API and asserts on what it actually returns — the artifact that was
// missing, and the one that decides whether a banner can appear at all.

vi.mock('$env/dynamic/private', () => ({ env: { INTERNAL_API_URL: 'http://api.test' } }));
vi.mock('$env/dynamic/public', () => ({ env: { PUBLIC_API_URL: '' } }));

function formData(): FormData {
  const d = new FormData();
  d.set('contactId', '019fec66-1af9-74a2-b000-9f345bbb8384');
  d.set('contactName', 'Someone Special');
  d.set('number', 'INV-1043');
  d.set('issueDate', '2026-08-10');
  d.set('dueDate', '2026-09-09');
  d.set('notes', '');
  d.append('li_description', 'first');
  d.append('li_quantity', '1');
  d.append('li_unitPrice', '1.00');
  d.append('li_unitLabel', '');
  d.append('li_sourceItemId', '');
  d.append('li_type', 'service');
  d.append('li_timeEntryId', '');
  d.append('li_taxable', '0');
  d.append('li_taxPolicyId', '');
  return d;
}

function event() {
  return {
    request: { formData: async () => formData(), headers: new Headers() },
    params: { id: '019fec66-1af9-74a2-b000-9f345bbb8384' },
    locals: {},
    cookies: { get: () => undefined },
  } as unknown as Parameters<NonNullable<typeof import('./+page.server')['actions']>['default']>[0];
}

describe('invoice edit action when the API is unreachable', () => {
  it('returns a failure carrying the values and a readable message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const { actions } = await import('./+page.server');

    // If this THROWS, the page gets an error screen and the user's work is gone
    // — the whole bug. It has to resolve to an ActionFailure instead.
    const result = (await actions.default(event())) as {
      status: number;
      data: { formError?: string; fieldErrors?: Record<string, string>; values?: unknown };
    };

    expect(result.status).toBe(503);
    expect(result.data.values).toBeTruthy();
    // The banner is `{#if form?.formError}`. Anything else — fieldErrors, or a
    // bare status — renders nothing at all, which is what "the button does
    // nothing" looks like from the outside.
    expect(result.data.formError).toMatch(/could not reach/i);
  });
});
