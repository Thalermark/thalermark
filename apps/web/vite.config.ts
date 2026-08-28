import { execSync } from 'node:child_process';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The deployed app version, shown on Settings → About. Prefer an explicit
// build-arg (CI / Docker, where the build context has no .git), else derive it
// from the git description for local builds, else 'dev'. Baked into the bundle
// at build time via `define`, so there's no runtime env dependency — it's the
// version of THIS build, not whatever an env var happens to hold.
//
// This ladder is mirrored by the api (apps/api/src/env.ts resolveAppVersion) and
// mobile (app.config.ts), and the three must stay identical: About now shows this
// number beside the one the api reports, so any difference in how they're derived
// reads to the user as a mismatched deployment. --long always carries the commit;
// --dirty is deliberately absent (it churned on every keystroke against a copy
// frozen at dev-server start).
function appVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    return execSync('git describe --tags --always --long', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  plugins: [sveltekit()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
});
