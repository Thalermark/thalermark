import { describe, expect, it } from 'vitest';
import { multiplyMoney } from './money.js';
import {
  MINUTES_IN_A_DAY,
  billingUnitLabel,
  formatClockTime,
  hoursFromMinutes,
  hoursUnitLabel,
  minutesFromClockSpan,
  minutesFromDuration,
  timeEntryCreateSchema,
  timeEntryLineDescription,
  timeEntryQuantity,
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

describe('minutesFromDuration', () => {
  it('reads decimal hours', () => {
    expect(minutesFromDuration('3.25')).toBe(195);
    expect(minutesFromDuration('1')).toBe(60);
    expect(minutesFromDuration('0.5')).toBe(30);
  });

  it('reads h:mm', () => {
    expect(minutesFromDuration('3:15')).toBe(195);
    expect(minutesFromDuration('0:45')).toBe(45);
    expect(minutesFromDuration('12:00')).toBe(720);
  });

  // The two notations have to mean the same thing, or the same job reads
  // differently depending on how the user happened to type it.
  it('agrees between the two notations', () => {
    expect(minutesFromDuration('3:15')).toBe(minutesFromDuration('3.25'));
    expect(minutesFromDuration('1:30')).toBe(minutesFromDuration('1.5'));
  });

  it('tolerates surrounding whitespace', () => {
    expect(minutesFromDuration('  2.5  ')).toBe(150);
  });

  // Null, not 0 — the caller turns it into a field error rather than logging an
  // entry the user never meant.
  it('rejects what it cannot read', () => {
    for (const raw of ['', '   ', 'abc', '3h15', '-2', '3:75', '3:5', '0', '0:00']) {
      expect(minutesFromDuration(raw)).toBeNull();
    }
  });

  it('round-trips through hoursFromMinutes for exact quarters', () => {
    for (const typed of ['0.25', '1.5', '3.25', '8']) {
      const minutes = minutesFromDuration(typed);
      expect(minutes).not.toBeNull();
      expect(Number(hoursFromMinutes(minutes as number))).toBe(Number(typed));
    }
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

describe('timeEntryLineDescription', () => {
  it('leads with the date so repeated work does not read as one charge listed twice', () => {
    // The dog sitter case (TMC-263): three days of the same note used to render
    // three identical lines, which a customer reads as a duplicate.
    const days = ['2026-08-12', '2026-08-13', '2026-08-14'].map((entryDate) =>
      timeEntryLineDescription({ entryDate, note: 'Dog sitting', jobName: 'Sadie sitting' }),
    );
    expect(days).toEqual(['Aug 12 · Dog sitting', 'Aug 13 · Dog sitting', 'Aug 14 · Dog sitting']);
    expect(new Set(days).size).toBe(3);
  });

  it('falls back to the job name, not to the word Hours', () => {
    expect(
      timeEntryLineDescription({ entryDate: '2026-08-12', note: null, jobName: 'Sadie sitting' }),
    ).toBe('Aug 12 · Sadie sitting');
    expect(
      timeEntryLineDescription({ entryDate: '2026-08-12', note: '   ', jobName: 'Sadie sitting' }),
    ).toBe('Aug 12 · Sadie sitting');
  });

  it('still says something when neither a note nor a job name is available', () => {
    expect(timeEntryLineDescription({ entryDate: '2026-08-12' })).toBe('Aug 12 · Hours');
  });
});

describe('hoursUnitLabel', () => {
  it('agrees with the quantity beside it', () => {
    expect(hoursUnitLabel(hoursFromMinutes(60))).toBe('hour');
    expect(hoursUnitLabel(hoursFromMinutes(180))).toBe('hours');
    expect(hoursUnitLabel(hoursFromMinutes(30))).toBe('hours');
    expect(hoursUnitLabel(hoursFromMinutes(50))).toBe('hours');
  });

  it('treats a trimmed and an untrimmed one as the same quantity', () => {
    expect(hoursUnitLabel('1.0000')).toBe('hour');
    expect(hoursUnitLabel('1')).toBe('hour');
  });
});

describe('minutesFromClockSpan', () => {
  it('reads a plain shift', () => {
    expect(minutesFromClockSpan('08:15', '16:30')).toEqual({
      minutes: 495,
      crossesMidnight: false,
    });
    // The estate-sale contractor's case from TMC-265: knows the clock, not the
    // decimal. 8:15 to 4:30 is 8.25 hours and nobody should have to work it out.
    expect(hoursFromMinutes(495)).toBe('8.2500');
  });

  it('treats an end before the start as the next day, in ONE entry', () => {
    // Owner decision 2026-08-22: detect and confirm, do not split. Someone
    // reaching for a time card wants the hours, not a lesson about midnight.
    expect(minutesFromClockSpan('22:00', '06:00')).toEqual({
      minutes: 480,
      crossesMidnight: true,
    });
  });

  it('keeps an overnight span inside the one-day cap', () => {
    // TMC-265 framed the cap as a conflict needing an exception. It is not: the
    // cap rejects an entry LONGER than 24 hours and says nothing about crossing
    // midnight. The longest possible crossing span is one minute under the cap.
    const span = minutesFromClockSpan('00:01', '00:00');
    expect(span?.minutes).toBe(MINUTES_IN_A_DAY - 1);
    expect(span?.minutes).toBeLessThanOrEqual(MINUTES_IN_A_DAY);
  });

  it('accepts the seconds an input type=time can emit', () => {
    expect(minutesFromClockSpan('08:15:00', '16:30:00')?.minutes).toBe(495);
  });

  it('refuses a zero-length shift rather than logging nothing', () => {
    expect(minutesFromClockSpan('09:00', '09:00')).toBeNull();
  });

  it('refuses what it cannot read instead of guessing', () => {
    for (const [a, b] of [
      ['', '10:00'],
      ['25:00', '10:00'],
      ['9', '10:00'],
      ['09:60', '10:00'],
      ['9am', '5pm'],
    ]) {
      expect(minutesFromClockSpan(a as string, b as string)).toBeNull();
    }
  });
});

describe('billingUnitLabel', () => {
  it('pluralises every unit in the closed set', () => {
    expect(billingUnitLabel('visit', '1')).toBe('visit');
    expect(billingUnitLabel('visit', '3')).toBe('visits');
    expect(billingUnitLabel('night', '1')).toBe('night');
    expect(billingUnitLabel('night', '2')).toBe('nights');
    expect(billingUnitLabel('day', '1')).toBe('day');
    expect(billingUnitLabel('day', '5')).toBe('days');
    expect(billingUnitLabel('job', '1')).toBe('job');
    expect(billingUnitLabel('hour', '1.0000')).toBe('hour');
    expect(billingUnitLabel('hour', '0.5000')).toBe('hours');
  });

  it('falls back to hours for a unit it does not know', () => {
    // 'hour' is the column default, so a row written before TMC-264 means hours.
    expect(billingUnitLabel('yard', '3')).toBe('hours');
  });
});

describe('timeEntryQuantity', () => {
  it('derives from minutes on an hourly job, exactly as before', () => {
    expect(timeEntryQuantity({ minutes: 195, quantity: null }, 'hour')).toBe('3.2500');
  });

  // The defect TMC-264 exists to prevent. Three 30-minute visits are minutes=90;
  // deriving the quantity would invoice "1.5 visits", which the customer can see
  // is wrong.
  it('bills the COUNT on a per-visit job, never the derived hours', () => {
    expect(timeEntryQuantity({ minutes: 90, quantity: '3.0000' }, 'visit')).toBe('3.0000');
  });

  it('ignores a recorded duration when the job does not bill by it', () => {
    // The duration is still stored, and still feeds effective-hourly. It just
    // has no say in what goes on the invoice.
    expect(timeEntryQuantity({ minutes: 30, quantity: '1.0000' }, 'night')).toBe('1.0000');
  });

  it('is null when there is nothing to bill in the job’s unit', () => {
    expect(timeEntryQuantity({ minutes: null, quantity: null }, 'hour')).toBeNull();
    expect(timeEntryQuantity({ minutes: 90, quantity: null }, 'visit')).toBeNull();
  });
});

describe('timeEntryLineDescription with clock times', () => {
  it('says when the work happened when it knows', () => {
    expect(
      timeEntryLineDescription({
        entryDate: '2026-08-12',
        note: 'Overnight stay',
        startTime: '19:00',
        endTime: '07:00',
      }),
    ).toBe('Aug 12, 7:00pm to 7:00am · Overnight stay');
  });

  it('is unchanged for a typed or stopwatch entry', () => {
    expect(timeEntryLineDescription({ entryDate: '2026-08-12', note: 'Dog sitting' })).toBe(
      'Aug 12 · Dog sitting',
    );
  });

  it('needs both times before it claims a span', () => {
    expect(
      timeEntryLineDescription({ entryDate: '2026-08-12', note: 'X', startTime: '09:00' }),
    ).toBe('Aug 12 · X');
  });
});

describe('formatClockTime', () => {
  it('reads as a member of the public would say it', () => {
    expect(formatClockTime('00:00')).toBe('12:00am');
    expect(formatClockTime('07:00')).toBe('7:00am');
    expect(formatClockTime('12:00')).toBe('12:00pm');
    expect(formatClockTime('15:30')).toBe('3:30pm');
    expect(formatClockTime('23:59')).toBe('11:59pm');
  });
});
