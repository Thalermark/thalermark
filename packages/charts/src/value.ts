import type { ChartValue } from './types.js';

// The decimal-string boundary, in one place.
//
// Money crosses this product's API as a string and null is a real answer, so
// every chart needs the same two conversions and they have to agree. Putting
// them here rather than in each component is what makes the job-margin lesson
// testable — see formatValue below.

// A decimal string to a number, preserving "we do not know".
//
// null stays null. So does '' and anything non-finite: a blank cell and a
// missing cell mean the same thing to a reader, and neither means zero. '0.00'
// becomes 0, because a recorded zero IS a fact.
export function toNumber(value: ChartValue): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// Split a series into contiguous runs of known values.
//
// This is what makes a line BREAK at a null instead of drawing through it. A
// line interpolated across a gap invents data — it draws a confident diagonal
// between March and June and implies April and May sat on it. Each run carries
// the index it started at so a renderer can position it without re-scanning.
export function runs(values: readonly ChartValue[]): { start: number; values: number[] }[] {
  const out: { start: number; values: number[] }[] = [];
  let current: { start: number; values: number[] } | null = null;

  values.forEach((raw, index) => {
    const n = toNumber(raw);
    if (n === null) {
      current = null;
      return;
    }
    if (!current) {
      current = { start: index, values: [] };
      out.push(current);
    }
    current.values.push(n);
  });

  return out;
}

// The largest known value, or null when nothing is known.
//
// Returns null rather than 0 for an all-null series so a caller can tell "every
// month was zero" from "we have no months" — the first deserves a flat axis,
// the second deserves the empty copy.
export function maxValue(values: readonly ChartValue[]): number | null {
  let max: number | null = null;
  for (const raw of values) {
    const n = toNumber(raw);
    if (n === null) continue;
    if (max === null || n > max) max = n;
  }
  return max;
}
