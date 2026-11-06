# ClearUFO Native Android Migration Plan

## Goal and constraints

Create an installable Android app based on the user's ClearUFO Paranormal Video Forensics workbench. The user explicitly chose a fully native Android rewrite, even if it takes longer: use native Android screens and controls, do not wrap the browser app in a WebView or launch a browser, and perform forensic computation on the device instead of remotely. Core work must function offline. Preserve the existing workbench's forensic processing semantics, provenance, project compatibility, and export integrity. This is a staged migration—not APK wrapping. The original browser app at `DOGECOIN87/ClearUFO-Forensics-Tool` remains unchanged and serves as the reference implementation.

The source has roughly 11,000 lines, 85 filters in 17 categories, custom media parsers, a 32-bit floating-point frame pipeline, projects/cases, and binary writers. Full parity is a multi-stage effort. The first APK milestone is a real end-to-end still-image evidence workflow and must not be described as full feature parity.

## Implementation approach

Use the initialized Expo/React Native Android starter. All user-facing product screens are native React Native components; there is no WebView/browser surface. Port deterministic, browser-independent TypeScript algorithms into the React Native/Hermes runtime where their numeric contracts can be preserved. Add a scoped Android Kotlin/NDK module for Storage Access Framework streaming, exact decoder/encoder paths, and performance-critical kernels as conformance work justifies. Avoid substituting Android device-dependent decoders for verified software decoding without recording and validating the difference. GPU work, if added, remains display-preview-only unless exactness is demonstrated.

Core processing, evidence, projects, and reports stay on the device and do not depend on network access. The application does not call its project backend/database, upload evidence/cases, or include optional cloud AI/MCP in the offline core. The managed Mobile template automatically enables a server and empty managed database; those project-level resources remain unused, with no migrations or app-data writes. The current Android configuration blocks `android.permission.INTERNET` and `android.permission.ACCESS_NETWORK_STATE`; confirm the generated APK manifest and offline operation after the Dashboard build.

Preserve the original web app and its reference tests. Use Android 10 / API 29 as the default minimum unless device support requirements change it. The managed Mobile template fixes Expo/React Native, app identity, ports, and project repository policy; the Android release APK is built through the project Dashboard from an accepted checkpoint. Do not claim an APK artifact until that native build succeeds. Keep the existing generated Android package/application identifier unchanged (`space.manus.clearufonat.t087974638181694`).

## Project structure

- `app/`: Expo Router native screens and navigation for evidence, cases, workbench, playback, and reports.
- `components/`: native viewer, tool overlays, filter controls, provenance/verification panels, and accessible touch controls.
- `hooks/`: native lifecycle, file-permission, job-progress, cancellation, and theme state.
- `lib/engine/`: portable deterministic frame graph, cache, progress/cancellation, filter schemas, and adapted TypeScript algorithms.
- `lib/codecs/`: byte sniffing, exact PNG/image decode, hashing, and lossless writers.
- `lib/project/`: `.lfp` schema compatibility/migrations, chain/history/undo, and local case persistence.
- `lib/reports/`: case reports, processing history, evidence hashes, and decode/algorithm provenance.
- `modules/forensics-native/android/`: Android Kotlin/NDK integration for SAF streaming, verified software media decoding/encoding, audio, and native kernels as justified by conformance/performance results.
- `tests/`: golden vectors and conformance tests derived from the existing unit and end-to-end suites.
- `assets/images/`: ClearUFO launcher, splash, and platform icon assets adapted from the supplied repository identity.
- Existing `server/` and `drizzle/` folders are fixed starter scaffolding; do not add app features, migrate schemas, or write user evidence there.

## Migration stages

1. **Conformance foundation and still-image vertical slice.** Establish test vectors from existing image/hash/writer tests. Implement Android file selection through SAF; immutable source-byte MD5/SHA-1/SHA-256; exact PNG decode into the current RGBA-float convention; the Negative filter; 16-bit PNG or TIFF export; read-back verification; and a minimal native evidence/provenance screen. Demonstrate this complete local workflow in the first APK milestone. The current source implements PNG selection, hashing, exact decoding, Negative, 16-bit RGB PNG output and sample-level read-back logic; six automated tests pass. Actual Android SAF/device behavior and the Dashboard APK build are still unverified.
2. **Still-image workbench and projects.** Port project JSON compatibility, chain/history/undo, local case storage/relinking, viewer tools, metadata and report generation. Expand image filters and lossless formats in tested groups. Preserve older `.lfp` project semantics.
3. **Verified video ingestion.** Add streaming Android file access, pinned software demux/decode, presentation timestamps and frame order, format/color metadata, and the custom AVI/DVR/bitstream paths. Preserve YUV range/matrix/chroma/HDR conversion contracts. Label unsupported or non-reference paths instead of silently substituting them.
4. **Video workbench and temporal processing.** Add native playback/timeline/audio, frame selection, interlace handling, temporal filters, stabilization, linked chains, bounded caching/backpressure, cancellation, and streaming export. Validate memory use on representative Android devices.
5. **Full product parity.** Complete remaining filter families, measurement/annotation tools, report/case workflows, project compatibility, and requested format support. Reconsider camera/capture or AI/MCP only after the offline core is stable and they are separately scoped.
6. **Release APK.** From an accepted checkpoint, use the Dashboard's Android APK build action. Verify offline launch/core workflow on a device or emulator; confirm the APK lacks Internet/network-state permissions; record tested Android versions, supported formats, known gaps, and artifact hash. An intermediate APK is not full parity.

## Forensic correctness principles

- Keep original evidence immutable; hash original bytes as read. Record source identity, decoder/build, pixel format, color conversion, parameters, and output hashes.
- Use the current browser implementation and fixtures as the behavioral oracle. Preserve Float32 storage points, Double intermediates, round-to-even/clamping, chroma siting, alpha, edge/reflection rules, color matrix/range, HDR behavior, and project schema defaults.
- Add golden conformance vectors per filter/format and distinguish verified output from display-only or device-dependent paths.
- Stream large input/output, bound caches, handle revoked URI access and low storage, cancel safely, and never silently re-encode source evidence.

## Design system

**Design movement:** ClearUFO's existing forensic workbench aesthetic—an instrumented investigation console, adapted for portrait Android rather than copied as a desktop panel grid.

**Core principles:** evidence before enhancement; precision over decoration; every result traceable; touch-sized controls without concealing provenance.

**Color philosophy:** carry over the existing Midnight theme's black/graphite surfaces (#000000, #121212, #161616), near-white text and selection accents (#f2f2f2), and restrained semantic status colors (green success, amber warning, red error). Color is for hierarchy and status, not spectacle.

**Layout paradigm:** make the evidence viewer the main screen, with a one-handed sequence through Evidence, Filters, Settings, History, and Report; use expandable panels/sheets rather than compressing every desktop panel into a phone grid.

**Signature elements:** persistent source-hash/provenance chip; a clear white focus/selection edge; restrained measurement guides and numeric readouts.

**Interaction philosophy:** never overwrite source evidence; separate preview from export; make processing steps undoable and auditable; report real job progress and cancellation rather than simulated activity.

**Animation:** brief (about 120–180 ms) panel and navigation transitions; no decorative movement over evidence; processing progress changes only from actual worker/native-job events.

**Typography:** Android system sans-serif for navigation/body text; a monospaced face with tabular numerals for hashes, coordinates, timestamps, and pixel measurements.

**Brand essence:** “ClearUFO puts transparent, reproducible image and video examination in the investigator's hands.” Personality: precise, restrained, transparent.

**Brand voice:** concise and observational. Examples: “Source unchanged. Hash computed from original bytes.” “Preview only — the evidence file has not been altered.”

**Wordmark/logo:** reuse the ClearUFO monochrome mark from the supplied repository and adapt it to native launcher/splash assets; do not invent a replacement brand.

**Signature brand color:** monochrome white (#f2f2f2) on graphite, consistent with the existing badge; reserve semantic colors for warnings and verification status.
