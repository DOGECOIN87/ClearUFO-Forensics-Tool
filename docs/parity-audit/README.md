# ClearUFO Native Android: parity audit and implementation plan

## Executive finding

The uploaded `ClearUFO-Forensics-Native-release.apk` is an intermediate native rewrite, not a full Android port of the original ClearUFO forensics software. The active native screen accepts PNG still images, computes source-file MD5/SHA-1/SHA-256, applies one Negative operation, writes a 16-bit RGB PNG, and compares decoded output samples after read-back. It has no filter catalog, project/case model, reports, video frame decoding, timeline, audio workflow, measurements, or AI/MCP surface.

The original browser application contains about 11,000 lines, 85 filters in 17 categories, multiple still/video/DVR decoders and writers, project/history/report workflows, viewer tools, capture, and optional AI/MCP integrations. The repository’s own `android-native/plan.md`, `README.md`, and `TODO.md` call the APK a first, still-image-only milestone and describe a staged native rewrite. “Full functionality” therefore requires a multi-stage port, cross-platform conformance tests, and real Android device validation; it cannot be achieved by changing a manifest flag or merely adding a player.

## Current work in this iteration

The Android source now has a separate local-video selection/review path, incremental MD5/SHA-1/SHA-256 hashing in bounded chunks, progress and cancellation, and a platform-decoder preview. The UI labels that video path as review-only. The video bytes are not loaded into one large JavaScript array or copied to the app cache by the picker. This is a foundation step, **not** verified video ingestion or full feature parity: no native decoded-frame buffer, PTS index, temporal filters, or video export has been added here.

## Audited feature gaps

| Area                              | Original behavior                                                                                                    | Current native status                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Evidence and codecs               | Magic-byte routing; broad image, sequence, AVI, common container, DVR, raw bitstream and YUV paths                   | PNG-only verified processing; local platform-decoded video review is a separate, non-verified path                 |
| Filters                           | 85 filters / 17 categories, parameter schemas, serial chains, preview and export                                     | One fixed Negative operation on PNG                                                                                |
| Video and temporal work           | Indexed timestamps, stepping, timeline, audio, temporal filters, stabilization, conversion and output                | No frame index, PTS-aware decode, temporal engine, audio analysis, or processed-video export                       |
| Projects and reports              | Case metadata, portable project schema/migrations, save/relink, history, bookmarks, provenance and printable reports | No project/case persistence, chain/history, bookmarks or report generation                                         |
| Viewer and measurement            | Pan/zoom, pixel inspector, histograms, clipping, frame analysis, selection, ruler, polygon, profiles and overlays    | Fixed image preview; no exact-addressable viewer tool surface                                                      |
| Capture and optional integrations | Camera/screen capture, AI providers, tool policies and MCP                                                           | Not implemented in the native workflow; online features remain outside the offline core unless separately approved |

Detailed source-by-source audit reports are in `01-ingestion-codecs.md`, `02-spatial-filters.md`, `03-video-temporal.md`, `04-cases-projects-reports.md`, `05-viewer-tools.md`, and `06-optional-capabilities.md`.

## Recommended port sequence

1. **Evidence contract and safe I/O:** preserve original bytes; define hash domains and decoder provenance; content-sniff inputs; use SAF/provider-backed streaming; add cancellation, size/decompression limits, storage-error handling, and fixtures.
2. **Still-image parity:** expand decoders and metadata with explicit exactness limits; port filter schemas and deterministic filters in tested groups; add chain state, controls, undo/history, and verified output writers.
3. **Video evidence foundation:** add source metadata and byte hashes, then a native demux/decode adapter with PTS/timebase/frame order, color metadata, documented decoder path, and conformance fixtures. Keep ordinary playback preview visually separate from numerical evidence.
4. **Video workbench:** add frame navigation/timeline, exact frame extraction, audio mapping, then temporal operations and streaming export with bounded memory, cancellation, and output read-back verification.
5. **Projects, cases, reports, and viewer tools:** persist the compatible project schema, relink evidence by identity, preserve provenance, then port exact-sample inspection, geometry tools, reports and accessible mobile navigation.
6. **Optional capabilities:** port camera/capture and AI/MCP only after the offline forensic core is stable; keep explicit consent, security boundaries and audit records.
7. **Release acceptance:** build through the approved Mobile Dashboard path; verify installation, picker, playback, decoder formats, exact sample tests, exports, airplane-mode behavior, memory/storage limits and known gaps on a real Android device matrix; record APK SHA-256 and tested OS/device versions.

## Release limitation

This sandbox has no Android SDK, Gradle, ADB, or emulator. The source can be type-checked and its pure TypeScript tests can be run here, but no rebuilt/installable APK or device-level verification can be honestly claimed from this environment. The checked-in project README says Android APK builds are done through the project Dashboard from an accepted checkpoint.
