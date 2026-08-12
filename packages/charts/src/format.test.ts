import { describe, expect, it } from 'vitest';
import { formatTick, formatValue } from './format.js';

describe('formatValue', () => {
  it('prints money the way the rest of the product does', () => {
    expect(formatValue('1200.00')).toBe('$1,200.00');
    expect(formatValue('-450.50')).toBe('-$450.50');
  });

  // The guard-the-guard. It is not enough that null renders a dash — the dash
  // has to be about NULL and not about falsiness. A zero that prints '—' is
  // the same bug wearing the fix's clothes.
  it('dashes the unknown and prints the zero', () => {
    expect(formatValue(null)).toBe('—');
    expect(formatValue('0.00')).toBe('$0.00');
    expect(formatValue('')).toBe('—');
  });

  it('handles the other units', () => {
    expect(formatValue('0.42', 'percent')).toBe('42%');
    expect(formatValue('7.5', 'hours')).toBe('7.5h');
    expect(formatValue('31', 'count')).toBe('31');
    expect(formatValue(null, 'count')).toBe('—');
  });

  // A percentage axis reading '42.7%' is precision nobody asked for, and it
  // makes ticks different widths.
  it('rounds percentages to whole numbers', () => {
    expect(formatValue('0.427', 'percent')).toBe('43%');
  });
});

describe('formatTick', () => {
  // Axis ticks are the one place the full figure does not fit. $2.4K beats
  // $2,400.00 on a label 24 pixels wide.
  it('compacts money on an axis', () => {
    expect(formatTick('2400.00')).toBe('$2.4K');
    expect(formatTick('1200000.00')).toBe('$1.2M');
  });

  it('leaves small money alone', () => {
    expect(formatTick('450.00')).toBe('$450.00');
  });

  // Compacting a count of 2,400 saves nothing, and compacting hours would
  // round away the half that makes 7.5h worth printing.
  it('does not compact anything but money', () => {
    expect(formatTick('2400', 'count')).toBe('2,400');
    expect(formatTick('7.5', 'hours')).toBe('7.5h');
  });

  it('dashes the unknown here too', () => {
    expect(formatTick(null)).toBe('—');
  });
});
