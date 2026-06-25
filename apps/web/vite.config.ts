import { execSync } from 'node:child_process';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The deployed app version, shown on Settings → About. Prefer an explicit
// build-arg (CI / Docker, where the build context has no .git), else derive it
// from the git release tag for local builds, else 'dev'. Baked into the bundle
// at build time via `define`, so there's no runtime env dependency — it's the
// version of THIS build, not whatever an env var happens to hold.
function appVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    return execSync('git describe --tags --always --dirty', { encoding: 'utf8' }).trim();
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
