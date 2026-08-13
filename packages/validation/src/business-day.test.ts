import { describe, expect, it } from 'vitest';
import { localDay, localDayPlus, localToday } from './business-day.js';

// The bug these exist to prevent was found on the first real card payment the
// product ever took: Stripe recorded the charge at 9:13 PM on 12 Aug local, and
// the app filed it on 13 Aug. Every case below is an evening in a US zone,
// because that is the entire failure mode.

describe('localDay', () => {
  // 2026-08-13T02:13Z is the instant of that charge: still the 12th in Chicago,
  // already the 13th in UTC.
  const chargeInstant = new Date('2026-08-13T02:13:00Z');

  it('files an evening charge on the local day, not the UTC one', () => {
    expect(localDay(chargeInstant, 'America/Chicago')).toBe('2026-08-12');
    expect(localDay(chargeInstant, 'UTC')).toBe('2026-08-13');
  });

  it('agrees with UTC during the middle of a local day', () => {
    const midday = new Date('2026-08-12T17:00:00Z');
    expect(localDay(midday, 'America/Chicago')).toBe('2026-08-12');
    expect(localDay(midday, 'UTC')).toBe('2026-08-12');
  });

  it('handles the year boundary — the case that moves income between tax years', () => {
    // 7pm Central on New Year's Eve. UTC has already rolled over; the business
    // has not, and the IRS cares about the business's year.
    const newYearsEve = new Date('2027-01-01T01:00:00Z');
    expect(localDay(newYearsEve, 'America/Chicago')).toBe('2026-12-31');
    expect(localDay(newYearsEve, 'UTC')).toBe('2027-01-01');
  });

  it('works east of UTC, where the drift runs the other way', () => {
    // Early morning in Auckland is still the previous day in UTC.
    const auckland = new Date('2026-08-12T20:00:00Z');
    expect(localDay(auckland, 'Pacific/Auckland')).toBe('2026-08-13');
    expect(localDay(auckland, 'UTC')).toBe('2026-08-12');
  });

  it('falls back to UTC on an unknown zone rather than throwing', () => {
    // A bad zone must not 500 the invoice form. Wrong by hours beats broken.
    expect(localDay(chargeInstant, 'Mars/Olympus_Mons')).toBe('2026-08-13');
  });
});

describe('localToday', () => {
  it('resolves the clock through the business zone', () => {
    const now = new Date('2026-08-13T02:13:00Z');
    expect(localToday('America/Chicago', now)).toBe('2026-08-12');
    expect(localToday('Pacific/Auckland', now)).toBe('2026-08-13');
  });
});

describe('localDayPlus', () => {
  it('adds calendar days to the local day, not seconds to an instant', () => {
    const now = new Date('2026-08-13T02:13:00Z');
    // Local day is the 12th, so Net 30 is 11 Sep — NOT 12 Sep, which is what
    // the UTC-derived date produced on INV-0008.
    expect(localDayPlus('America/Chicago', 30, now)).toBe('2026-09-11');
  });

  it('does not drift across a DST boundary', () => {
    // US DST ends 1 Nov 2026. Adding 30 days by milliseconds would land an hour
    // short and can tip the date; calendar arithmetic cannot.
    const beforeFallBack = new Date('2026-10-20T16:00:00Z');
    expect(localDayPlus('America/Chicago', 30, beforeFallBack)).toBe('2026-11-19');
  });

  it('rolls over month and year ends', () => {
    const dec = new Date('2026-12-20T18:00:00Z');
    expect(localDayPlus('America/Chicago', 30, dec)).toBe('2027-01-19');
  });
});
