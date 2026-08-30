# Thalermark mobile

React Native + Expo. This file is how to **run, test and build** it. For what the
app contains and how it is laid out, read `CLAUDE.md` next to this file.

Everything below assumes you have already done the repo-wide setup in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## The fast loop

```bash
pnpm --filter @thalermark/mobile dev     # metro; open in Expo Go
```

Expo Go is the day-to-day loop. It is not proof of anything native: a Metro
bundle loading says nothing about whether a native dependency works in a real
build. Anything touching a native module has to be checked on a device.

Point the app at an API with `EXPO_PUBLIC_API_URL`, either in
`apps/mobile/.env.local` or as a shell variable. **A shell variable wins**, since
dotenv does not overwrite what is already in the environment. The value is
inlined into the bundle at build time, so a build carries whichever server it was
built against.

## Tests

```bash
pnpm --filter @thalermark/mobile test
```

Pure logic only: state machines, money maths, and the rules about which error
means what. No renderer, no jsdom, no native modules. Anything that renders is
still verified on a device.

## Typecheck locally before you build

```bash
pnpm --filter @thalermark/mobile typecheck
```

**CI typechecks mobile more loosely than your machine does**, because Expo
Router's generated route types are gitignored and therefore absent in CI. A green
CI run is not proof that mobile compiles. Run it locally.

## Building a native Android APK

```bash
cd apps/mobile
JAVA_HOME=/opt/homebrew/opt/openjdk@17 PATH="/opt/homebrew/opt/openjdk@17/bin:$PATH" \
  ANDROID_HOME="$HOME/Library/Android/sdk" ANDROID_SDK_ROOT="$HOME/Library/Android/sdk" \
  ANDROID_SERIAL=<serial> EXPO_PUBLIC_API_URL=<api base> \
  npx expo run:android --device <model> --variant release
```

Four things bite, in this order. None of them are in the app.

**1. `--device` wants the model, not the serial.** Passing a serial fails with
"Could not find device with name". Read the model from `adb devices -l`, e.g.
`Pixel_8_Pro`. When an emulator is also attached, pin the real device with
`ANDROID_SERIAL` or the install can land on the emulator instead.

**2. There is usually no JDK on `PATH`.** `/usr/libexec/java_home` finds nothing.

**3. It must be JDK 17 specifically, and by full path.** Android Studio's bundled
JBR is 21 and fails in Gradle's settings phase with:

> `Class org.gradle.jvm.toolchain.JvmVendorSpec does not have member field 'IBM_SEMERU'`

**This message looks nothing like a JDK problem, which is exactly why it costs an
hour.** It comes from the foojay-resolver pinned at 0.5.0 by
`@react-native/gradle-plugin`, reading a field Gradle 9 removed. It is not a stale
daemon, and `org.gradle.java.installations.auto-download=false` does not avoid it:
the class initialises when the plugin is applied, before any toolchain is chosen.
Install a JDK 17 and foojay is never invoked at all.

Homebrew's `openjdk@17` is keg-only, and **the symlink root is not a valid JDK
home**. Gradle wants
`/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home` when you set it
via `org.gradle.java.installations.paths`. Putting that in
`~/.gradle/gradle.properties` makes it survive the next `expo prebuild`.

**4. `ANDROID_HOME` is usually unset too**, and Gradle then fails with "SDK
location not found".

`assembleRelease` is signed with the **debug** keystore by default, which is why
it sideloads with no keystore setup. That is fine for testing and is not
publishable.

## Building for a physical iPhone or iPad

A **free** personal Apple ID is enough: the app's entitlements are empty, so
nothing here needs the paid program. Profiles last 7 days; rebuilding re-mints
them silently.

**`expo run:ios --device` cannot build this.** It does not pass
`-allowProvisioningUpdates` to xcodebuild, so signing dies at "Planning build"
with "No profiles for 'com.thalermark.app' were found". Call xcodebuild directly:

```bash
cd apps/mobile
xcodebuild -workspace ios/Thalermark.xcworkspace -scheme Thalermark \
  -configuration Release -destination 'id=<device-udid>' \
  -derivedDataPath ios/build-release -allowProvisioningUpdates build
xcrun devicectl device install app --device <device-udid> \
  ios/build-release/Build/Products/Release-iphoneos/Thalermark.app
```

Get the UDID from `xcrun xctrace list devices`.

**Traps:**

- **`connected (no DDI)` means Developer Mode is off** on the device. The Settings
  entry stays hidden until a Mac first attempts a development connection, so "it
  isn't there" is expected before you plug in, and there is a second confirmation
  after the reboot that is easy to miss.
- **A debug build's first launch fails with "No script URL provided", and it is a
  timing problem, not config.** iOS gates LAN connections behind Local Network
  permission, and React Native checks the packager synchronously before the grant
  lands. Just reload the app after granting.
- **`/index.bundle` 404s and that is correct.** Expo's AppDelegate requests
  `.expo/.virtual-metro-entry`. Do not diagnose off that 404.
- **Xcode's "Update to recommended settings" nag is noise. Do not accept it.**
  `ios/` is gitignored and regenerated, so the edit is destroyed by the next
  prebuild, and accepting risks flipping settings React Native pins.
- `DEVELOPMENT_TEAM` lives in `project.pbxproj`, which is also gitignored and
  regenerated. Any `expo prebuild --clean` wipes it and you must set the team in
  Xcode again.

## Versions

`app.json` is a static base; `app.config.ts` derives the parts that depend on the
build and always wins. The marketing version comes from the `mobile-v*` git tag
with the prerelease stripped, because iOS rejects anything that is not one to
three dot-separated integers. `ios.buildNumber` and `android.versionCode` are the
commit count, so they rise on every commit, because both stores reject a build whose
counter has not increased. Nothing here is edited by hand.
