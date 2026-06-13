import { COLORS, FONTS } from '@thalermark/brand';
import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{html,svelte,ts}'],
  theme: {
    extend: {
      colors: {
        // Literal brand palette — theme-independent, retained for decorative
        // accents and during the semantic-token migration.
        ink: COLORS.ink,
        cream: COLORS.cream,
        gold: COLORS.gold,
        navy: COLORS.navy,
        sage: COLORS.accents.sage,
        copper: COLORS.accents.copper,
        slate: COLORS.accents.slate,
        oxblood: COLORS.accents.oxblood,
        // Semantic role tokens — defined as RGB channels in app.css :root so a
        // future dark theme can remap them in one place. The `<alpha-value>`
        // placeholder keeps Tailwind opacity modifiers (text-fg/50) working.
        surface: 'rgb(var(--surface) / <alpha-value>)',
        'surface-2': 'rgb(var(--surface-2) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        inverse: 'rgb(var(--inverse) / <alpha-value>)',
        'on-inverse': 'rgb(var(--on-inverse) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        success: 'rgb(var(--success) / <alpha-value>)',
        warning: 'rgb(var(--warning) / <alpha-value>)',
        info: 'rgb(var(--info) / <alpha-value>)',
      },
      fontFamily: {
        serif: FONTS.serif,
        sans: FONTS.sans,
        mono: FONTS.mono,
      },
    },
  },
} satisfies Config;
