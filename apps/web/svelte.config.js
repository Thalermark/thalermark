import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { loadEnv } from 'vite';

// The browser's API + auth calls go to PUBLIC_API_URL. In the Caddy self-host
// build it's empty (same-origin /api → 'self' covers it), but in dev it's an
// absolute cross-origin URL (e.g. http://localhost:3001), which 'self' would
// block. Add that origin to connect-src when — and only when — it's absolute,
// so the policy self-adjusts to the topology instead of hardcoding a port.
const apiUrl = loadEnv(
  process.env.NODE_ENV ?? 'development',
  process.cwd(),
  'PUBLIC_',
).PUBLIC_API_URL;
let apiOrigin = null;
try {
  if (apiUrl) apiOrigin = new URL(apiUrl).origin;
} catch {
  // Relative value (e.g. /api) — same-origin, already covered by 'self'.
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // Content-Security-Policy. SvelteKit renders per-request and stamps its own
    // scripts (hydration + serialized data) with a nonce, which it appends to
    // `script-src` automatically — so injected inline scripts won't run. The
    // hand-written theme script in app.html carries `nonce="%sveltekit.nonce%"`
    // to ride the same nonce. `style-src` keeps 'unsafe-inline' (inline style
    // attributes like the report bars can't be nonced, and CSS can't exfiltrate
    // a card), and because that keyword is present SvelteKit adds no style
    // nonce/hash. Stripe.js + its iframes are allowed for the public /pay view;
    // everything else — fonts, error-tracking tunnel (/monitoring), address
    // autocomplete proxy, logo images — is same-origin (plus the cross-origin
    // API in dev, see apiOrigin above). The other security headers (HSTS,
    // nosniff, X-Frame-Options, Referrer/Permissions-Policy) are set by
    // docker/Caddyfile; this is the one header that needs the nonce.
    csp: {
      mode: 'auto',
      directives: {
        'default-src': ['self'],
        'script-src': ['self', 'https://js.stripe.com'],
        'style-src': ['self', 'unsafe-inline'],
        'img-src': ['self', 'data:'],
        'font-src': ['self'],
        'connect-src': ['self', 'https://api.stripe.com', ...(apiOrigin ? [apiOrigin] : [])],
        'frame-src': ['https://js.stripe.com', 'https://hooks.stripe.com'],
        'base-uri': ['self'],
        // Chrome (unlike Firefox) re-checks `form-action` against the redirect
        // target, not just the form's action URL. Settings → Payments posts to
        // its own `?/onboard` action, which 303s to the Stripe Account Link, so
        // 'self' alone blocks Connect onboarding at the redirect — and the
        // console blames the same-origin action URL, which reads as nonsense.
        // This is the only off-site form redirect in the app.
        'form-action': ['self', 'https://connect.stripe.com'],
        'frame-ancestors': ['none'],
        'object-src': ['none'],
      },
    },
  },
};

export default config;
