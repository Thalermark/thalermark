import { describe, expect, it } from 'vitest';
import { maxValue, runs, toNumber } from './value.js';

// The decimal-string boundary. Every assertion here is about one distinction:
// a value we do not have is not a value of zero.

describe('toNumber', () => {
  it('reads a decimal string', () => {
    expect(toNumber('1200.50')).toBe(1200.5);
    expect(toNumber('-450.00')).toBe(-450);
  });

  // THE test in this file. A recorded zero is a fact and must survive as 0;
  // an absent value must survive as null. Collapsing the two is the bug that
  // told a landscaper he had lost money on a job.
  it('keeps zero and unknown apart', () => {
    expect(toNumber('0.00')).toBe(0);
    expect(toNumber(null)).toBeNull();
  });

  it('treats blank and unparseable as unknown, not zero', () => {
    expect(toNumber('')).toBeNull();
    expect(toNumber('   ')).toBeNull();
    expect(toNumber('n/a')).toBeNull();
    // Infinity is finite-checked too — an overflowed aggregate is not a number
    // anyone should see plotted.
    expect(toNumber('Infinity')).toBeNull();
  });
});

describe('runs', () => {
  // A line must BREAK at a gap rather than draw through it. Interpolating
  // across April and May invents two months of data and draws them confidently.
  it('splits a series at the gaps', () => {
    expect(runs(['1', null, '3'])).toEqual([
      { start: 0, values: [1] },
      { start: 2, values: [3] },
    ]);
  });

  it('carries the index each run began at', () => {
    expect(runs([null, null, '5', '6'])).toEqual([{ start: 2, values: [5, 6] }]);
  });

  it('a zero is part of a run, not a break in it', () => {
    expect(runs(['1', '0.00', '3'])).toEqual([{ start: 0, values: [1, 0, 3] }]);
  });

  it('an all-null series has no runs at all', () => {
    expect(runs([null, null])).toEqual([]);
    expect(runs([])).toEqual([]);
  });
});

describe('maxValue', () => {
  it('ignores the gaps', () => {
    expect(maxValue(['100', null, '250'])).toBe(250);
  });

  // Null rather than 0, so a caller can tell "every month was zero" (a flat
  // axis is the right answer) from "we have no months" (the empty copy is).
  it('is null when nothing is known, and 0 when zero is known', () => {
    expect(maxValue([null, null])).toBeNull();
    expect(maxValue([])).toBeNull();
    expect(maxValue(['0.00', '0.00'])).toBe(0);
  });
});
