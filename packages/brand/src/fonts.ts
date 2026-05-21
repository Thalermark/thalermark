// Font stacks mirror spikes/thalermark-landing.html. Fraunces for headings
// (optical sizing 'opsz' 144 on display sizes), Inter for body, JetBrains
// Mono for eyebrows and labels.
export const FONTS = {
  serif: ['Fraunces', 'serif'],
  sans: ['Inter', 'sans-serif'],
  mono: ['JetBrains Mono', 'monospace'],
} as const;

// Single Google Fonts URL bundling the three families with the weights and
// axes the landing template uses. Centralized so apps/web/src/app.html and
// any future consumer stay in lockstep.
export const GOOGLE_FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap';
