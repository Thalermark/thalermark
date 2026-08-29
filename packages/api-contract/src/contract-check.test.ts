import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain JS tool script, no types emitted
import { compare } from '../../../scripts/contract-check.mjs';

// The classifier behind `pnpm contract:check` decides what breaks an installed
// client and what does not, and `pnpm release` refuses a release on its verdict.
// It had no tests until a block edit silently deleted its `export` and left the
// release script unable to start — nothing noticed, because CI runs the checker
// as a CLI and never imports it. Importing it here is half the point of this
// file; the rules below are the other half.

const route = (request: unknown, response: unknown) => ({
  routes: { '$post /api/things': { request, response } },
});

describe('contract compare', () => {
  it('is importable (the missing-export regression)', () => {
    expect(typeof compare).toBe('function');
  });

  it('accepts a new response field: old clients ignore what they do not read', () => {
    const before = route('{}', { id: 'string' });
    const after = route('{}', { id: 'string', nickname: 'string' });
    expect(compare(before, after).breaking).toEqual([]);
  });

  it('rejects a removed response field', () => {
    const before = route('{}', { id: 'string', total: 'string' });
    const after = route('{}', { id: 'string' });
    expect(compare(before, after).breaking).toMatchObject([
      { detail: 'response field removed: total' },
    ]);
  });

  it('rejects a renamed response field, as a removal plus an addition', () => {
    const before = route('{}', { total: 'string' });
    const after = route('{}', { amountTotal: 'string' });
    expect(compare(before, after).breaking).toMatchObject([
      { detail: 'response field removed: total' },
    ]);
  });

  it('rejects a response field that stops always being present', () => {
    const before = route('{}', { total: 'string' });
    const after = route('{}', { 'total?': 'string' });
    expect(compare(before, after).breaking).toMatchObject([
      { detail: 'response field is no longer always present: total' },
    ]);
  });

  it('rejects a changed response type', () => {
    const before = route('{}', { total: 'string' });
    const after = route('{}', { total: 'number' });
    expect(compare(before, after).breaking).toHaveLength(1);
  });

  it('rejects a new REQUIRED request field', () => {
    const before = route({ json: { amount: 'string' } }, { id: 'string' });
    const after = route({ json: { amount: 'string', poNumber: 'string' } }, { id: 'string' });
    expect(compare(before, after).breaking).toMatchObject([
      { detail: 'new required request field: json.poNumber' },
    ]);
  });

  it('accepts a new OPTIONAL request field', () => {
    const before = route({ json: { amount: 'string' } }, { id: 'string' });
    const after = route({ json: { amount: 'string', 'poNumber?': 'string' } }, { id: 'string' });
    expect(compare(before, after).breaking).toEqual([]);
  });

  it('rejects an optional request field becoming required', () => {
    const before = route({ json: { 'memo?': 'string' } }, { id: 'string' });
    const after = route({ json: { memo: 'string' } }, { id: 'string' });
    expect(compare(before, after).breaking).toMatchObject([
      { detail: 'request field became required: json.memo' },
    ]);
  });

  it('accepts a dropped request field: the server simply stops reading it', () => {
    const before = route({ json: { amount: 'string', memo: 'string' } }, { id: 'string' });
    const after = route({ json: { amount: 'string' } }, { id: 'string' });
    expect(compare(before, after).breaking).toEqual([]);
  });

  it('rejects a removed route and reports an added one as additive', () => {
    const before = route('{}', { id: 'string' });
    const after = { routes: { '$post /api/other': { request: '{}', response: { id: 'string' } } } };
    const { breaking, additive } = compare(before, after);
    expect(breaking).toMatchObject([{ route: '$post /api/things', detail: 'route removed' }]);
    expect(additive).toMatchObject([{ route: '$post /api/other' }]);
  });

  it('looks inside nested objects and arrays', () => {
    const before = route('{}', { lines: [{ id: 'string', amount: 'string' }] });
    const after = route('{}', { lines: [{ id: 'string' }] });
    expect(compare(before, after).breaking).toMatchObject([
      { detail: 'response field removed: lines[].amount' },
    ]);
  });
});
