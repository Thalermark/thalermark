import { defineConfig } from 'vitest/config';

// Mobile's first test setup (TMC-289). Deliberately plain: no React Native
// preset, no jsdom, no transform for native modules.
//
// Everything here runs PURE logic on a laptop: the state machines, the money
// maths and the rules about which error means what. That is the half where the
// bugs were: TMC-228 shipped two defects that a unit test would have caught in
// seconds (a network failure mapped to 'signed out', and the offline banner
// mounted below the early return that was supposed to show it), and both were
// found instead by building an APK and toggling radios on a physical Pixel.
//
// Anything that RENDERS stays off this suite for now, and the device stays the
// acceptance test for anything native. A Metro bundle is not native proof.
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
  },
});
