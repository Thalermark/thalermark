// Brand palette. Mirrors the CSS custom properties in
// spikes/thalermark-landing.html — keep the template authoritative; if the
// template changes, update these values to match.
export const COLORS = {
  ink: '#0f1626',
  cream: {
    DEFAULT: '#f4ede0',
    warm: '#ebe0cc',
  },
  gold: {
    DEFAULT: '#c8a663',
    deep: '#9a7d3f',
    light: '#e8d5a3',
  },
  navy: {
    DEFAULT: '#1a2238',
    deep: '#0f1626',
  },
  accents: {
    sage: '#5c7b3f',
    copper: '#b87333',
    slate: '#3d5a6c',
    oxblood: '#8b3a2e',
  },
} as const;

// Palette for the deterministic initial-bubble avatar used in UserMenu.
// Kept separate from the brand palette intentionally — these are warm,
// saturated hues meant to differentiate users at a glance, not to match
// the brand surface.
export const INITIAL_BUBBLE_PALETTE = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#84cc16',
  '#22c55e',
  '#10b981',
  '#14b8a6',
  '#06b6d4',
  '#0ea5e9',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#d946ef',
  '#ec4899',
  '#f43f5e',
] as const;

export function initialBubbleColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % INITIAL_BUBBLE_PALETTE.length;
  return INITIAL_BUBBLE_PALETTE[idx] as string;
}
