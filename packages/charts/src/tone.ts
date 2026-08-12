import type { SeriesTone } from './types.js';

// The one indirection between "what this series means" and "which brand role
// paints it". Six names in, five roles out (muted is an opacity of --fg rather
// than a role of its own).
//
// Kept as data rather than a switch so both platforms iterate the same table,
// and so a new tone is one line that fails typecheck on whichever client has
// not handled it.
export const TONE_ROLE = {
  primary: 'accent',
  secondary: 'warning',
  positive: 'success',
  negative: 'danger',
  neutral: 'info',
  muted: 'fg',
} as const satisfies Record<SeriesTone, string>;

export type ChartRole = (typeof TONE_ROLE)[SeriesTone];

export function toneToRole(tone: SeriesTone = 'primary'): ChartRole {
  return TONE_ROLE[tone];
}

// The default order a multi-series chart walks when no tone is given.
//
// Gold first because it is the brand's accent and a one-series chart should be
// gold. Copper second because it is the only other colour in the palette that
// reads as a subject rather than a status — sage and oxblood mean "good" and
// "bad" and must not be spent on "the second thing".
export const TONE_SEQUENCE: readonly SeriesTone[] = [
  'primary',
  'secondary',
  'neutral',
  'positive',
  'negative',
];

// Tone for the nth series when the caller did not name one.
export function toneForIndex(index: number): SeriesTone {
  return TONE_SEQUENCE[index % TONE_SEQUENCE.length] as SeriesTone;
}
