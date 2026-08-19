import { COLORS, FONTS } from '@thalermark/brand';
// @ts-expect-error — nativewind/preset has no published types in 4.x
import nativewindPreset from 'nativewind/preset';
import type { Config } from 'tailwindcss';

// `ink` and `cream` are ROLES, not fixed colours (TMC-279). They resolve to the
// CSS variables in src/global.css, which flip with the system appearance, so
// every existing text-ink / bg-cream / bg-ink inverts in dark mode without
// touching the 2,731 call sites that use them. In dark, `ink` IS cream and
// `cream` IS navy — the names read oddly there, exactly as web's `--fg` does,
// and that is the price of not rewriting every screen.
//
// The literal palette stays available as `palette-*` for the few places that
// mean a specific colour rather than a role (brand marks, the splash screen).
const role = (v: string) => `rgb(var(${v}) / <alpha-value>)`;

export default {
  content: ['./src/**/*.{ts,tsx}'],
  presets: [nativewindPreset],
  theme: {
    extend: {
      colors: {
        // Roles — these flip.
        ink: {
          DEFAULT: role('--fg'),
          muted: role('--fg-muted'),
          subtle: role('--fg-subtle'),
        },
        cream: {
          DEFAULT: role('--bg'),
          warm: role('--bg-raised'),
        },
        // The input boundary. Its own token because it is the one border that
        // must clear the 3:1 UI-component rule; decorative hairlines elsewhere
        // are not UI components and keep their whisper-thin ink/10.
        field: role('--field'),
        gold: {
          ...COLORS.gold,
          deep: role('--accent'),
        },
        oxblood: role('--danger'),
        navy: COLORS.navy,
        sage: COLORS.accents.sage,
        copper: COLORS.accents.copper,
        slate: COLORS.accents.slate,
        // Fixed palette, for anything that must not flip.
        palette: {
          ink: COLORS.ink,
          cream: COLORS.cream.DEFAULT,
          'cream-warm': COLORS.cream.warm,
        },
      },
      fontFamily: {
        serif: [...FONTS.serif],
        sans: [...FONTS.sans],
        mono: [...FONTS.mono],
      },
    },
  },
} satisfies Config;
