# ClearUFO Forensics Native (Android)

This is the staged native Android rewrite of the ClearUFO forensics workbench. It is an Expo/React Native Android app with native screens and controls; it does not wrap the browser app in a WebView. The existing browser app remains unchanged in the parent repository and is the conformance reference.

## Offline boundary

The Android configuration blocks `android.permission.INTERNET` and `android.permission.ACCESS_NETWORK_STATE`. The app screen does not initialize the template's tRPC/API providers, has no API endpoint values in Expo extras, and keeps image processing on the device. The managed Mobile starter still contains server/database scaffolding, but this app does not call it or store evidence there. No cloud AI, upload, analytics, or account is part of the offline workflow.

## Current milestone

The first verified processing slice supports static PNG still images only: select a local PNG, hash its original bytes with MD5/SHA-1/SHA-256, decode its stored samples with the exact PNG decoder, apply the reference Negative formula, export a 16-bit RGB PNG, save it to a user-selected Android folder, read the file back, and compare every 16-bit sample. The original source file is not overwritten. A separate video-review foundation now selects local videos, hashes original bytes in 4 MiB chunks with progress/cancellation, and presents native platform-decoder playback controls. That playback is a review preview, not verified forensic decoding. Exact frame/PTS extraction, video filters, temporal analysis, custom DVR/bitstream paths, and video export are still unimplemented. Animated PNG, other still formats, cases/projects, reports, and most filters are also outstanding; this is not full product parity.

## Checks

From this directory:

```sh
pnpm install
pnpm check
pnpm exec vitest run
```

The native suite currently has 35 passing tests and one skipped test, covering CORS/auth behavior, the PNG processing pipeline, streaming-hash vectors, progress, cancellation, and file-size integrity. These are source-level checks; they do not replace a native Android device test.

## Android development/build

Open this project in the Manus Mobile Dashboard/Expo workflow to preview with Expo Go. Build the installable APK through the Dashboard's Android APK action from an accepted Manus project checkpoint; do not run EAS/Gradle release builds from the sandbox. No APK artifact has been produced yet. Install the resulting APK on an Android device/emulator and test both the PNG picker → hash → Negative → SAF export → saved-file verification flow and local-video selection, hash cancellation, and playback. Record the Android version/device, supported formats, known gaps, and artifact hash. Video playback must remain clearly distinguished from exact frame/PTS decoding and forensic processing.

## Managed template scaffold

The fixed Mobile starter includes an Express/tRPC server and Drizzle/database resources. They remain unused by the offline app; do not add evidence/case data there or create server-backed features without a separately approved scope change.
