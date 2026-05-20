import { COLORS } from '@thalermark/brand';
import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{html,svelte,ts}'],
  theme: {
    extend: {
      colors: {
        primary: COLORS.primary,
        accent: COLORS.accent,
      },
    },
  },
} satisfies Config;
