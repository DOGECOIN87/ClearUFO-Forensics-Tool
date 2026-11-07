# Parity audit 02 — Still-image filter engine and filter controls

**ID:** `spatial-filters`
**Name:** Still-image filter engine and filter controls
**Review boundary:** The named web files (`src/shared/filters.ts`, `src/engine/filters/basic.ts`, `src/engine/filters/luts.ts`, `src/engine/filters/presentation.ts`, `src/engine/engine.ts`, `src/panels/FiltersPanel.ts`, `src/panels/FilterSettingsPanel.ts`), native `android-native/lib/engine/` and `android-native/app/(tabs)/index.tsx`, plus directly used codecs, evidence I/O, writer, and tests. Read-only source inspection; no runtime tests were run.

## Scope and current implementation

- **Web scope:** `filters.ts` is both the product catalog and parameter schema: filter IDs, kinds, categories, defaults, legacy values, selectable options, ranges, conditional controls, overlay metadata, help and references. `engine.ts` builds lazy, cached filter chains from that catalog and the implementations in `basic.ts`, `presentation.ts`, and other registries. The two panels expose filter discovery and parameter editing; tone tables in `luts.ts` are shared with preview processing.
- **Native scope:** The inspected Android screen is a single-image evidence workflow backed by `lib/engine/imagePipeline.ts`; it does not load or implement the web filter catalog, engine chain, or settings panels. Its only selectable operation is the fixed Negative action.

## Original browser capabilities

The catalog and registered implementations provide concrete still-image operations, including:

- **Load and geometry:** Image Loader (catalog help lists PNG, JPEG, BMP, GIF, WebP, AVIF and TIFF); crop; resize with nearest/bilinear/bicubic/Lanczos-3; rotate; horizontal/vertical flip; perspective rectification; radial lens-distortion correction; and pixel-aspect-ratio correction.
- **Channels and tone:** six grayscale methods; YCbCr 601/709, HSV, HSL, Lab, CMY and XYZ conversion; channel routing, extraction (including YCbCr, HSV, Lab and CMYK components) and RGB enable/disable; Levels with per-channel controls and Auto Levels; editable Curves; brightness/contrast; exposure/gamma/offset; clipped auto-contrast; global equalization or CLAHE; manual/gray-world/white-patch/point-reference white balance; hue/saturation/lightness; Negative; and luminance or per-channel Threshold.
- **Analysis, verification, restoration:** Fourier spectrum and notch/low/high-pass filtering; bit-plane inspection; Sobel/Prewitt/Scharr/Laplacian edge outputs; Original comparison (side-by-side, blend, wipe or difference); JPEG Error Level Analysis; unsharp, Laplacian and high-pass sharpening; averaging, Gaussian, median, bilateral, non-local-means, Wiener and deblocking denoise; and motion/optical/Gaussian/nonlinear deblurring (Wiener, Richardson–Lucy or Tikhonov where configured).
- **Presentation / spatial controls:** draw text, shapes, arrows and timestamp; hide a selected region by pixelation, blur or fill; spotlight, magnify, add logo/grid; and 1D/2D calibrated measurement overlays. These include presentation transformations and should not be confused with evidence-preserving analysis.
- **Filter controls:** category browsing, quick search by name/category/description, keyboard selection/add, double activation, drag-to-chain and a touch Add button. Settings are schema-generated: enable/disable, reset, previous/next, input/output switching, Apply, tabs, numeric sliders/spin boxes, selects, booleans, colors, curve editor, and viewer-drawn point/line/rectangle overlays. Conditional parameters and help/reference text are catalog-driven.

The browser engine processes `Float32` frames, caches nodes by parameters and upstream identity, and renders an 8-bit display copy for the viewer. Its still-image writer separately maps processed RGB to 8-bit, 16-bit, or float RGB output; lossless export verification decodes the file and compares stored-sample hashes. Thus a rendered viewer preview is not itself an exported/verified artifact. The browser writer also emits RGB (not alpha) for these still formats.

## Native status and verification boundary

`index.tsx` lets the user pick one local PNG, shows its name/size and MD5/SHA-1/SHA-256 after processing, previews either the selected file or generated output, and offers **Apply Negative · Save 16-bit PNG**. There are no filter categories, editable parameters, chain, input/output comparison, viewer overlays, or choice of filter/output format.

`runNegativeExport` checks the PNG signature, hashes the original file bytes, then `decodePngExact` decodes PNG color types/depths and Adam7 data into float RGBA on a 0–255 scale. It rejects animated PNG. The decoder documents that gamma/ICC profiles are ignored. `applyNegative` computes `255 - RGB` and copies alpha in the working frame; `frameToRgb16` clamps RGB and uses `Math.round(v * 257)`. It encodes RGB 16-bit PNG and `verifyPngExport` decodes that PNG and compares every stored sample to the in-memory expected sample array and its MD5.

The UI writes a local preview PNG and displays it before/independent of successful destination save. Android SAF saving reads back the chosen file; the UI then calls `verifyPngExport` against expected samples. If the user cancels destination selection, the in-memory export may still be shown and reported as in-memory verified. **This read-back establishes that the produced file contains the expected samples; it does not independently establish that the Negative algorithm matches the web engine, that the source is authentic, or that a preview alone was saved and verified.** The `PIXELS VERIFIED` display refers to the operation's in-memory export check; saved-file verification is a separate later check.

## Specific gaps

1. No native equivalents of the web catalog/registry or any web filter except Negative; no configurable filter settings or chaining.
2. No native file support beyond still PNG. WebP/JPEG/TIFF/BMP/GIF/AVIF loaders, sequences/video, and the browser's multi-format writers are absent from this flow. APNG is explicitly rejected.
3. No port of channel/color/tone operations, spatial transforms, analysis/verification filters, sharpening, denoise, deblur, overlays or calibrated measurements. Accordingly no web-style overlay editing, curve editor, category/search workflow, or parameter reset/conditional-help UI.
4. The native output is always 16-bit RGB PNG. Source alpha is retained while Negative operates but discarded by RGB export (consistent with the browser's RGB still writers); there is no metadata-preserving export path. Current UI does not report this distinction.
5. Existing native verification is serialization/read-back verification against samples generated by the same native algorithm. There is no checked-in differential test demonstrating that native filter outputs match `basicFilters`/the browser writer on shared fixtures, nor a source-to-output provenance/authenticity claim.
6. No import/restore of browser project chains or persisted native processing history is visible in the inspected screen.

## Dependencies and risks

- **Forensic exactness:** Native source-file MD5/SHA hashes cover original bytes, while output sample MD5 covers RGB samples, not the complete PNG container. `verifyPngExport` checks expected-vs-read-back samples; it is not an independent oracle for the transform. Add browser-vs-native golden comparisons before describing other filters or their results as equivalent. Validate exact 16-bit Negative complement, alpha treatment, palette/grayscale expansion, transparency, interlace and ICC/gamma behavior. The exact decoder intentionally ignores ICC/gamma, so displayed values are stored-sample interpretation, not color-managed appearance. Keep algorithm/parameter version and source/output hashes together if reproducibility records are added.
- **Offline/security:** Current Android config declares `permissions: []` and blocks `INTERNET` and `ACCESS_NETWORK_STATE`; the inspected picker, filesystem and pipeline are local APIs. This supports a local/offline design, but verify the merged APK manifest and transitive runtime behavior before making a blanket security guarantee. `app.config.ts` also contains a remote logo URL in build configuration; that is not evidence of an app runtime evidence upload. SAF grants access to user-selected files/directories and should remain narrowly scoped.
- **Android feasibility:** Pure TypeScript typed-array processing is portable, but the pipeline holds source bytes, decoded RGBA float data, output frames/samples, encoded PNG and read-back data. Peak memory can grow to several full-image copies; an RGBA `Float32Array` alone is 16 bytes/pixel (about 768 MB at 48 MP). Current Negative conversion/encoding loops are synchronous; only byte hashing explicitly yields to UI. Add image-size limits, cancellation, chunking/worker execution, memory profiling and clear failure behavior before large-image filters, especially convolution and Fourier/deconvolution.
- **Evidence semantics:** Preserve the original file unchanged and distinguish an on-screen preview, an in-memory verified export, and a saved-file read-back verification in UI and records. A successful sample comparison does not establish chain of custody or algorithm validity on its own.

## Recommended port sequence

1. **Lock the numerical contract:** define a shared frame/sample convention (RGB range, alpha, color-profile policy, rounding/clamping, edge rules); add tiny web golden frames and compare native Negative byte-for-byte/sample-for-sample, including 16-bit endpoints and transparent pixels.
2. **Introduce a native filter registry and serializable settings:** port only the schema/defaults and one operation at a time; retain source hash, operation ID/version and parameters. Do not claim catalog parity before every exposed ID has an implementation.
3. **Port low-risk channel/tone operations:** grayscale, channel switch/extract, Negative, Threshold, Levels, Curves, brightness/contrast and exposure; compare each native output against `basicFilters`/`luts.ts` outputs before adding controls.
4. **Port spatial editing with coordinate tests:** crop/flip/resize first, then rotate/perspective/aspect/lens correction. Lock interpolation, pixel-center mapping, edge fill, dimension rounding and coordinate transforms; build touch overlay editing only after the image-space contract is stable.
5. **Port neighborhood filters and analysis incrementally:** averaging/Gaussian/median, then bilateral/Wiener and heavier filters; add Fourier and deblur last behind explicit limits/progress/cancellation. Profile representative Android devices and large images at each step.
6. **Recreate controls and artifact semantics:** category/search and schema-generated controls, input/output preview separation, export choices, and a clear status distinction among preview, in-memory verification and saved-file verification. Add presentation/measurement tools only as explicitly non-forensic overlays or transformations.

## Tests needed

Existing candidate coverage (inspected, **not run**):

- `android-native/tests/forensics/imagePipeline.test.ts`: `runNegativeExport`, `frameToRgb16`, `verifyPngExport`; helper `compressedRgbPng`; currently covers hash standard vectors, one 8-bit RGB Negative sample, RGB16 encode/decode and base64 byte round-trip. Extend to exact 16-bit Negative, multiple pixels, alpha/transparency, malformed/APNG rejection, and realistic save/read-back behavior.
- `tests/pngdecode.test.ts`: generated PNG fixtures cover all supported color types/depths, row filters, Adam7, transparency, corruption/truncation and PIL cross-checks. Reuse fixtures for any expanded native import path and explicitly test color-profile policy.
- `tests/kernels.test.ts`: existing `curveFunction`, median, FFT, deconvolution, resize/interpolation-adjacent and homography checks. These test web primitives, not native parity.
- Add a browser/native differential suite using deterministic RGBA `Float32Array` frames (solid primaries, ramps, impulse/checkerboard, transparent pixels, odd dimensions and border impulses). Invoke web `basicFilters` plus `toneLuts`/`curveFunction` and the corresponding native registry, compare floats with declared tolerances and compare encoded RGB16 samples exactly after the same conversion. Cover control defaults/conditional visibility against `FILTERS`, file preview versus saved read-back, and peak memory/cancellation at representative Android image sizes.

No build or runtime test was performed for this audit.
