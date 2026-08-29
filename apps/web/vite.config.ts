import { execSync } from 'node:child_process';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The deployed app version, shown on Settings → About. Prefer an explicit
// build-arg (CI / Docker, where the build context has no .git), else derive it
// from the git description for local builds, else 'dev'. Baked into the bundle
// at build time via `define`, so there's no runtime env dependency — it's the
// version of THIS build, not whatever an env var happens to hold.
//
// Mirrored by the api (apps/api/src/env.ts) and mobile (app.config.ts). The
// three no longer resolve the same TAG — web-v*, api-v* and mobile-v* move
// independently because the three ship independently — but they must still
// resolve the same WAY, or About reports a mismatch that is not really there.
// Tags from before the split are the fallback. --long always carries the commit;
// --dirty is deliberately absent (it churned on every keystroke against a copy
// frozen at dev-server start).
function describeTag(match: string): string | undefined {
  try {
    return (
      execSync(`git describe --tags --match '${match}' --always --long`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function appVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  const own = describeTag('web-v*');
  if (own?.startsWith('web-v')) return own.slice('web-'.length);
  const legacy = describeTag('v*');
  if (legacy?.startsWith('v')) return legacy;
  return 'dev';
}

export default defineConfig({
  plugins: [sveltekit()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
});
