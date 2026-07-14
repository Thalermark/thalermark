// Font stacks mirror spikes/thalermark-landing.html. Fraunces for headings
// (optical sizing 'opsz' 144 on display sizes), Inter for body, JetBrains
// Mono for eyebrows and labels.
export const FONTS = {
  serif: ['Fraunces', 'serif'],
  sans: ['Inter', 'sans-serif'],
  mono: ['JetBrains Mono', 'monospace'],
} as const;

// Same-origin stylesheet that @font-face-declares the three families above,
// self-hosted (no third-party font requests) at apps/web/static/brand-fonts.css.
// Root-relative; consumers that need an absolute URL (e.g. Stripe's Payment
// Element fonts.cssSrc, which is fetched inside Stripe's iframe) resolve it
// against their origin. Centralized so every consumer stays in lockstep.
export const BRAND_FONTS_HREF = '/brand-fonts.css';
