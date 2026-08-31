import { describe, expect, it } from 'vitest';
import { isOlderVersion } from './version';

describe('isOlderVersion', () => {
  it('fires when the candidate is behind on the same beta train', () => {
    expect(isOlderVersion('v0.1.0-beta.25', 'v0.1.0-beta.26')).toBe(true);
  });

  it('stays quiet on equal versions', () => {
    expect(isOlderVersion('v0.1.0-beta.26', 'v0.1.0-beta.26')).toBe(false);
  });

  it('stays quiet when the candidate is newer', () => {
    expect(isOlderVersion('v0.1.0-beta.27', 'v0.1.0-beta.26')).toBe(false);
  });

  it('compares prerelease counters numerically, not lexically', () => {
    // Lexically '9' > '26'; numerically 9 < 26. The counter passed 9 long ago,
    // so a lexical compare would misfire on real tags.
    expect(isOlderVersion('v0.1.0-beta.9', 'v0.1.0-beta.26')).toBe(true);
    expect(isOlderVersion('v0.1.0-beta.26', 'v0.1.0-beta.9')).toBe(false);
  });

  it('orders trains alphabetically: beta before rc', () => {
    expect(isOlderVersion('v1.0.0-beta.40', 'v1.0.0-rc.1')).toBe(true);
    expect(isOlderVersion('v1.0.0-rc.1', 'v1.0.0-beta.40')).toBe(false);
  });

  it('ranks a release above any prerelease of the same number', () => {
    expect(isOlderVersion('v1.0.0-rc.2', 'v1.0.0')).toBe(true);
    expect(isOlderVersion('v1.0.0', 'v1.0.0-rc.2')).toBe(false);
  });

  it('compares the release triple numerically', () => {
    expect(isOlderVersion('v0.1.0', 'v0.2.0')).toBe(true);
    expect(isOlderVersion('v0.9.0', 'v0.10.0')).toBe(true);
    expect(isOlderVersion('v1.0.0', 'v0.9.9')).toBe(false);
  });

  it('treats an unparseable side as unknown and stays quiet, both directions', () => {
    // Dev long-describe, bare SHA, 'dev' — none of these are comparable, and
    // unknown must never render as "older".
    expect(isOlderVersion('v0.1.0-beta.25-3-gabc1234', 'v0.1.0-beta.26')).toBe(false);
    expect(isOlderVersion('v0.1.0-beta.25', 'v0.1.0-beta.26-3-gabc1234')).toBe(false);
    expect(isOlderVersion('dev', 'v0.1.0-beta.26')).toBe(false);
    expect(isOlderVersion('abc1234', 'v0.1.0-beta.26')).toBe(false);
  });

  it('stays quiet on an empty or absent side', () => {
    expect(isOlderVersion(null, 'v0.1.0-beta.26')).toBe(false);
    expect(isOlderVersion('v0.1.0-beta.25', '')).toBe(false);
    expect(isOlderVersion('', '')).toBe(false);
  });
});
