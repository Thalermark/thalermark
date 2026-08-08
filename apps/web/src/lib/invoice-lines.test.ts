import { describe, expect, it } from 'vitest';
import { computeInvoiceLines } from './invoice-lines';

const POLICIES = [{ id: 'pol-1', ratePct: '10' }];

function row(over: Partial<Parameters<typeof computeInvoiceLines>[0][number]> = {}) {
  return { description: 'work', quantity: '2', unitPrice: '25.00', taxable: false, ...over };
}

describe('computeInvoiceLines', () => {
  it('recomputes amount from quantity × unit price', () => {
    const [line] = computeInvoiceLines([row()], POLICIES);
    expect(line?.amount).toBe('50.00');
    expect(line?.position).toBe(1);
  });

  it('resolves the tax rate from the policy, not the client', () => {
    const [line] = computeInvoiceLines([row({ taxable: true, taxPolicyId: 'pol-1' })], POLICIES);
    expect(line?.taxRatePct).toBe('10');
    expect(line?.taxAmount).toBe('5.00');
  });

  it('drops the policy id on a non-taxable row', () => {
    const [line] = computeInvoiceLines([row({ taxable: false, taxPolicyId: 'pol-1' })], POLICIES);
    expect(line?.taxPolicyId).toBeUndefined();
    expect(line?.taxAmount).toBe('0');
  });

  // REGRESSION: the two invoice actions each built this mapping by hand and one
  // stopped forwarding timeEntryId. The API derives which tracked hours an
  // invoice bills from the submitted lines, so a line without its id is a line
  // that bills the work and never marks it billed — the job re-offers the same
  // hours and the next invoice charges the customer twice.
  it('forwards the tracked-time link on an hour row', () => {
    const [line] = computeInvoiceLines([row({ timeEntryId: 'entry-1' })], POLICIES);
    expect(line?.timeEntryId).toBe('entry-1');
  });

  it('leaves the tracked-time link unset on a hand-typed row', () => {
    const [line] = computeInvoiceLines([row()], POLICIES);
    expect(line?.timeEntryId).toBeUndefined();
  });

  it('keeps every row aligned with its own link', () => {
    const lines = computeInvoiceLines(
      [row({ timeEntryId: 'entry-1' }), row(), row({ timeEntryId: 'entry-2' })],
      POLICIES,
    );
    expect(lines.map((l) => l.timeEntryId)).toEqual(['entry-1', undefined, 'entry-2']);
    expect(lines.map((l) => l.position)).toEqual([1, 2, 3]);
  });

  it('forwards the catalog-item breadcrumb', () => {
    const [line] = computeInvoiceLines([row({ sourceItemId: 'item-1' })], POLICIES);
    expect(line?.sourceItemId).toBe('item-1');
  });
});
