import { describe, expect, it } from 'vitest';
import { COMMON_PASSWORDS_EXTRA } from './common-passwords.extra.js';
import { COMMON_PASSWORDS } from './common-passwords.generated.js';
import {
  MIN_PASSWORD_LENGTH,
  type StrengthLabel,
  checkPassword,
  estimatePasswordStrength,
} from './password-strength.js';

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

describe('common-password blocklist', () => {
  it('demotes listed passwords to Weak / 0 bits', () => {
    for (const pw of ['password', 'qwerty', COMMON_PASSWORDS[0]]) {
      const s = estimatePasswordStrength(pw);
      expect(s.score).toBe(0);
      expect(s.label).toBe('Weak');
      expect(s.bits).toBe(0);
    }
  });

  it('matches case-insensitively', () => {
    expect(estimatePasswordStrength('PASSWORD').score).toBe(0);
    expect(estimatePasswordStrength('Password').score).toBe(0);
  });

  it('overrides the entropy score — an off-list twin scores higher', () => {
    // 'usuckballz1' is long + mixed (~35 bits, which would be Fair on entropy
    // alone), but it's in the breach list, so it must read Weak. Flipping the
    // last char off-list proves the demotion is the list's doing, not the math.
    expect(COMMON_PASSWORDS).toContain('usuckballz1');
    expect(estimatePasswordStrength('usuckballz1').score).toBe(0);
    expect(COMMON_PASSWORDS).not.toContain('usuckballz2');
    expect(estimatePasswordStrength('usuckballz2').score).toBeGreaterThan(0);
  });

  it('ships a normalized, non-trivial list', () => {
    expect(COMMON_PASSWORDS.length).toBeGreaterThan(900);
    expect(COMMON_PASSWORDS.every((p) => p === p.toLowerCase())).toBe(true);
    expect(new Set(COMMON_PASSWORDS).size).toBe(COMMON_PASSWORDS.length);
  });

  it('blocks every entry on the hand-maintained extra list (case-insensitive)', () => {
    for (const pw of COMMON_PASSWORDS_EXTRA) {
      expect(estimatePasswordStrength(pw).score).toBe(0);
      expect(estimatePasswordStrength(pw.toUpperCase()).score).toBe(0);
    }
  });
});

describe('checkPassword (signup policy)', () => {
  it('rejects passwords under the minimum length', () => {
    const r = checkPassword('aB3$xY9'); // 7 chars, otherwise diverse
    expect(r.ok).toBe(false);
    expect(r.message).toContain(String(MIN_PASSWORD_LENGTH));
  });

  it('rejects long-but-weak passwords (score 0)', () => {
    const r = checkPassword('aaaaaaaaaa'); // 10 chars, 0 bits
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/weak/i);
  });

  it('rejects a common password reported as weak', () => {
    // 'usuckballz1' is 11 chars (clears length) but on the breach list -> score 0.
    expect(checkPassword('usuckballz1').ok).toBe(false);
  });

  it('accepts a sufficiently long, non-weak password', () => {
    expect(checkPassword('river-otter-9-lamp')).toEqual({ ok: true, message: '' });
    expect(checkPassword('Maple7Leaf!x').ok).toBe(true); // 12 chars, Good
  });
});
