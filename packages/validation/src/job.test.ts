import { describe, expect, it } from 'vitest';
import { jobCreateSchema, jobUpdateSchema } from './job.js';

const COMPANY_ID = '019fd457-2035-7280-b2d3-3927b2294e58';
const CONTACT_ID = '019fd457-203b-7473-be42-53aafa1ab69f';

describe('jobCreateSchema', () => {
  it('accepts a name and nothing else', () => {
    const parsed = jobCreateSchema.safeParse({ companyId: COMPANY_ID, name: 'The Smith job' });
    expect(parsed.success).toBe(true);
  });

  it('trims the name and rejects a blank one', () => {
    const parsed = jobCreateSchema.safeParse({ companyId: COMPANY_ID, name: '  Deck rebuild  ' });
    expect(parsed.success && parsed.data.name).toBe('Deck rebuild');
    expect(jobCreateSchema.safeParse({ companyId: COMPANY_ID, name: '   ' }).success).toBe(false);
  });

  it('accepts a contact', () => {
    const parsed = jobCreateSchema.safeParse({
      companyId: COMPANY_ID,
      name: 'Tuesdays at the Chens',
      contactId: CONTACT_ID,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an end date before the start date', () => {
    const parsed = jobCreateSchema.safeParse({
      companyId: COMPANY_ID,
      name: 'The Smith job',
      startedOn: '2026-06-10',
      endedOn: '2026-06-01',
    });
    expect(parsed.success).toBe(false);
  });

  // Most jobs never get dates, and one date alone is perfectly ordinary — a job
  // that has started and not finished.
  it('accepts one date alone, or none', () => {
    for (const dates of [{}, { startedOn: '2026-06-01' }, { endedOn: '2026-06-01' }]) {
      const parsed = jobCreateSchema.safeParse({
        companyId: COMPANY_ID,
        name: 'The Smith job',
        ...dates,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('accepts a job that starts and ends the same day', () => {
    const parsed = jobCreateSchema.safeParse({
      companyId: COMPANY_ID,
      name: 'One-off clean',
      startedOn: '2026-06-01',
      endedOn: '2026-06-01',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('jobUpdateSchema', () => {
  it('accepts a single field', () => {
    expect(jobUpdateSchema.safeParse({ status: 'closed' }).success).toBe(true);
    expect(jobUpdateSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
  });

  it('rejects an empty patch', () => {
    expect(jobUpdateSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(jobUpdateSchema.safeParse({ status: 'invoiced' }).success).toBe(false);
  });

  it('allows clearing the contact and the dates', () => {
    const parsed = jobUpdateSchema.safeParse({ contactId: null, startedOn: null, endedOn: null });
    expect(parsed.success).toBe(true);
  });

  it('still catches a reversed date range on a patch', () => {
    const parsed = jobUpdateSchema.safeParse({ startedOn: '2026-06-10', endedOn: '2026-06-01' });
    expect(parsed.success).toBe(false);
  });
});
