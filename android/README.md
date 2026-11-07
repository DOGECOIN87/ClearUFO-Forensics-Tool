# ClearUFO Forensics for Android (native)

A native Android port of the ClearUFO forensic image and video enhancement workbench. There is no browser
or WebView: the UI is Jetpack Compose, the processing engine is Kotlin running on every CPU core, video goes
through the phone's hardware decoders and encoders (MediaCodec), and files go through the Android system
file picker (Storage Access Framework). Everything runs on the device, and the app requests no network
permission.

The layouts target the **Samsung Galaxy Z Fold3 inner screen** (7.6", 2208 × 1768) unfolded, in portrait
and landscape, and in Flex mode (half folded).

## Build

Requirements: JDK 17 or newer and the Android SDK (platform 36, build-tools 36). Android Studio installs both.

```bash
cd android
./gradlew :app:assembleRelease
```

Output: `app/build/outputs/apk/release/app-release-unsigned.apk` (≈3.5 MB, minified with R8). Prebuilt copies are in
`dist/`. Install `ClearUFO-Forensics-1.0.4.apk` (signed, installable); `ClearUFO-Forensics-1.0.4-unsigned.apk` is
the same build without a signature, and Android refuses to install it ("invalid package") until it is signed.

Every push that changes `android/` also builds the APK on GitHub Actions (workflow **Android APK**). The
APK and the Fold3 screenshots are attached to each run as artifacts.

### Installing the unsigned APK

Android refuses to install an APK that has no signature. Sign it once with your own key:

```bash
keytool -genkeypair -v -keystore clearufo.jks -alias clearufo -keyalg RSA -keysize 4096 -validity 36500
```

```bash
$ANDROID_HOME/build-tools/36.0.0/zipalign -p -f 4 app-release-unsigned.apk clearufo-aligned.apk
```

```bash
$ANDROID_HOME/build-tools/36.0.0/apksigner sign --ks clearufo.jks --out ClearUFO-Forensics.apk clearufo-aligned.apk
```

```bash
adb install -r ClearUFO-Forensics.apk
```

For quick testing, `./gradlew :app:assembleDebug` builds `app-debug.apk`, which is signed with the debug key
and installs directly. It is installed beside the release app (`com.clearufo.forensics.debug`).

## What runs on the phone

| Area | Implementation |
|---|---|
| Filters | All 85 filters in 17 categories of the browser workbench, with the same parameters, defaults and ranges. |
| Pipeline | RGBA float32 frames on a 0–255 scale, never clamped between filters. Lazy streams with hash-keyed nodes: changing a parameter recomputes only what is downstream of it. Byte-budgeted LRU frame cache. Kernels split by rows over a ForkJoin pool (8 cores on the Snapdragon 888). |
| Video | MediaExtractor indexes every sample (timestamp, sync flag, size). MediaCodec decodes frames exactly by presentation timestamp, handling B-frame reordering. ClearUFO converts YUV to RGB itself: BT.601/709/2020, limited/full range, chroma siting, nearest/bilinear/bicubic chroma, 10-bit, HDR (PQ/HLG) tone mapping to SDR (BT.2390). I/P/B frame types come from the H.264/HEVC slice headers. |
| CCTV / DVR | Own AVI parser (uncompressed RGB, Motion JPEG, H.264/HEVC, OpenDML) and raw H.264/HEVC elementary streams (`.h264`, `.264`, `.h265`, `.265`, `.hevc`), decoded through MediaCodec. |
| Images | Own exact PNG decoder (all color types, 1–16 bit, palettes, tRNS, Adam7) and TIFF decoder (strips/tiles; none, LZW, Deflate, PackBits; 8/16-bit, 32-bit float). JPEG, WebP, BMP, GIF, HEIF and AVIF use the platform decoder without color conversion. EXIF is shown in File Info. |
| Exports | TIFF 8/16-bit and 32-bit float, PNG 8/16-bit, BMP, uncompressed AVI, and image sequences as one stored ZIP. Lossless exports are **read back and verified** sample by sample (AVI frame by frame). Lossy: JPEG, WebP, Motion-JPEG AVI, and MP4 (H.264/HEVC) or WebM (VP9/VP8) through the hardware encoders. |
| Integrity | MD5, SHA-1 and SHA-256 of every evidence file, streamed from the original bytes; evidence opened read-only. |
| Reports | PDF report (`android.graphics.pdf`) with case information, evidence hashes, decoder and YUV-conversion provenance, every processing step with its parameters and literature reference, an annotated snapshot with its frame MD5, bookmarks and the device. |
| Projects | `.lfp` projects are interchangeable with the browser workbench (schema 3, including legacy-parameter pinning). The session is autosaved and restored if Android stops the app. |
| Viewer | Pinch to zoom, pan, double-tap for fit or 100 %, pixel inspector (float, 8-bit and luma values), Show Input, and drawing regions, lines and points directly on the image (grab a handle to move it). |
| Tools | RGB and luma histogram, frame analysis (GOP structure with frame sizes and types), File Info, frame MD5, bookmarks, in/out points, playback speeds 0.05×–16×. |
| Android | "Open with" and "Share" from Gallery or Files, recording a video or taking a photo with the camera, the system file picker for every file, keep-screen-on during playback and exports. |

## Galaxy Z Fold3 layouts

The layout follows the window size and the hinge reported by Jetpack WindowManager:

- **Unfolded, portrait** (≈5:4): large viewer and player on top; History/Filters and Settings/Tools side by side underneath.
- **Unfolded, landscape**: viewer and player on the left; Settings/Tools above History/Filters on the right.
- **Flex mode, tabletop** (half folded, hinge horizontal): the image above the hinge, all controls below it, split exactly at the hinge.
- **Flex mode, book** (half folded, hinge vertical): the image on the left page, the panels on the right page.
- Folded (cover screen) or other phones: a compact single-column fallback.

Folding, unfolding, rotating and multi-window resizing don't restart the activity, so the open evidence,
the caches and running exports are kept.

## Tests

```bash
./gradlew :app:testDebugUnitTest
```

- **ConformanceTest** runs the Kotlin kernels on deterministic inputs and compares them with the outputs of
  the browser workbench's own TypeScript kernels (`conformance/generate.ts` writes the vectors). 38 of 39
  vectors are bit-identical: blurs, median, bilateral, non-local means, Wiener, deblocking, every resampling
  kernel, perspective, CLAHE, levels, curves, exposure, Wiener/Tikhonov/Richardson–Lucy deconvolution,
  Fourier filters, spectra, phase correlation, the ELA JPEG model, temporal smoothing with motion
  protection, and YUV→RGB. Rotation differs by at most 6×10⁻⁵ of a level, from last-bit differences in
  `cos`/`sin`. To regenerate the vectors, run `npm ci`, then `node android/conformance/run.mjs` from the
  repository root.
- **CatalogConformanceTest** checks every filter id, category, parameter key, type, default, range, option
  list and legacy value against the browser catalog.
- **EngineTest / CodecTest** cover chain evaluation, caching and invalidation, temporal and link filters,
  error attribution, PNG/TIFF/BMP round trips and `.lfp` read/write, including legacy pinning.
- **FoldLayoutScreenshots** (opt-in: add `-Pscreenshots`) renders the app off-device with Robolectric at the Fold3
  inner-screen sizes and postures, and writes PNGs to `app/build/screenshots/`.

## Not ported

- The AI assistant and MCP integration. They depend on network services and the app is deliberately offline.
- Dahua `.dav` and other proprietary DVR containers: convert them to MP4 or AVI first. Raw H.264/HEVC streams
  and AVI are supported.
- Animated GIF/WebP/APNG open as their first frame.
- Screen capture as a video input. Camera recording uses the system camera app.
