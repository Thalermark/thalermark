export const COLORS = {
  primary: {
    50: '#f5f7fa',
    100: '#e4e7eb',
    200: '#cbd2d9',
    300: '#9aa5b1',
    400: '#7b8794',
    500: '#616e7c',
    600: '#52606d',
    700: '#3e4c59',
    800: '#323f4b',
    900: '#1f2933',
  },
  accent: {
    500: '#b45309',
    600: '#92400e',
    700: '#78350f',
  },
} as const;

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
