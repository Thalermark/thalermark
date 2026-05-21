import { COLORS, FONTS } from '@thalermark/brand';
import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{html,svelte,ts}'],
  theme: {
    extend: {
      colors: {
        ink: COLORS.ink,
        cream: COLORS.cream,
        gold: COLORS.gold,
        navy: COLORS.navy,
        sage: COLORS.accents.sage,
        copper: COLORS.accents.copper,
        slate: COLORS.accents.slate,
        oxblood: COLORS.accents.oxblood,
      },
      fontFamily: {
        serif: FONTS.serif,
        sans: FONTS.sans,
        mono: FONTS.mono,
      },
    },
  },
} satisfies Config;
