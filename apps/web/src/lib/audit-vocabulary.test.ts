import { describe, expect, it } from 'vitest';
import { ACTION_LABELS, actionLabel, diffLines, fieldLabel, shortValue } from './audit-vocabulary';

// TMC-245. The feed is the one screen where the hidden ledger leaks, and the
// leak is always the same shape: a machine identifier where a word should be.
// These assertions are about the words, which is why they exist at all — the
// component compiled fine while rendering "categoryAccountId: ∅ → 019febc9-…".

// A machine identifier: snake_case, camelCase, or a bare uuid.
const MACHINE = /^[a-z]+(_[a-z]+)+$|[0-9a-f]{8}-[0-9a-f]{4}-|^[a-z]+[A-Z]/;

// A real expense row as the audit writer stores it: the whole DB row, tenancy
// columns and foreign keys included.
const expenseRow = {
  id: '019febc9-eda1-7000-8000-00000000bfac',
  accountId: '019febc9-ec21-7000-8000-00000000e808',
  companyId: '019febc9-ec21-7000-8000-0000000065d9',
  amount: '500.00',
  merchant: 'Fuel',
  expenseDate: '2026-03-01',
  categoryAccountId: '019febc9-ec21-7000-8000-00000000e86c',
  paymentAccountId: '019febc9-ec21-7000-8000-00000000f515',
  extractionStatus: 'none',
  deletedAt: null,
  createdAt: '2026-08-10T13:08:27.175Z',
  updatedAt: '2026-08-10T13:08:27.175Z',
};

describe('audit vocabulary — actions', () => {
  it('has English for every action the API raises', () => {
    // The ones that used to print raw. Sampled across the families rather than
    // exhaustively, because the map itself is the specification.
    for (const action of [
      'delete',
      'payment-recorded',
      'depreciation',
      'handoff-out',
      'transfer-ownership',
      'reopen',
    ]) {
      expect(ACTION_LABELS[action], `no label for ${action}`).toBeTruthy();
      expect(actionLabel(action)).not.toMatch(/^[a-z]+-[a-z]+/);
    }
  });

  it('keeps the direction on the handoff pair', () => {
    expect(actionLabel('handoff-out')).not.toBe(actionLabel('handoff-in'));
  });
});

describe('audit vocabulary — field names', () => {
  it('renames the columns a user has a word for', () => {
    expect(fieldLabel('deletedAt')).toBe('deleted');
    expect(fieldLabel('categoryAccountId')).toBe('category');
    expect(fieldLabel('paymentAccountId')).toBe('paid from');
  });

  it('splits camelCase for columns nobody mapped', () => {
    expect(fieldLabel('vendorReview')).toBe('vendor review');
    expect(fieldLabel('extractionStatus')).toBe('extraction status');
  });
});

describe('audit vocabulary — values', () => {
  it('shows a stored timestamp as a date', () => {
    expect(shortValue('2026-08-10T13:11:06.943Z')).toBe('2026-08-10');
  });

  it('says empty rather than a symbol', () => {
    expect(shortValue(null)).toBe('empty');
    expect(shortValue(undefined)).toBe('empty');
  });
});

describe('audit vocabulary — diff lines', () => {
  // The regression this file exists for. The create row rendered nine lines,
  // five of which were uuids, and one of those was labelled "category" — which
  // reads as though the uuid IS the category.
  it('shows only readable values when a record is created', () => {
    const lines = diffLines(undefined, expenseRow);

    expect(lines).toEqual([
      'amount: empty → 500.00',
      'merchant: empty → Fuel',
      'date: empty → 2026-03-01',
      'extraction status: empty → none',
    ]);
    for (const line of lines) {
      expect(line, `machine identifier in: ${line}`).not.toMatch(MACHINE);
    }
  });

  it('never prints a tenancy key or the row id', () => {
    const lines = diffLines(undefined, expenseRow).join(' ');
    expect(lines).not.toContain('019febc9');
    expect(lines).not.toMatch(/account id|company id|\bid\b/);
  });

  // A reference that changed is still worth reporting — the name just is not
  // available here, so the line says what is true and stops.
  it('reports a changed reference without showing the id', () => {
    const lines = diffLines(expenseRow, {
      ...expenseRow,
      categoryAccountId: '019febc9-ec21-7000-8000-0000000aaaaa',
    });
    expect(lines).toEqual(['category: changed']);
  });

  it('drops the bookkeeping columns from an ordinary edit', () => {
    const lines = diffLines(expenseRow, {
      ...expenseRow,
      amount: '625.00',
      updatedAt: '2026-08-10T14:00:00.000Z',
    });
    // Not "2 changes, one of which is updatedAt".
    expect(lines).toEqual(['amount: 500.00 → 625.00']);
  });

  // TMC-240: the delete stamp is the only field that says what happened, so it
  // has to survive the noise filtering that hides sentAt and friends.
  it('keeps the delete stamp, and pairs with restore', () => {
    const deleted = { ...expenseRow, deletedAt: '2026-08-10T13:11:06.943Z' };
    expect(diffLines(expenseRow, deleted)).toEqual(['deleted: empty → 2026-08-10']);
    expect(diffLines(deleted, expenseRow)).toEqual(['deleted: 2026-08-10 → empty']);
  });

  // The rule that hides sentAt is correct for the stamps the action label
  // already carries, and only those.
  it('hides a transition stamp the action label already conveys', () => {
    const invoice = { id: expenseRow.id, status: 'draft', sentAt: null };
    expect(
      diffLines(invoice, { ...invoice, status: 'sent', sentAt: '2026-08-10T13:00:00Z' }),
    ).toEqual(['status: draft → sent']);
  });
});
