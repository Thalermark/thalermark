import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

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
    // autocomplete proxy, logo images — is same-origin. The other security
    // headers (HSTS, nosniff, X-Frame-Options, Referrer/Permissions-Policy)
    // are set by docker/Caddyfile; this is the one header that needs the nonce.
    csp: {
      mode: 'auto',
      directives: {
        'default-src': ['self'],
        'script-src': ['self', 'https://js.stripe.com'],
        'style-src': ['self', 'unsafe-inline'],
        'img-src': ['self', 'data:'],
        'font-src': ['self'],
        'connect-src': ['self', 'https://api.stripe.com'],
        'frame-src': ['https://js.stripe.com', 'https://hooks.stripe.com'],
        'base-uri': ['self'],
        'form-action': ['self'],
        'frame-ancestors': ['none'],
        'object-src': ['none'],
      },
    },
  },
};

export default config;
