import { describe, expect, it } from 'vitest';
import { multiplyMoney } from './money.js';
import {
  MINUTES_IN_A_DAY,
  hoursFromMinutes,
  timeEntryCreateSchema,
  timeEntryUpdateSchema,
} from './time-entry.js';

const JOB_ID = '019fd457-2035-7280-b2d3-36443a17f218';

describe('hoursFromMinutes', () => {
  it('converts whole and part hours at 4dp', () => {
    expect(hoursFromMinutes(60)).toBe('1.0000');
    expect(hoursFromMinutes(30)).toBe('0.5000');
    expect(hoursFromMinutes(195)).toBe('3.2500');
    expect(hoursFromMinutes(1)).toBe('0.0167');
  });

  // 50 minutes is 0.8333... — the repeating case that proves the rounding step
  // exists and lands half-away-from-zero rather than truncating to 0.8333 by
  // accident of integer division.
  it('rounds a repeating decimal rather than truncating', () => {
    expect(hoursFromMinutes(50)).toBe('0.8333');
    expect(hoursFromMinutes(70)).toBe('1.1667');
  });

  // The property that matters: an hour line has to price identically to a
  // hand-typed one, because both go through multiplyMoney.
  it('prices through multiplyMoney the way a typed line would', () => {
    expect(multiplyMoney(hoursFromMinutes(195), '22.0000')).toBe('71.50');
    expect(multiplyMoney(hoursFromMinutes(90), '40.0000')).toBe('60.00');
    expect(multiplyMoney(hoursFromMinutes(60), '37.5000')).toBe('37.50');
  });
});

describe('timeEntryCreateSchema', () => {
  const valid = { jobId: JOB_ID, entryDate: '2026-06-01', minutes: 195 };

  it('accepts a minimal entry with no rate', () => {
    expect(timeEntryCreateSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a full day', () => {
    expect(timeEntryCreateSchema.safeParse({ ...valid, minutes: MINUTES_IN_A_DAY }).success).toBe(
      true,
    );
  });

  // "600" meant as 6:00 is the fat-finger this cap exists to catch.
  it('rejects more than a day against a single date', () => {
    expect(timeEntryCreateSchema.safeParse({ ...valid, minutes: 1441 }).success).toBe(false);
  });

  it('rejects zero, negative and fractional minutes', () => {
    for (const minutes of [0, -30, 12.5]) {
      expect(timeEntryCreateSchema.safeParse({ ...valid, minutes }).success).toBe(false);
    }
  });

  it('rejects a rate with more than 4 decimal places', () => {
    expect(timeEntryCreateSchema.safeParse({ ...valid, rate: '22.00001' }).success).toBe(false);
    expect(timeEntryCreateSchema.safeParse({ ...valid, rate: '22.0000' }).success).toBe(true);
  });
});

describe('timeEntryUpdateSchema', () => {
  it('accepts a single field', () => {
    expect(timeEntryUpdateSchema.safeParse({ minutes: 60 }).success).toBe(true);
  });

  it('rejects an empty patch', () => {
    expect(timeEntryUpdateSchema.safeParse({}).success).toBe(false);
  });

  // Moving an entry between jobs would restate two jobs' margins at once, so it
  // is a delete and a re-create. Billing state is likewise never client-asserted.
  it('ignores jobId and billedInvoiceId if a client sends them', () => {
    const parsed = timeEntryUpdateSchema.safeParse({
      minutes: 60,
      jobId: JOB_ID,
      billedInvoiceId: JOB_ID,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'jobId' in parsed.data).toBe(false);
    expect(parsed.success && 'billedInvoiceId' in parsed.data).toBe(false);
  });
});
