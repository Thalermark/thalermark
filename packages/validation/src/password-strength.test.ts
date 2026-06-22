import { describe, expect, it } from 'vitest';
import { type StrengthLabel, estimatePasswordStrength } from './password-strength.js';

describe('estimatePasswordStrength', () => {
  it('returns 0 bits / Weak for empty input', () => {
    const s = estimatePasswordStrength('');
    expect(s.bits).toBe(0);
    expect(s.score).toBe(0);
    expect(s.label).toBe('Weak');
  });

  it('collapses all-same-character input to 0 bits regardless of length', () => {
    expect(estimatePasswordStrength('aaaaaaaaaaaa').bits).toBe(0);
    expect(estimatePasswordStrength('aaaaaaaaaaaa').label).toBe('Weak');
  });

  it('computes L * log2(distinct N)', () => {
    // 'abcd' -> N=4, L=4 -> 4 * 2 = 8 bits
    expect(estimatePasswordStrength('abcd').bits).toBeCloseTo(8, 5);
    // 'abab' -> N=2, L=4 -> 4 * 1 = 4 bits (repetition is not free)
    expect(estimatePasswordStrength('abab').bits).toBeCloseTo(4, 5);
  });

  it('counts distinct characters by code point, not UTF-16 unit', () => {
    // Two distinct emoji, each a surrogate pair -> N=2, L=2 -> 2 bits.
    // A naive .length / Set-of-chars would see 4 units and miscount.
    expect(estimatePasswordStrength('\u{1F600}\u{1F389}').bits).toBeCloseTo(2, 5);
  });

  // Anchor passwords that calibrate the bands. These label assignments are the
  // contract the meter UI renders against — keep them stable; a change here
  // means the bands moved and the meter's colors shift under users.
  const anchors: Array<[string, StrengthLabel]> = [
    ['password', 'Weak'],
    ['Sunshine1', 'Weak'],
    ['BlueSky42!', 'Fair'],
    ['Maple7Leaf!x', 'Good'],
    ['Th1stle$Garden', 'Strong'],
    ['river-otter-9-lamp', 'Strong'],
  ];
  for (const [pw, label] of anchors) {
    it(`rates "${pw}" as ${label}`, () => {
      expect(estimatePasswordStrength(pw).label).toBe(label);
    });
  }

  it('score index stays aligned with the label band', () => {
    expect(estimatePasswordStrength('').score).toBe(0);
    expect(estimatePasswordStrength('BlueSky42!').score).toBe(1);
    expect(estimatePasswordStrength('Maple7Leaf!x').score).toBe(2);
    expect(estimatePasswordStrength('river-otter-9-lamp').score).toBe(3);
  });
});
