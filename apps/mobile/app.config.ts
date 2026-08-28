import { execSync } from 'node:child_process';
import type { ConfigContext, ExpoConfig } from 'expo/config';

// Dynamic config: keep app.json as the static base (Expo passes it in as
// `config`) and just add the build-time app version for Settings → About to read
// via Constants.expoConfig.extra.appVersion. Mirrors web's vite `define` and the
// api's resolveAppVersion, and must keep mirroring them: prefer an explicit
// APP_VERSION (EAS/CI), else the git description (--long, so it always carries
// the commit), else 'dev'.
function appVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    return execSync('git describe --tags --always --long', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

export default ({ config }: ConfigContext) =>
  ({
    ...config,
    extra: { ...config.extra, appVersion: appVersion() },
  }) as ExpoConfig;
