# @lilypad/mobile

Bare React Native app (0.76). Contains the full JS/TS scaffold — navigation,
QR scanner (react-native-vision-camera), pairing redeem, and the session viewer
placeholder. The native `ios/` and `android/` projects are **generated**, not
committed (they're large and machine-specific).

## Prerequisites

- Node ≥ 20, pnpm ≥ 9 (repo root)
- **iOS:** Xcode + CocoaPods (`sudo gem install cocoapods` or `brew install cocoapods`)
- **Android:** Android Studio, JDK 17, an emulator or device

## 1. Generate the native projects

This package ships JS/TS only. Create the native folders once, then keep them
git-ignored per the repo `.gitignore`:

```bash
# from repo root
cd /tmp
npx @react-native-community/cli@latest init LilypadMobile --version 0.76.5 --skip-install
# copy the generated native folders into this app
cp -R LilypadMobile/ios   /Users/kushsharma/Desktop/lillypad/apps/mobile/ios
cp -R LilypadMobile/android /Users/kushsharma/Desktop/lillypad/apps/mobile/android
```

Make sure the native app name matches `app.json` (`LilypadMobile`).

## 2. Install + build

```bash
# from repo root — installs the whole workspace
pnpm install
# build the shared protocol package so Metro can resolve @lilypad/protocol
pnpm --filter @lilypad/protocol build

cd apps/mobile
pnpm pods            # iOS only
pnpm ios             # or: pnpm android
```

## 3. Native permissions (one-time)

- **iOS** `ios/LilypadMobile/Info.plist`:
  ```xml
  <key>NSCameraUsageDescription</key>
  <string>Lilypad scans the pairing QR shown on your laptop.</string>
  ```
- **Android** `android/app/src/main/AndroidManifest.xml`:
  ```xml
  <uses-permission android:name="android.permission.CAMERA" />
  ```
- react-native-vision-camera + react-native-webrtc autolink; run `pod install`
  after adding them. See their docs for the minimum iOS/Android SDK bumps.

## Notes

- **Connecting from a real phone:** the QR embeds `apiBaseUrl` from the backend
  `.env` `PUBLIC_BASE_URL`. On a phone that must be reachable from the device —
  your machine's LAN IP for same-Wi-Fi dev, or a public URL for true
  internet-first testing. `localhost` only works in a simulator on the same Mac.
- Auth (Login/Devices screens) is stubbed for M1; real accounts land in M5.
- The live WebRTC viewer + input replace the Viewer placeholder in M2–M4.
