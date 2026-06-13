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
