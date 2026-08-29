import { execSync } from 'node:child_process';
import type { ConfigContext, ExpoConfig } from 'expo/config';

// Dynamic config: keep app.json as the static base (Expo passes it in as
// `config`) and fill in everything that depends on the build.
//
// android and ios build from this one source, so no diff can tell them apart and
// they share the mobile-v* tag line. What differs between the two stores is which
// build each has accepted, and that is a counter (ios.buildNumber /
// android.versionCode), not a version. Resolved the same WAY as web and the api,
// just from a different tag line; pre-split tags are the fallback.
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

// The full descriptive build, e.g. v0.1.0-beta.26-0-gb18b235. Shown on
// Settings → About, where knowing the exact commit is the point.
function appVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  const own = describeTag('mobile-v*');
  if (own?.startsWith('mobile-v')) return own.slice('mobile-'.length);
  const legacy = describeTag('v*');
  if (legacy?.startsWith('v')) return legacy;
  return 'dev';
}

// What the stores show, and they are strict about it: iOS
// CFBundleShortVersionString must be one to three dot-separated integers, so
// `0.1.0-beta.26` is rejected outright. The marketing version is therefore the
// release number with the prerelease train and commit suffix stripped. Which
// beta a build came from is not lost: extra.appVersion still carries it, and
// About is where anyone actually looks.
function marketingVersion(): string {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(appVersion());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : '0.0.0';
}

// Both stores reject a build whose counter has not increased, and they compare
// against whatever was last ACCEPTED, which may be from a line we are not on.
// So it has to rise on every commit, not per release: the commit count does that
// by construction, needs nothing maintained by hand, and never resets when the
// marketing version does. Android requires an integer, iOS a string.
function buildNumber(): number {
  if (process.env.BUILD_NUMBER) return Number(process.env.BUILD_NUMBER);
  try {
    return Number(
      execSync('git rev-list --count HEAD', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
  } catch {
    return 1;
  }
}

export default ({ config }: ConfigContext) => {
  const build = buildNumber();
  return {
    ...config,
    version: marketingVersion(),
    ios: { ...config.ios, buildNumber: String(build) },
    android: { ...config.android, versionCode: build },
    extra: { ...config.extra, appVersion: appVersion() },
  } as ExpoConfig;
};
