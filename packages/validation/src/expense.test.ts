import { describe, expect, it } from 'vitest';
import { expenseAllocationsSchema } from './expense.js';

const INVOICE_A = '019fd457-203d-749e-a09d-57ffd2aea878';
const INVOICE_B = '019fd457-203e-721e-a672-061c89d0926d';
const INVOICE_C = '019fd457-2041-7a55-8c31-1d6e4b2f9c07';
const JOB_A = '019fd457-2040-7219-9bf7-6a00685380a3';

function parse(allocations: unknown[]) {
  return expenseAllocationsSchema.safeParse({ allocations });
}

describe('expenseAllocationsSchema', () => {
  it('accepts the seed case — one expense split across three invoices', () => {
    expect(
      parse([
        { invoiceId: INVOICE_A, share: '0.333333' },
        { invoiceId: INVOICE_B, share: '0.333333' },
        { invoiceId: INVOICE_C, share: '0.333334' },
      ]).success,
    ).toBe(true);
  });

  // Shared is a real answer, distinct from an empty list, which means the user
  // never answered at all.
  it('accepts the shared answer with neither pointer set', () => {
    const parsed = parse([{ share: '1' }]);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.allocations[0]?.invoiceId).toBeNull();
    expect(parsed.success && parsed.data.allocations[0]?.jobId).toBeNull();
  });

  it('accepts an empty list — clearing the answer', () => {
    expect(parse([]).success).toBe(true);
  });

  // Job-grain tagging (TMC-181) without the client having to send an explicit
  // invoiceId: null.
  it('accepts a job-only row', () => {
    const parsed = parse([{ jobId: JOB_A, share: '1' }]);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.allocations[0]?.jobId).toBe(JOB_A);
    expect(parsed.success && parsed.data.allocations[0]?.invoiceId).toBeNull();
  });

  // Job margin rolls invoice-grain and job-grain costs together, so a row
  // carrying both would be counted twice. The DB has a CHECK for this; catching
  // it here turns a 500 into a 400.
  it('rejects a row naming both an invoice and a job', () => {
    expect(parse([{ invoiceId: INVOICE_A, jobId: JOB_A, share: '1' }]).success).toBe(false);
  });

  it('rejects shares that do not sum to one', () => {
    expect(parse([{ invoiceId: INVOICE_A, share: '0.5' }]).success).toBe(false);
  });

  it('rejects a share outside (0, 1]', () => {
    expect(parse([{ invoiceId: INVOICE_A, share: '0' }]).success).toBe(false);
  });

  it('rejects the same invoice twice', () => {
    expect(
      parse([
        { invoiceId: INVOICE_A, share: '0.5' },
        { invoiceId: INVOICE_A, share: '0.5' },
      ]).success,
    ).toBe(false);
  });

  it('rejects the same job twice', () => {
    expect(
      parse([
        { jobId: JOB_A, share: '0.5' },
        { jobId: JOB_A, share: '0.5' },
      ]).success,
    ).toBe(false);
  });

  it('rejects two shared rows', () => {
    expect(parse([{ share: '0.5' }, { share: '0.5' }]).success).toBe(false);
  });

  // The duplicate key is namespaced, so an invoice and a job that happen to
  // share an id string are still two distinct targets rather than one collision.
  it('treats an invoice and a job with the same id as different targets', () => {
    expect(
      parse([
        { invoiceId: JOB_A, share: '0.5' },
        { jobId: JOB_A, share: '0.5' },
      ]).success,
    ).toBe(true);
  });

  it('accepts a mix of invoice, job and shared rows', () => {
    expect(
      parse([
        { invoiceId: INVOICE_A, share: '0.25' },
        { jobId: JOB_A, share: '0.25' },
        { share: '0.5' },
      ]).success,
    ).toBe(true);
  });
});
