import { execSync } from 'node:child_process';
import type { ConfigContext, ExpoConfig } from 'expo/config';

// Dynamic config: keep app.json as the static base (Expo passes it in as
// `config`) and just add the build-time app version for Settings → About to read
// via Constants.expoConfig.extra.appVersion.
//
// android and ios build from this one source, so no diff can tell them apart and
// they share the mobile-v* line. What differs between the two stores is which
// build each has accepted, which is ios.buildNumber / android.versionCode, not a
// version. Resolved the same WAY as web and the api, just from a different tag
// line; pre-split tags are the fallback.
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
  const own = describeTag('mobile-v*');
  if (own?.startsWith('mobile-v')) return own.slice('mobile-'.length);
  const legacy = describeTag('v*');
  if (legacy?.startsWith('v')) return legacy;
  return 'dev';
}

export default ({ config }: ConfigContext) =>
  ({
    ...config,
    extra: { ...config.extra, appVersion: appVersion() },
  }) as ExpoConfig;
