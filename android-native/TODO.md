# TODO — ClearUFO Native Android Migration

## Offline native Android app
- [ ] Deliver an installable Android app based on ClearUFO Paranormal Video Forensics that uses the device's processing capabilities instead of a browser or remote processor.
- [ ] Implement the fully native Android rewrite the user chose, even if it takes longer: use native Android screens and controls; do not wrap the existing web app in a WebView or launch a browser.
- [ ] Keep core forensic processing, evidence, cases, and reports on-device so they work without network access. Do not upload evidence, cases, or analytics.
- [ ] Leave the project-level server and empty managed database unused; do not add server-backed app features, migrations, or evidence writes there.
- [ ] Keep optional cloud AI/MCP or remote-provider integrations outside the offline core and disabled unless separately designed and explicitly enabled.
- [ ] Keep the existing browser application unchanged and use it and its fixtures as the conformance reference.

## First verified still-image APK milestone
- [ ] Implement Android Storage Access Framework file selection and streaming/local file handling.
- [ ] Treat source evidence as immutable; hash original bytes as read with MD5, SHA-1, and SHA-256.
- [ ] Decode PNG evidence exactly into the existing canonical RGBA float convention, preserving numeric precision and alpha behavior.
- [ ] Apply the deterministic Negative filter and export a 16-bit lossless PNG or TIFF.
- [ ] Read back the export and verify its pixels/hash; show source hashes, parameters, and verification/provenance state in the native app.
- [ ] Label this first APK milestone as an intermediate still-image workflow, not full product parity.

Progress (2026-11-05): the React Native source implements PNG file selection, on-device source hashing, exact PNG decoding, Negative processing, 16-bit RGB PNG output, and pixel-level read-back verification logic. Six focused automated tests and strict TypeScript pass. All criteria above remain open until an APK is built and SAF/file behavior is verified on Android; streaming and large-file resource handling are not complete.

## Still-image workbench and project compatibility
- [ ] Port project JSON compatibility, chain/history/undo behavior, local case storage and relinking, viewer tools, metadata, and report generation.
- [ ] Expand still-image filters and lossless input/output formats in tested groups while preserving older `.lfp` project semantics.
- [ ] Complete remaining filter families, native measurement/annotation tools, case workflows, and requested format support toward the existing application's 85-filter/17-category scope.

## Verified video and temporal processing
- [ ] Add streaming Android file access, pinned software demux/decode, presentation timestamps/frame order, format/color metadata, and the custom AVI/DVR/bitstream paths.
- [ ] Preserve YUV range/matrix/chroma/HDR conversion contracts. Label unsupported or non-reference decode paths instead of silently substituting them.
- [ ] Add native playback/timeline/audio, frame selection, interlace handling, temporal filters, stabilization, linked chains, bounded caching/backpressure, cancellation, and streaming export.
- [ ] Bound memory, handle revoked file permissions and low-storage conditions, and never silently re-encode evidence.
- [ ] Keep GPU work display-preview-only unless exactness is independently established; record source identity, decoder/build, pixel format, color conversion, parameters, and output hashes.

## Conformance and release APK
- [ ] Use the browser implementation and fixtures as the behavioral oracle; preserve Float32 storage points, Double intermediates, round-to-even/clamping, chroma siting, edge/reflection rules, color matrix/range, HDR behavior, and project schema defaults.
- [ ] Add golden conformance vectors per filter/format and distinguish exact verified output from display-only or device-dependent paths.
- [ ] Build the release APK through the Dashboard from an accepted native project checkpoint and verify offline launch/core workflows on an Android device/emulator.
- [ ] Confirm the APK has no `INTERNET` or `ACCESS_NETWORK_STATE` permission; document tested Android versions, supported formats, known gaps, and artifact hash. Do not represent an intermediate APK as full parity.
