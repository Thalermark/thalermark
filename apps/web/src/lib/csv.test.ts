import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

describe('toCsv', () => {
  it('joins rows with LF and ends on a trailing newline', () => {
    expect(
      toCsv([
        ['a', 'b'],
        ['c', 'd'],
      ]),
    ).toBe('a,b\nc,d\n');
  });

  it('renders numbers and treats null/undefined as empty cells', () => {
    expect(toCsv([['x', 1, null, undefined]])).toBe('x,1,,\n');
  });

  it('quotes cells containing a comma, quote, or newline and doubles inner quotes', () => {
    expect(toCsv([['plain', 'a,b', 'say "hi"', 'line1\nline2']])).toBe(
      'plain,"a,b","say ""hi""","line1\nline2"\n',
    );
  });

  it('emits just the trailing newline for an empty cell', () => {
    expect(toCsv([['']])).toBe('\n');
  });
});
