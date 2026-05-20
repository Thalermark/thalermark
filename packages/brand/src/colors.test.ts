import { describe, expect, it } from 'vitest';
import { INITIAL_BUBBLE_PALETTE, initialBubbleColor } from './colors.js';

describe('initialBubbleColor', () => {
  it('returns a color from the palette', () => {
    expect(INITIAL_BUBBLE_PALETTE).toContain(initialBubbleColor('Sean'));
  });

  it('is deterministic for the same seed', () => {
    expect(initialBubbleColor('Acme Co')).toBe(initialBubbleColor('Acme Co'));
  });

  it('handles empty seed', () => {
    expect(INITIAL_BUBBLE_PALETTE).toContain(initialBubbleColor(''));
  });
});
