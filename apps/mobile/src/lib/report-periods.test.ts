import { describe, expect, it } from 'vitest';
import { activePresetKey, periodPresets } from './report-periods';

// The reporting windows must resolve identically to web's, or the same ?from=&to=
// shows two different numbers on two clients. Computed in UTC on both.

// A fixed instant, so these assert the maths rather than today's date. Late
// August: month 7 zero-indexed, which puts the quarter start at July.
const now = new Date('2026-08-29T12:00:00Z');

describe('periodPresets', () => {
  const presets = periodPresets(now);
  const byKey = (k: string) => presets.find((p) => p.key === k);

  it('runs this month from the 1st to today', () => {
    expect(byKey('month')).toMatchObject({ from: '2026-08-01', to: '2026-08-29' });
  });

  it('starts the quarter at the quarter boundary, not this month', () => {
    expect(byKey('quarter')).toMatchObject({ from: '2026-07-01', to: '2026-08-29' });
  });

  it('runs year to date from 1 January', () => {
    expect(byKey('ytd')).toMatchObject({ from: '2026-01-01', to: '2026-08-29' });
  });

  it('closes last year at 31 December, not at today last year', () => {
    expect(byKey('lastyear')).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('puts the quarter start in the right place in January', () => {
    const jan = periodPresets(new Date('2026-01-15T12:00:00Z'));
    expect(jan.find((p) => p.key === 'quarter')?.from).toBe('2026-01-01');
  });

  it('puts the quarter start in the right place in December', () => {
    const dec = periodPresets(new Date('2026-12-31T12:00:00Z'));
    expect(dec.find((p) => p.key === 'quarter')?.from).toBe('2026-10-01');
  });
});

describe('activePresetKey', () => {
  const presets = periodPresets(now);

  it('names the preset when the window matches one exactly', () => {
    expect(activePresetKey(presets, '2026-01-01', '2026-08-29')).toBe('ytd');
  });

  it('is null for a hand-picked window, so nothing renders as selected', () => {
    expect(activePresetKey(presets, '2026-02-03', '2026-04-05')).toBeNull();
  });

  it('is null when only one end matches', () => {
    expect(activePresetKey(presets, '2026-01-01', '2026-06-30')).toBeNull();
  });
});
