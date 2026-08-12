import { describe, expect, it } from 'vitest';
import { TONE_ROLE, TONE_SEQUENCE, toneForIndex, toneToRole } from './tone.js';

describe('toneToRole', () => {
  it('maps meaning to a brand role', () => {
    expect(toneToRole('positive')).toBe('success');
    expect(toneToRole('negative')).toBe('danger');
  });

  it('defaults to the accent, so a one-series chart is gold', () => {
    expect(toneToRole()).toBe('accent');
    expect(toneToRole('primary')).toBe('accent');
  });

  // Guards the guard: a tone added to the union without a role would fail
  // typecheck, but a role silently renamed would not — this catches the pair
  // going out of step.
  it('has a role for every tone', () => {
    const tones = Object.keys(TONE_ROLE);
    expect(tones).toHaveLength(6);
    for (const tone of tones) {
      expect(TONE_ROLE[tone as keyof typeof TONE_ROLE]).toBeTruthy();
    }
  });
});

describe('toneForIndex', () => {
  it('gives the first series the accent', () => {
    expect(toneForIndex(0)).toBe('primary');
  });

  // Sage and oxblood mean "good" and "bad" everywhere else in the product.
  // Spending them on "the second series" would make a neutral comparison read
  // as a judgement, so they come last in the sequence.
  it('does not reach for a status colour second', () => {
    expect(toneForIndex(1)).toBe('secondary');
    expect(toneForIndex(2)).toBe('neutral');
  });

  it('wraps rather than running out', () => {
    expect(toneForIndex(TONE_SEQUENCE.length)).toBe(toneForIndex(0));
  });
});
