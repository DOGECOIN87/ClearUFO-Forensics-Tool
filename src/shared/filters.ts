// Filter catalog: metadata + parameter schemas shared by the UI and the engine.
// The engine implementations live in src/engine/filters and are keyed by the same ids.

import { FORMATS, isLossy, type WriteFormat } from "./formats";
import type { ParamValues, Pt, RectP } from "./types";

export type Category =
  | "Load" | "Link" | "Write" | "Select Frames" | "Deinterlacing" | "Edit" | "Channels" | "Adjust"
  | "Extract" | "Verify" | "Measure" | "Sharpen" | "Denoise" | "Deblurring" | "Stabilization"
  | "Integrate" | "Presentation";

export const CATEGORIES: { name: Category; description: string }[] = [
  { name: "Load", description: "Loads image and video files." },
  { name: "Link", description: "Combines the outputs of different chains." },
  { name: "Write", description: "Writes the processed images and videos to file." },
  { name: "Select Frames", description: "Selects a subset of the frames of the video." },
  { name: "Deinterlacing", description: "Processes the interlaced videos." },
  { name: "Edit", description: "Geometric transformations and corrections." },
  { name: "Channels", description: "Color conversion and extraction functions." },
  { name: "Adjust", description: "Brightness, contrast, levels and color adjustments." },
  { name: "Extract", description: "Extracts information not visible in the original data." },
  { name: "Verify", description: "Compares and verifies processing results." },
  { name: "Measure", description: "Measures distances on images." },
  { name: "Sharpen", description: "Enhances the details of the image." },
  { name: "Denoise", description: "Reduces the noise of the image." },
  { name: "Deblurring", description: "Corrects motion and optical blur." },
  { name: "Stabilization", description: "Stabilizes the video on a region or globally." },
  { name: "Integrate", description: "Combines information of several frames." },
  { name: "Presentation", description: "Annotations and presentation tools." },
];

interface BaseParam {
  key: string;
  label: string;
  tab?: string;
  /** Draw/edit this parameter on the Viewer only when the predicate is true. */
  overlayIf?: (p: ParamValues) => boolean;
  /** Show this control only when the predicate is true. */
  show?: (p: ParamValues) => boolean;
  help?: string;
  /**
   * Value assumed when a saved filter lacks this parameter because it was saved before the parameter existed,
   * when that differs from the default of new filters (so reopened projects reproduce their results exactly).
   */
  legacy?: unknown;
}
export interface NumberParam extends BaseParam {
  type: "number" | "int";
  min: number;
  max: number;
  default: number;
  step?: number;
  decimals?: number;
  slider?: boolean;
  log?: boolean;
  unit?: string;
}
export interface SelectParam extends BaseParam { type: "select"; options: [string, string][]; default: string }
export interface BoolParam extends BaseParam { type: "bool"; default: boolean }
export interface ColorParam extends BaseParam { type: "color"; default: string }
export interface TextParam extends BaseParam { type: "text"; default: string; multiline?: boolean; placeholder?: string }
export interface RectParam extends BaseParam { type: "rect"; default: RectP | null }
export interface PointParam extends BaseParam { type: "point"; default: Pt | null }
export interface PointsParam extends BaseParam { type: "points"; default: Pt[]; minPoints?: number; maxPoints?: number; closed?: boolean; polyline?: boolean }
export interface LineParam extends BaseParam { type: "line"; default: [Pt, Pt] | null }
export interface ChainParam extends BaseParam { type: "chain"; default: string }
export interface ChainsParam extends BaseParam { type: "chains"; default: string[] }
export interface FrameParam extends BaseParam { type: "frame"; default: number; allowLast?: boolean }
export interface CurveParam extends BaseParam { type: "curve"; default: Pt[] }
export interface SourceParam extends BaseParam { type: "source"; default: string }
export interface ImageParam extends BaseParam { type: "image"; default: string }
export interface ActionParam extends BaseParam { type: "action"; action: string; default?: undefined }
export interface PsfParam extends BaseParam { type: "psf"; default?: undefined }
export interface InfoParam extends BaseParam { type: "info"; default?: undefined }
export interface FileInfoParam extends BaseParam { type: "fileinfo"; default?: undefined }

export type ParamDef =
  | NumberParam | SelectParam | BoolParam | ColorParam | TextParam | RectParam | PointParam | PointsParam
  | LineParam | ChainParam | ChainsParam | FrameParam | CurveParam | SourceParam | ImageParam | ActionParam
  | PsfParam | InfoParam | FileInfoParam;

export type FilterKind = "loader" | "filter" | "link" | "writer";

export interface FilterDef {
  id: string;
  name: string;
  category: Category;
  kind: FilterKind;
  description: string;
  hint?: string;
  params: ParamDef[];
  /** Where interactive overlays are drawn: on the filter input (geometry-changing filters) or on either view. */
  overlayOn?: "input" | "any";
  /** Needs several frames per output frame. */
  temporal?: boolean;
  /** Computationally expensive. */
  slow?: boolean;
  reference?: string;
  /** Tab names in display order (default: ["Settings"]). */
  tabs?: string[];
}

// ---------------------------------------------------------------- helpers
const num = (key: string, label: string, min: number, max: number, def: number, o: Partial<NumberParam> = {}): NumberParam =>
  ({ type: "number", key, label, min, max, default: def, decimals: 2, slider: true, ...o });
const int = (key: string, label: string, min: number, max: number, def: number, o: Partial<NumberParam> = {}): NumberParam =>
  ({ type: "int", key, label, min, max, default: def, decimals: 0, step: 1, slider: true, ...o });
const VIDEO_WRITER_FORMATS: WriteFormat[] = ["avi-raw", "tiff16", "tiff32f", "png16", "tiff", "png", "avi-mjpeg", "mp4", "webm"];
/** Image formats written by the Video Writer are numbered sequences in one ZIP archive. */
const videoWriterLabel = (f: WriteFormat) => (FORMATS[f].video ? FORMATS[f].short : FORMATS[f].short.replace(" (uncompressed)", " sequence (uncompressed)"));
const IMAGE_WRITER_FORMATS: WriteFormat[] = ["tiff16", "tiff", "tiff32f", "png16", "png", "bmp", "jpeg", "webp"];
const sel = (key: string, label: string, options: [string, string][], def: string, o: Partial<SelectParam> = {}): SelectParam =>
  ({ type: "select", key, label, options, default: def, ...o });
const bool = (key: string, label: string, def: boolean, o: Partial<BoolParam> = {}): BoolParam => ({ type: "bool", key, label, default: def, ...o });
const color = (key: string, label: string, def: string, o: Partial<ColorParam> = {}): ColorParam => ({ type: "color", key, label, default: def, ...o });
const text = (key: string, label: string, def: string, o: Partial<TextParam> = {}): TextParam => ({ type: "text", key, label, default: def, ...o });
const rect = (key: string, label: string, o: Partial<RectParam> = {}): RectParam => ({ type: "rect", key, label, default: null, ...o });
const point = (key: string, label: string, def: Pt | null, o: Partial<PointParam> = {}): PointParam => ({ type: "point", key, label, default: def, ...o });
const points = (key: string, label: string, o: Partial<PointsParam> = {}): PointsParam => ({ type: "points", key, label, default: [], ...o });
const line = (key: string, label: string, o: Partial<LineParam> = {}): LineParam => ({ type: "line", key, label, default: null, ...o });
const frame = (key: string, label: string, def = 0, o: Partial<FrameParam> = {}): FrameParam => ({ type: "frame", key, label, default: def, ...o });
const chain = (key: string, label: string): ChainParam => ({ type: "chain", key, label, default: "" });
const chains = (key: string, label: string): ChainsParam => ({ type: "chains", key, label, default: [] });
const action = (key: string, label: string, act: string, o: Partial<ActionParam> = {}): ActionParam => ({ type: "action", key, label, action: act, ...o });

const INTERP: [string, string][] = [["nearest", "Nearest Neighbor"], ["bilinear", "Bilinear"], ["bicubic", "Bicubic"], ["lanczos", "Lanczos-3"]];
const DECONV: [string, string][] = [["wiener", "Wiener Filter"], ["rl", "Richardson-Lucy"], ["tikhonov", "Tikhonov (Regularized)"]];
const CORNERS: [string, string][] = [["tl", "Top Left"], ["tr", "Top Right"], ["bl", "Bottom Left"], ["br", "Bottom Right"], ["custom", "Custom"]];

const REF = {
  gw: "R.C. Gonzalez, R.E. Woods, \"Digital Image Processing\", 4th ed., Pearson, 2018.",
  wiener: "N. Wiener, \"Extrapolation, Interpolation, and Smoothing of Stationary Time Series\", MIT Press, 1949; R.C. Gonzalez, R.E. Woods, \"Digital Image Processing\", ch. 5.",
  rl: "W.H. Richardson, \"Bayesian-Based Iterative Method of Image Restoration\", JOSA 62(1), 1972; L.B. Lucy, \"An iterative technique for the rectification of observed distributions\", Astronomical Journal 79, 1974.",
  tik: "A.N. Tikhonov, V.Y. Arsenin, \"Solutions of Ill-Posed Problems\", Winston & Sons, 1977.",
  fft: "J.W. Cooley, J.W. Tukey, \"An algorithm for the machine calculation of complex Fourier series\", Mathematics of Computation 19, 1965.",
  keys: "R. Keys, \"Cubic convolution interpolation for digital image processing\", IEEE Trans. ASSP 29(6), 1981; C.E. Duchon, \"Lanczos filtering in one and two dimensions\", J. Applied Meteorology 18, 1979.",
  hz: "R. Hartley, A. Zisserman, \"Multiple View Geometry in Computer Vision\", 2nd ed., Cambridge University Press, 2004.",
  brown: "D.C. Brown, \"Decentering distortion of lenses\", Photogrammetric Engineering 32(3), 1966.",
  bt: "ITU-R Recommendation BT.601-7 (2011) and BT.709-6 (2015); CIE 15:2004 Colorimetry.",
  clahe: "K. Zuiderveld, \"Contrast Limited Adaptive Histogram Equalization\", Graphics Gems IV, Academic Press, 1994.",
  grayworld: "G. Buchsbaum, \"A spatial processor model for object colour perception\", Journal of the Franklin Institute 310(1), 1980.",
  sobel: "I. Sobel, G. Feldman, \"A 3x3 isotropic gradient operator for image processing\", Stanford AI Project, 1968; H. Scharr, PhD thesis, Heidelberg University, 2000.",
  ela: "N. Krawetz, \"A Picture's Worth: Digital Image Analysis and Forensics\", Black Hat Briefings, 2007.",
  metrology: "A. Criminisi, I. Reid, A. Zisserman, \"Single View Metrology\", International Journal of Computer Vision 40(2), 2000.",
  bilateral: "C. Tomasi, R. Manduchi, \"Bilateral filtering for gray and color images\", Proc. ICCV, 1998.",
  nlm: "A. Buades, B. Coll, J.-M. Morel, \"A non-local algorithm for image denoising\", Proc. CVPR, 2005.",
  median: "T.S. Huang, G.J. Yang, G.Y. Tang, \"A fast two-dimensional median filtering algorithm\", IEEE Trans. ASSP 27(1), 1979.",
  lim: "J.S. Lim, \"Two-Dimensional Signal and Image Processing\", Prentice Hall, 1990, p. 548 (adaptive Wiener filter).",
  deblock: "P. List, A. Joch, J. Lainema, G. Bjontegaard, M. Karczewicz, \"Adaptive deblocking filter\", IEEE Trans. CSVT 13(7), 2003.",
  ncc: "J.P. Lewis, \"Fast Normalized Cross-Correlation\", Vision Interface, 1995.",
  phase: "C.D. Kuglin, D.C. Hines, \"The phase correlation image alignment method\", Proc. IEEE Conf. Cybernetics and Society, 1975.",
  sr: "M. Irani, S. Peleg, \"Improving resolution by image registration\", CVGIP: Graphical Models and Image Processing 53(3), 1991; S. Farsiu et al., \"Fast and robust multiframe super resolution\", IEEE Trans. Image Processing 13(10), 2004.",
  deint: "G. de Haan, E.B. Bellers, \"Deinterlacing — An overview\", Proceedings of the IEEE 86(9), 1998.",
  sigma: "P.J. Huber, \"Robust Statistics\", Wiley, 1981 (sigma-clipped mean).",
  tnr: "J.C. Brailean, R.P. Kleihorst, S. Efstratiadis, A.K. Katsaggelos, R.L. Lagendijk, \"Noise reduction filters for dynamic image sequences: a review\", Proceedings of the IEEE 83(9), 1995.",
};

// ---------------------------------------------------------------- catalog
export const FILTER_LIST: FilterDef[] = [
  // ============================== Load
  {
    id: "image_loader", name: "Image Loader", category: "Load", kind: "loader",
    description: "Loads an image from file.",
    hint: "Hint: supported formats include PNG, JPEG, BMP, GIF, WebP, AVIF and TIFF. EXIF metadata is shown in the Original File tab.",
    tabs: ["Parameters", "Original File"],
    params: [{ type: "source", key: "source", label: "File", default: "" }, { type: "fileinfo", key: "_info", label: "Original File", tab: "Original File" }],
  },
  {
    id: "video_loader", name: "Video Loader", category: "Load", kind: "loader",
    description: "Loads image and video files.",
    hint: "Hint: If the video does not seek correctly, try a different \"Video Engine\" or convert it with \"Convert DVR\" to a standard MP4 container.",
    tabs: ["Parameters", "Original File"],
    params: [
      { type: "source", key: "source", label: "File", default: "" },
      sel("engine", "Video Engine", [["webcodecs", "WebCodecs (frame accurate)"], ["media", "Browser Media Element"]], "webcodecs"),
      sel("colorRange", "Color Range", [["auto", "From File"], ["limited", "Limited"], ["full", "Full"]], "auto"),
      sel("matrix", "Color Matrix", [["auto", "From File"], ["bt601", "BT.601"], ["bt709", "BT.709"], ["bt2020", "BT.2020"]], "auto"),
      sel("chroma", "Chroma Filter", [["bicubic", "Bicubic (highest quality)"], ["bilinear", "Bilinear"], ["nearest", "Nearest (replicate samples)"]], "bicubic", {
        legacy: "nearest", // earlier versions replicated chroma samples
        help: "Most video stores color at half resolution (4:2:0). Bicubic rebuilds full-resolution color from the correctly sited samples; Nearest repeats each color sample over its 2×2 pixel block (blocky, half a pixel off for H.264). Applies when the application converts the decoded planes (File Info › YUV to RGB).",
      }),
      sel("siting", "Chroma Siting", [["auto", "From File"], ["left", "Left (MPEG-2, H.264, HEVC)"], ["center", "Center (JPEG, MPEG-1)"], ["topleft", "Top-left (co-sited)"]], "auto", {
        help: "Where the color samples sit on the pixel grid. From File uses the value signaled in the stream (H.264, AV1, VP9), otherwise the MPEG default (Left).",
        show: (p) => p.chroma !== "nearest",
      }),
      sel("hdr", "HDR Video", [["tonemap", "Tone map to SDR (BT.2390)"], ["none", "Signal values as decoded"]], "tonemap", {
        legacy: "none", // earlier versions showed HDR signal values as decoded
        help: "HDR video (PQ / HDR10, or HLG as recorded by iPhones) holds brightness and colors an ordinary display cannot show: displayed as decoded it looks flat, grey and washed out. Tone map converts it like a phone or TV does (BT.2100 → BT.2390 tone mapping to the 203 cd/m² SDR white of BT.2408 → BT.709 colors). \"Signal values as decoded\" keeps the raw code values for measurement. Applies only to HDR streams when the application converts the decoded planes.",
      }),
      num("hdrPeak", "HDR Peak (cd/m²)", 200, 10000, 1000, { decimals: 0, step: 50, slider: false, show: (p) => p.hdr !== "none",
        help: "Brightest level of the HDR source to fit into SDR: 1000 cd/m² is the HLG nominal peak and the most common HDR10 mastering peak. Lower it to brighten, raise it (e.g. 4000) for content mastered brighter." }),
      action("_dvr", "Convert DVR...", "convertDvr"),
      action("_dvrLast", "Convert DVR (Last Settings)", "convertDvrLast"),
      { type: "fileinfo", key: "_info", label: "Original File", tab: "Original File" },
    ],
  },
  {
    id: "sequence_loader", name: "Sequence Loader", category: "Load", kind: "loader",
    description: "Loads a sequence of images as a video.",
    hint: "Hint: images are sorted by file name using natural ordering (img2 before img10).",
    tabs: ["Parameters", "Original File"],
    params: [{ type: "source", key: "source", label: "Files", default: "" }, num("fps", "Frame Rate", 0.1, 240, 25, { decimals: 3, slider: false }), { type: "fileinfo", key: "_info", label: "Original File", tab: "Original File" }],
  },
  {
    id: "test_pattern", name: "Test Pattern", category: "Load", kind: "loader",
    description: "Generates synthetic test material to validate the processing.",
    hint: "Hint: the license plate pattern simulates motion blur, noise and camera shake; use it to test stabilization, frame averaging and deblurring.",
    params: [
      sel("pattern", "Pattern", [["plate", "License Plate (degraded)"], ["bars", "Color Bars"], ["chart", "Resolution Chart"], ["zone", "Zone Plate"], ["grid", "Calibration Grid"], ["periodic", "Periodic Noise"]], "plate"),
      int("width", "Width", 64, 3840, 640, { slider: false }),
      int("height", "Height", 64, 2160, 360, { slider: false }),
      int("frames", "Frames", 1, 10000, 60, { slider: false }),
      num("fps", "Frame Rate", 1, 120, 25, { slider: false }),
      num("blur", "Motion Blur", 0, 40, 9, { decimals: 1 }),
      num("blurAngle", "Blur Angle", -90, 90, 12, { decimals: 0 }),
      num("noise", "Noise", 0, 60, 10, { decimals: 1 }),
      num("shake", "Camera Shake", 0, 30, 4, { decimals: 1 }),
      int("seed", "Seed", 0, 9999, 7, { slider: false }),
    ],
  },
  // ============================== Link
  {
    id: "video_mixer", name: "Video Mixer", category: "Link", kind: "link",
    description: "Mixes the current chain with another chain.",
    hint: "Hint: use \"Difference\" to highlight changes between two versions of the same video.",
    params: [
      chain("second", "Second Input"),
      sel("mode", "Mode", [["blend", "Blend"], ["difference", "Difference"], ["absdiff", "Absolute Difference"], ["sbs_h", "Side-by-Side Horizontally"], ["sbs_v", "Side-by-Side Vertically"], ["wipe_h", "Wipe Horizontal"], ["wipe_v", "Wipe Vertical"], ["checker", "Checkerboard"]], "blend"),
      num("balance", "Balance", 0, 1, 0.5, { decimals: 4 }),
      num("gain", "Gain", 1, 20, 1, { decimals: 1 }),
      int("offset", "Frame Offset", -1000, 1000, 0, { slider: false }),
      int("checker", "Checker Size", 4, 256, 32, { show: (p) => p.mode === "checker" }),
    ],
  },
  {
    id: "multiview", name: "Multiview", category: "Link", kind: "link",
    description: "Shows several chains at the same time in a grid.",
    params: [chains("chains", "Chains"), int("columns", "Columns (0 = auto)", 0, 8, 0), bool("labels", "Show Labels", true), int("border", "Border", 0, 20, 2), color("borderColor", "Border Color", "#202020")],
  },
  {
    id: "picture_in_picture", name: "Picture In Picture", category: "Link", kind: "link",
    description: "Inserts the output of another chain as an inset.",
    params: [chain("inset", "Inset Chain"), num("x", "Position X (%)", 0, 100, 70, { decimals: 1 }), num("y", "Position Y (%)", 0, 100, 5, { decimals: 1 }), num("scale", "Scale (%)", 5, 100, 25, { decimals: 1 }), int("border", "Border", 0, 20, 2), color("borderColor", "Border Color", "#ffffff"), int("offset", "Frame Offset", -1000, 1000, 0, { slider: false })],
  },
  {
    id: "timeline", name: "Timeline", category: "Link", kind: "link",
    description: "Concatenates other chains after the current one.",
    hint: "Hint: frames of the appended chains are resized to the size of the current chain.",
    params: [chains("chains", "Append Chains")],
  },
  // ============================== Write
  {
    id: "video_writer", name: "Video Writer", category: "Write", kind: "writer",
    description: "Writes the processed video to file.",
    hint: "Hint: AVI (uncompressed) stores every frame exactly, 8 bits per channel, with no compression; files of any length are written as OpenDML AVI. TIFF and PNG sequences keep 16 bits per channel or 32-bit float, numbered files in one ZIP archive without compression. Lossy formats (MP4, WebM, Motion JPEG) are hidden while Settings › Lossless exports only is on.",
    params: [
      sel("format", "Format", VIDEO_WRITER_FORMATS.map((f) => [f, videoWriterLabel(f)] as [string, string]), "avi-raw"),
      num("quality", "Quality (lossy only)", 0.1, 1, 0.92, { decimals: 2, show: (p) => isLossy(p.format) }),
      num("fps", "Frame Rate (0 = input)", 0, 240, 0, { slider: false, decimals: 3 }),
      sel("range", "Frames", [["all", "All Frames"], ["inout", "Player In/Out Range"]], "all"),
      text("name", "File Name", "output"),
      action("_write", "Write Video", "write"),
    ],
  },
  {
    id: "image_writer", name: "Image Writer", category: "Write", kind: "writer",
    description: "Writes the processed frames as images.",
    hint: "Hint: TIFF and PNG are written uncompressed. 16-bit keeps the fractional values the filters compute (8-bit levels map exactly: level × 257); 32-bit float keeps the full processing precision. Several frames are packaged into one ZIP archive without compression.",
    params: [
      sel("format", "Format", IMAGE_WRITER_FORMATS.map((f) => [f, FORMATS[f].short] as [string, string]), "tiff16"),
      num("quality", "Quality (lossy only)", 0.1, 1, 0.95, { decimals: 2, show: (p) => isLossy(p.format) }),
      sel("range", "Frames", [["current", "Current Frame"], ["all", "All Frames"], ["inout", "Player In/Out Range"]], "current"),
      text("name", "File Name", "frame"),
      action("_write", "Write Images", "write"),
    ],
  },
  // ============================== Select Frames
  { id: "single_selector", name: "Single Selector", category: "Select Frames", kind: "filter", description: "Selects a single frame of the video.", params: [frame("frame", "Frame")] },
  {
    id: "range_selector", name: "Range Selector", category: "Select Frames", kind: "filter",
    description: "Selects a range of frames of the video.",
    hint: "Hint: use the In/Out markers of the player or the \"Current\" buttons to set the range.",
    params: [frame("start", "First Frame", 0), frame("end", "Last Frame (-1 = end)", -1, { allowLast: true }), int("step", "Step", 1, 1000, 1, { slider: false })],
  },
  {
    id: "sparse_selector", name: "Sparse Selector", category: "Select Frames", kind: "filter",
    description: "Selects a list of frames of the video.",
    hint: "Hint: comma separated list of frames and ranges, e.g. 0, 12, 30-45.",
    params: [text("frames", "Frames", "0"), action("_add", "Add Current Frame", "addCurrentFrame")],
  },
  {
    id: "remove_duplicates", name: "Remove Duplicates", category: "Select Frames", kind: "filter", temporal: true,
    description: "Removes duplicated frames (typical of CCTV recordings at variable frame rate).",
    hint: "Hint: the difference is the mean absolute difference per pixel (0-255) with the last kept frame.",
    params: [num("threshold", "Threshold", 0, 50, 0.5, { decimals: 2 }), rect("roi", "Region (optional)")],
    overlayOn: "any",
  },
  {
    id: "iframes_selector", name: "Frame Type Selector", category: "Select Frames", kind: "filter",
    description: "Selects frames by their compression type (I, P, B).",
    hint: "Hint: I-frames are intra coded and typically have the best quality in a group of pictures.",
    params: [bool("keepI", "I Frames", true), bool("keepP", "P Frames", false), bool("keepB", "B Frames", false)],
  },
  {
    id: "demultiplexer", name: "Demultiplexer", category: "Select Frames", kind: "filter", temporal: true,
    description: "Automatically selects similar frames (to discard bad frames or separate multiplexed cameras) with the ability to set a similarity threshold and a reference frame.",
    params: [frame("reference", "Reference Frame"), num("threshold", "Similarity Threshold", 0, 100, 75, { decimals: 1 }), rect("roi", "Region (optional)")],
    overlayOn: "any",
  },
  {
    id: "motion_detection", name: "Motion Detection", category: "Select Frames", kind: "filter", temporal: true,
    description: "Selects the frames with motion in a region.",
    params: [rect("roi", "Region"), num("threshold", "Pixel Threshold", 1, 128, 20, { decimals: 0 }), num("minArea", "Minimum Area (%)", 0, 100, 0.5, { decimals: 2 }), sel("mode", "Keep", [["motion", "Frames With Motion"], ["still", "Frames Without Motion"]], "motion")],
    overlayOn: "any",
  },
  // ============================== Deinterlacing
  {
    id: "deinterlace", name: "Deinterlace", category: "Deinterlacing", kind: "filter", reference: REF.deint,
    description: "Removes the interlacing artifacts.",
    params: [sel("field", "Field", [["top", "Top (Even)"], ["bottom", "Bottom (Odd)"]], "top"), sel("method", "Method", [["linear", "Linear Interpolation"], ["duplicate", "Line Duplication"], ["blend", "Field Blending"], ["bob", "Bob (Double Frame Rate)"]], "linear")],
  },
  { id: "line_doubling", name: "Line Doubling", category: "Deinterlacing", kind: "filter", reference: REF.deint, description: "Keeps one field and doubles its lines.", params: [sel("field", "Field", [["top", "Top (Even)"], ["bottom", "Bottom (Odd)"]], "top")] },
  { id: "field_separation", name: "Field Separation", category: "Deinterlacing", kind: "filter", description: "Separates the two fields of each frame.", params: [sel("mode", "Mode", [["stack", "Stacked (Top/Bottom)"], ["sequence", "Sequence (Double Frames)"]], "stack")] },
  { id: "field_shift", name: "Field Shift", category: "Deinterlacing", kind: "filter", description: "Shifts one field to correct misaligned interlaced recordings.", params: [sel("field", "Field", [["top", "Top (Even)"], ["bottom", "Bottom (Odd)"]], "bottom"), int("dx", "Shift X", -64, 64, 0), int("dy", "Shift Y", -8, 8, 0)] },
  { id: "interleave", name: "Interleave", category: "Deinterlacing", kind: "filter", description: "Interleaves pairs of consecutive frames as the two fields of a frame.", params: [sel("first", "First Frame As", [["top", "Top Field"], ["bottom", "Bottom Field"]], "top")] },
  // ============================== Edit
  {
    id: "crop", name: "Crop", category: "Edit", kind: "filter", overlayOn: "input",
    description: "Crops a region of the image.",
    hint: "Hint: draw the region on the Viewer (the input is shown while editing), then press Apply.",
    params: [rect("rect", "Region")],
  },
  {
    id: "resize", name: "Resize", category: "Edit", kind: "filter", reference: REF.keys,
    description: "Changes the size of the image.",
    params: [
      sel("mode", "Mode", [["scale", "Scale Factor"], ["size", "Absolute Size"]], "scale"),
      num("scale", "Scale (%)", 1, 1600, 200, { decimals: 1, show: (p) => p.mode === "scale" }),
      int("width", "Width", 1, 16384, 1280, { slider: false, show: (p) => p.mode === "size" }),
      int("height", "Height", 1, 16384, 720, { slider: false, show: (p) => p.mode === "size" }),
      bool("keepAspect", "Keep Aspect Ratio", true, { show: (p) => p.mode === "size" }),
      sel("interp", "Interpolation", INTERP, "bicubic"),
    ],
  },
  { id: "rotate", name: "Rotate", category: "Edit", kind: "filter", reference: REF.keys, description: "Rotates the image.", params: [num("angle", "Angle", -180, 180, 0, { decimals: 2 }), sel("interp", "Interpolation", INTERP.slice(0, 3), "bicubic"), bool("expand", "Expand Canvas", true), color("background", "Background", "#000000")] },
  { id: "flip", name: "Flip", category: "Edit", kind: "filter", description: "Flips the image horizontally or vertically.", params: [bool("horizontal", "Horizontal", true), bool("vertical", "Vertical", false)] },
  {
    id: "correct_perspective", name: "Correct Perspective", category: "Edit", kind: "filter", overlayOn: "input", reference: REF.hz,
    description: "Rectifies a planar surface seen in perspective (e.g. a license plate or a document).",
    hint: "Hint: click the four corners of the plane in clockwise order starting from the top left (the input is shown while editing).",
    params: [points("points", "Corners", { minPoints: 4, maxPoints: 4, closed: true }), int("outWidth", "Output Width (0 = auto)", 0, 8192, 0, { slider: false }), int("outHeight", "Output Height (0 = auto)", 0, 8192, 0, { slider: false }), sel("interp", "Interpolation", INTERP.slice(0, 3), "bicubic")],
  },
  {
    id: "lens_distortion", name: "Correct Lens Distortion", category: "Edit", kind: "filter", reference: REF.brown,
    description: "Corrects the radial (barrel or pincushion) distortion of wide angle lenses.",
    params: [num("k1", "Radial k1", -1, 1, 0, { decimals: 4 }), num("k2", "Radial k2", -1, 1, 0, { decimals: 4 }), num("cx", "Center X", 0, 1, 0.5, { decimals: 3 }), num("cy", "Center Y", 0, 1, 0.5, { decimals: 3 }), num("zoom", "Zoom", 0.2, 3, 1, { decimals: 3 }), sel("interp", "Interpolation", INTERP.slice(0, 3), "bicubic")],
  },
  {
    id: "aspect_ratio", name: "Correct Aspect Ratio", category: "Edit", kind: "filter", reference: REF.keys,
    description: "Corrects non-square pixels (e.g. 704x576 PAL or 720x480 NTSC recordings).",
    params: [sel("mode", "Pixel Aspect Ratio", [["source", "From Source"], ["custom", "Custom"], ["pal", "PAL 4:3 (12:11)"], ["ntsc", "NTSC 4:3 (10:11)"], ["half", "Half Height CIF (2:1)"]], "source"), num("par", "Custom PAR", 0.25, 4, 1, { decimals: 4, show: (p) => p.mode === "custom" }), sel("direction", "Adjust", [["width", "Width"], ["height", "Height"]], "width"), sel("interp", "Interpolation", INTERP, "bicubic")],
  },
  // ============================== Channels
  { id: "grayscale", name: "Grayscale Conversion", category: "Channels", kind: "filter", reference: REF.bt, description: "Converts the image to grayscale.", params: [sel("method", "Method", [["bt601", "Luma BT.601"], ["bt709", "Luma BT.709"], ["average", "Average"], ["lightness", "Lightness"], ["max", "Maximum"], ["min", "Minimum"]], "bt601")] },
  { id: "color_conversion", name: "Color Conversion", category: "Channels", kind: "filter", reference: REF.bt, description: "Converts the image to another color space and shows its channels as RGB.", params: [sel("space", "Color Space", [["ycbcr601", "YCbCr (BT.601)"], ["ycbcr709", "YCbCr (BT.709)"], ["hsv", "HSV"], ["hsl", "HSL"], ["lab", "CIE L*a*b*"], ["cmy", "CMY"], ["xyz", "CIE XYZ"]], "ycbcr601")] },
  {
    id: "color_switch", name: "Color Switch", category: "Channels", kind: "filter", description: "Swaps the color channels.",
    params: ["r", "g", "b"].map((c) => sel(c, `${c.toUpperCase()} Output`, [["r", "Red"], ["g", "Green"], ["b", "Blue"], ["zero", "Zero"], ["full", "Full"]], c === "r" ? "b" : c === "b" ? "r" : "g")),
  },
  { id: "extract_channel", name: "Extract Channel", category: "Channels", kind: "filter", reference: REF.bt, description: "Extracts a single channel as a grayscale image.", params: [sel("channel", "Channel", [["r", "Red"], ["g", "Green"], ["b", "Blue"], ["y", "Luma (Y)"], ["cb", "Chroma Blue (Cb)"], ["cr", "Chroma Red (Cr)"], ["h", "Hue"], ["s", "Saturation"], ["v", "Value"], ["l", "Lightness L*"], ["a", "a*"], ["bb", "b*"], ["c", "Cyan"], ["m", "Magenta"], ["ye", "Yellow"], ["k", "Black (K)"]], "y"), bool("stretch", "Stretch Values", false)] },
  { id: "enable_channels", name: "Enable Channels", category: "Channels", kind: "filter", description: "Enables or disables the single channels.", params: [bool("r", "Red", true), bool("g", "Green", true), bool("b", "Blue", true)] },
  { id: "replace_channel", name: "Replace Channel", category: "Channels", kind: "link", description: "Replaces a channel with a channel of another chain.", params: [sel("target", "Target Channel", [["r", "Red"], ["g", "Green"], ["b", "Blue"]], "r"), chain("source", "Source Chain"), sel("sourceChannel", "Source Channel", [["r", "Red"], ["g", "Green"], ["b", "Blue"], ["y", "Luma"]], "y")] },
  // ============================== Adjust
  {
    id: "levels", name: "Levels", category: "Adjust", kind: "filter", reference: REF.gw,
    description: "Adjusts the input and output levels of the image.",
    params: [sel("channel", "Channel", [["all", "All"], ["r", "Red"], ["g", "Green"], ["b", "Blue"]], "all"), num("inBlack", "Input Black", 0, 255, 0, { decimals: 1 }), num("inWhite", "Input White", 0, 255, 255, { decimals: 1 }), num("gamma", "Gamma", 0.1, 10, 1, { decimals: 3, log: true }), num("outBlack", "Output Black", 0, 255, 0, { decimals: 1 }), num("outWhite", "Output White", 0, 255, 255, { decimals: 1 }), action("_auto", "Auto Levels", "autoLevels")],
  },
  { id: "curves", name: "Curves", category: "Adjust", kind: "filter", reference: REF.gw, description: "Adjusts the tonal range with a curve.", hint: "Hint: click to add points, drag to move them, double click to remove.", params: [sel("channel", "Channel", [["all", "All"], ["r", "Red"], ["g", "Green"], ["b", "Blue"]], "all"), { type: "curve", key: "curve", label: "Curve", default: [{ x: 0, y: 0 }, { x: 255, y: 255 }] }] },
  { id: "brightness_contrast", name: "Brightness/Contrast", category: "Adjust", kind: "filter", description: "Adjusts the brightness and the contrast.", params: [num("brightness", "Brightness", -255, 255, 0, { decimals: 1 }), num("contrast", "Contrast", -100, 100, 0, { decimals: 1 })] },
  { id: "exposure", name: "Exposure/Gamma", category: "Adjust", kind: "filter", description: "Adjusts exposure, gamma and offset.", params: [num("exposure", "Exposure (stops)", -5, 5, 0, { decimals: 2 }), num("gamma", "Gamma", 0.1, 5, 1, { decimals: 3, log: true }), num("offset", "Offset", -128, 128, 0, { decimals: 1 })] },
  { id: "auto_contrast", name: "Auto Contrast", category: "Adjust", kind: "filter", reference: REF.gw, description: "Stretches the histogram automatically for each frame.", params: [num("clipLow", "Clip Shadows (%)", 0, 20, 0.5, { decimals: 2 }), num("clipHigh", "Clip Highlights (%)", 0, 20, 0.5, { decimals: 2 }), bool("linked", "Link Channels", true)] },
  { id: "histogram_equalization", name: "Histogram Equalization", category: "Adjust", kind: "filter", reference: REF.clahe, description: "Equalizes the histogram globally or locally (CLAHE).", params: [sel("mode", "Mode", [["global", "Global"], ["clahe", "Local (CLAHE)"]], "clahe"), int("tiles", "Tiles", 2, 32, 8, { show: (p) => p.mode === "clahe" }), num("clip", "Clip Limit", 1, 20, 3, { decimals: 1, show: (p) => p.mode === "clahe" }), sel("target", "Apply To", [["luma", "Luminance"], ["rgb", "RGB Channels"]], "luma"), num("amount", "Amount", 0, 1, 1, { decimals: 2 })] },
  {
    id: "white_balance", name: "Color Balance", category: "Adjust", kind: "filter", reference: REF.grayworld, overlayOn: "any",
    description: "Corrects color casts manually, automatically or from a neutral reference.",
    params: [sel("mode", "Mode", [["manual", "Manual Gains"], ["grayworld", "Gray World"], ["whitepatch", "White Patch"], ["point", "Neutral Reference Point"]], "grayworld"), num("r", "Red Gain", 0, 4, 1, { decimals: 3, show: (p) => p.mode === "manual" }), num("g", "Green Gain", 0, 4, 1, { decimals: 3, show: (p) => p.mode === "manual" }), num("b", "Blue Gain", 0, 4, 1, { decimals: 3, show: (p) => p.mode === "manual" }), point("point", "Reference Point", null, { show: (p) => p.mode === "point" }), int("radius", "Sample Radius", 0, 20, 3, { show: (p) => p.mode === "point" })],
  },
  { id: "hue_saturation", name: "Hue/Saturation", category: "Adjust", kind: "filter", description: "Adjusts hue, saturation and lightness.", params: [num("hue", "Hue", -180, 180, 0, { decimals: 1 }), num("saturation", "Saturation", -100, 100, 0, { decimals: 1 }), num("lightness", "Lightness", -100, 100, 0, { decimals: 1 })] },
  { id: "negative", name: "Negative", category: "Adjust", kind: "filter", description: "Inverts the values of the image.", params: [] },
  { id: "threshold", name: "Threshold", category: "Adjust", kind: "filter", description: "Converts the image to black and white.", params: [num("level", "Level", 0, 255, 128, { decimals: 1 }), sel("mode", "Mode", [["luma", "Luminance"], ["rgb", "Each Channel"]], "luma")] },
  // ============================== Extract
  { id: "fourier", name: "Fourier", category: "Extract", kind: "filter", reference: REF.fft, description: "Shows the Fourier spectrum of the image.", params: [sel("mode", "Show", [["magnitude", "Magnitude"], ["phase", "Phase"]], "magnitude"), bool("log", "Logarithmic", true), sel("channel", "Channel", [["y", "Luminance"], ["r", "Red"], ["g", "Green"], ["b", "Blue"]], "y")] },
  {
    id: "fourier_filter", name: "Fourier Filter", category: "Extract", kind: "filter", reference: REF.fft, overlayOn: "any",
    description: "Removes periodic noise or applies low/high pass filters in the frequency domain.",
    hint: "Hint: select \"View: Spectrum\" and click on the bright peaks of the periodic noise, then switch back to \"Filtered\".",
    params: [sel("view", "View", [["filtered", "Filtered Image"], ["spectrum", "Spectrum"]], "spectrum"), sel("filter", "Filter", [["notch", "Notch Reject"], ["lowpass", "Low Pass"], ["highpass", "High Pass"]], "notch"), points("points", "Notches", { show: (p) => p.filter === "notch", overlayIf: (p) => p.view === "spectrum" }), num("radius", "Notch Radius", 1, 64, 8, { decimals: 1, show: (p) => p.filter === "notch" }), bool("symmetric", "Symmetric Notches", true, { show: (p) => p.filter === "notch" }), num("cutoff", "Cutoff", 0.005, 0.5, 0.1, { decimals: 3, show: (p) => p.filter !== "notch" }), bool("smooth", "Smooth Transition", true)],
  },
  { id: "gradient", name: "Edge Detection", category: "Extract", kind: "filter", reference: REF.sobel, description: "Computes the gradient (edges) of the image.", params: [sel("operator", "Operator", [["sobel", "Sobel"], ["prewitt", "Prewitt"], ["scharr", "Scharr"], ["laplacian", "Laplacian"]], "sobel"), sel("output", "Output", [["magnitude", "Magnitude"], ["x", "Horizontal"], ["y", "Vertical"], ["direction", "Direction (Color)"]], "magnitude"), num("gain", "Gain", 0.1, 20, 1, { decimals: 2 })] },
  { id: "frame_difference", name: "Frame Difference", category: "Extract", kind: "filter", temporal: true, description: "Shows the difference between each frame and a previous one.", params: [int("offset", "Frame Offset", 1, 100, 1), num("gain", "Gain", 1, 20, 4, { decimals: 1 }), sel("mode", "Mode", [["abs", "Absolute"], ["signed", "Signed (Gray = 0)"]], "abs")] },
  { id: "bit_plane", name: "Bit Plane", category: "Extract", kind: "filter", reference: REF.gw, description: "Shows a single bit plane of a channel (hidden information, compression traces).", params: [sel("channel", "Channel", [["r", "Red"], ["g", "Green"], ["b", "Blue"], ["y", "Luma"]], "y"), int("bit", "Bit", 0, 7, 0)] },
  // ============================== Verify
  {
    id: "compare_original", name: "Compare Original", category: "Verify", kind: "filter",
    description: "Compares the processed image with the original.",
    hint: "Hint: For more advanced comparison functions, please use the \"Video Mixer\" filter.",
    params: [sel("mode", "Mode", [["sbs_h", "Side-by-Side Horizontally"], ["sbs_v", "Side-by-Side Vertically"], ["blend", "Blend"], ["wipe_h", "Wipe Horizontal"], ["wipe_v", "Wipe Vertical"], ["difference", "Difference"]], "sbs_h"), num("balance", "Balance", 0, 1, 0.5, { decimals: 4 }), num("gain", "Gain", 1, 5, 1, { decimals: 2 }), color("lineColor", "Line Color", "#c0c0c0"), int("lineThickness", "Line Thickness", 0, 20, 0), bool("originalFirst", "Original First (Left/Top)", true)],
  },
  { id: "ela", name: "Error Level Analysis", category: "Verify", kind: "filter", reference: REF.ela, description: "Highlights areas with a different JPEG compression level.",
    hint: "The image is re-compressed with a built-in JPEG model (IJG tables, 4:2:0 chroma) instead of the browser's encoder, so the result is identical in every browser.",
    params: [int("quality", "JPEG Quality", 50, 100, 90), sel("chroma", "Chroma Subsampling", [["420", "4:2:0 (most cameras)"], ["444", "4:4:4 (none)"]], "420"), num("scale", "Scale", 1, 60, 15, { decimals: 1 })] },
  // ============================== Measure
  {
    id: "measure_1d", name: "Measure 1D", category: "Measure", kind: "filter", reference: REF.metrology, overlayOn: "any",
    description: "Measures a length using a reference of known length on the same line.",
    hint: "Hint: draw the reference segment, enter its real length, then draw the segment to measure. Valid only for objects on the same plane and direction.",
    params: [line("refLine", "Reference Segment"), num("refLength", "Reference Length", 0.001, 100000, 1, { slider: false, decimals: 3 }), text("unit", "Unit", "m"), line("line", "Measured Segment"), color("color", "Color", "#ffd400"), int("size", "Label Size", 8, 72, 16)],
  },
  {
    id: "measure_2d", name: "Measure 2D", category: "Measure", kind: "filter", reference: REF.metrology, overlayOn: "any",
    description: "Measures distances on a plane calibrated with a rectangle of known size.",
    hint: "Hint: click the four corners of a rectangle of known size (clockwise from top left), then draw the segment to measure.",
    params: [points("refPoints", "Reference Rectangle", { minPoints: 4, maxPoints: 4, closed: true }), num("refWidth", "Rectangle Width", 0.001, 100000, 0.52, { slider: false, decimals: 3 }), num("refHeight", "Rectangle Height", 0.001, 100000, 0.11, { slider: false, decimals: 3 }), text("unit", "Unit", "m"), line("line", "Measured Segment"), color("color", "Color", "#00e0ff"), int("size", "Label Size", 8, 72, 16)],
  },
  // ============================== Sharpen
  { id: "unsharp_mask", name: "Unsharp Masking", category: "Sharpen", kind: "filter", reference: REF.gw, description: "Sharpens the image by adding the difference with a blurred version.", params: [num("radius", "Radius", 0.3, 20, 1.5, { decimals: 2 }), num("amount", "Amount", 0, 5, 1, { decimals: 2 }), num("threshold", "Threshold", 0, 50, 0, { decimals: 1 })] },
  { id: "laplacian_sharpening", name: "Laplacian Sharpening", category: "Sharpen", kind: "filter", reference: REF.gw, description: "Sharpens the image with a Laplacian filter.", params: [num("amount", "Amount", 0, 5, 1, { decimals: 2 }), bool("diagonals", "Include Diagonals", true)] },
  { id: "high_pass_sharpening", name: "High Pass Sharpening", category: "Sharpen", kind: "filter", reference: REF.gw, description: "Enhances local contrast with a large radius high pass filter.", params: [num("radius", "Radius", 2, 100, 20, { decimals: 1 }), num("amount", "Amount", 0, 3, 0.5, { decimals: 2 })] },
  // ============================== Denoise
  { id: "averaging_filter", name: "Averaging Filter", category: "Denoise", kind: "filter", reference: REF.gw, description: "Reduces the noise by averaging neighboring pixels.", params: [int("radius", "Radius", 1, 20, 1)] },
  { id: "gaussian_filter", name: "Gaussian Filter", category: "Denoise", kind: "filter", reference: REF.gw, description: "Reduces the noise with a Gaussian blur.", params: [num("sigma", "Sigma", 0.3, 30, 1, { decimals: 2 })] },
  { id: "median_filter", name: "Median Filter", category: "Denoise", kind: "filter", reference: REF.median, description: "Reduces impulsive (salt and pepper) noise preserving edges.", params: [int("radius", "Radius", 1, 7, 1)] },
  { id: "bilateral_filter", name: "Bilateral Filter", category: "Denoise", kind: "filter", reference: REF.bilateral, description: "Reduces the noise preserving the edges.", params: [num("sigmaS", "Spatial Sigma", 0.5, 8, 2, { decimals: 2 }), num("sigmaR", "Range Sigma", 1, 100, 20, { decimals: 1 })] },
  { id: "nl_means", name: "Non-Local Means", category: "Denoise", kind: "filter", reference: REF.nlm, slow: true, description: "Advanced denoising comparing patches in a search window.", params: [num("h", "Strength", 1, 50, 10, { decimals: 1 }), int("patch", "Patch Radius", 1, 3, 1), int("search", "Search Radius", 2, 10, 5)] },
  { id: "wiener_filter", name: "Wiener Filter", category: "Denoise", kind: "filter", reference: REF.lim, description: "Adaptive filter based on local statistics.", params: [int("radius", "Radius", 1, 6, 2), num("noise", "Noise Variance (0 = auto)", 0, 2000, 0, { decimals: 1 })] },
  { id: "deblocking", name: "Deblocking", category: "Denoise", kind: "filter", reference: REF.deblock, description: "Reduces the blocking artifacts of JPEG and MPEG compression.", params: [int("block", "Block Size", 4, 32, 8, { step: 4 }), num("strength", "Strength", 0, 1, 0.6, { decimals: 2 }), num("threshold", "Edge Threshold", 1, 80, 24, { decimals: 1 })] },
  // ============================== Deblurring
  {
    id: "motion_deblurring", name: "Motion Deblurring", category: "Deblurring", kind: "filter", reference: REF.wiener + " " + REF.rl, overlayOn: "any",
    description: "Corrects a linear motion blur.",
    hint: "Hint: draw a line along a blur trail in the Viewer to set length and angle, then adjust the noise.",
    params: [line("line", "Blur Trail"), num("length", "Length", 1, 150, 10, { decimals: 1 }), num("angle", "Angle", -180, 180, 0, { decimals: 1 }), sel("method", "Method", DECONV, "wiener"), num("noise", "Noise", 0.0001, 1, 0.01, { decimals: 4, log: true }), int("iterations", "Iterations", 1, 200, 25, { show: (p) => p.method === "rl" }), { type: "psf", key: "_psf", label: "Point Spread Function" }],
  },
  {
    id: "optical_deblurring", name: "Optical Deblurring", category: "Deblurring", kind: "filter", reference: REF.wiener,
    description: "Corrects an out of focus blur.",
    params: [num("radius", "Radius", 0.5, 40, 3, { decimals: 2 }), sel("method", "Method", DECONV, "wiener"), num("noise", "Noise", 0.0001, 1, 0.01, { decimals: 4, log: true }), int("iterations", "Iterations", 1, 200, 25, { show: (p) => p.method === "rl" }), { type: "psf", key: "_psf", label: "Point Spread Function" }],
  },
  {
    id: "gaussian_deblurring", name: "Gaussian Deblurring", category: "Deblurring", kind: "filter", reference: REF.wiener,
    description: "Corrects a Gaussian blur (atmospheric or sensor).",
    params: [num("sigma", "Sigma", 0.3, 20, 1.5, { decimals: 2 }), sel("method", "Method", DECONV, "wiener"), num("noise", "Noise", 0.0001, 1, 0.01, { decimals: 4, log: true }), int("iterations", "Iterations", 1, 200, 25, { show: (p) => p.method === "rl" }), { type: "psf", key: "_psf", label: "Point Spread Function" }],
  },
  {
    id: "nonlinear_deblurring", name: "Nonlinear Deblurring", category: "Deblurring", kind: "filter", reference: REF.wiener + " " + REF.rl, overlayOn: "any",
    description: "Corrects a blur with a non linear trajectory.",
    hint: "Hint: Add points to follow the shape of blur.",
    tabs: ["Settings", "Advanced"],
    params: [points("points", "Points", { minPoints: 2, maxPoints: 64, polyline: true }), num("noise", "Noise", 0.0001, 1, 0.01, { decimals: 4, log: true }), int("thickness", "Thickness", 1, 199, 1), { type: "psf", key: "_psf", label: "Point Spread Function" }, sel("method", "Method", DECONV, "wiener", { tab: "Advanced" }), int("iterations", "Iterations", 1, 200, 25, { tab: "Advanced" })],
  },
  // ============================== Stabilization
  {
    id: "local_stabilization", name: "Local Stabilization", category: "Stabilization", kind: "filter", temporal: true, reference: REF.ncc, overlayOn: "any",
    description: "Stabilizes the video on a selected object (e.g. a license plate).",
    hint: "Hint: select a small region with good details on the object to track. The reference frame is where the object position is kept.",
    params: [rect("roi", "Tracked Region"), frame("reference", "Reference Frame"), int("search", "Search Range (px)", 4, 256, 32), bool("subpixel", "Sub-pixel Accuracy", true), sel("fill", "Borders", [["black", "Black"], ["edge", "Replicate Edge"]], "black")],
  },
  {
    id: "global_stabilization", name: "Global Stabilization", category: "Stabilization", kind: "filter", temporal: true, reference: REF.phase,
    description: "Stabilizes the whole frame with phase correlation.",
    params: [frame("reference", "Reference Frame"), bool("subpixel", "Sub-pixel Accuracy", true), sel("fill", "Borders", [["black", "Black"], ["edge", "Replicate Edge"]], "black")],
  },
  // ============================== Integrate
  {
    id: "frame_averaging", name: "Frame Averaging", category: "Integrate", kind: "filter", temporal: true, reference: REF.sigma,
    description: "Averages several frames to reduce the noise.",
    hint: "Hint: stabilize the video and select the range of frames before averaging. \"All Frames\" outputs a single integrated frame.",
    params: [sel("mode", "Frames", [["all", "All Frames"], ["window", "Moving Window"]], "all"), int("window", "Window Size", 2, 200, 5, { show: (p) => p.mode === "window" }), sel("method", "Method", [["mean", "Mean"], ["median", "Median"], ["sigma", "Sigma Clipped Mean"]], "mean"), num("sigma", "Sigma", 1, 5, 2, { decimals: 2, show: (p) => p.method === "sigma" })],
  },
  {
    id: "temporal_smoothing", name: "Temporal Smoothing", category: "Integrate", kind: "filter", temporal: true, reference: REF.tnr,
    description: "Reduces the noise of a video by combining each frame with its neighbors (moving window); the number of frames does not change.",
    hint: "Hint: stabilize the video first if the camera moves. Protect Moving Objects keeps moving subjects free of ghost trails: raise the Motion Threshold for very noisy footage.",
    params: [
      int("size", "Size", 2, 31, 5, { help: "Frames combined for each output frame: the current frame and its neighbors, half before and half after (fewer at the start and end of the clip). Larger windows remove more noise." }),
      sel("method", "Method", [["mean", "Mean"], ["gaussian", "Gaussian Weighted"], ["median", "Median"]], "mean", { help: "Mean: every frame of the window weighs the same (classic moving average). Gaussian Weighted: the closer a frame, the more it weighs, which keeps more of the motion. Median: also removes short-lived specks such as sparks, snow and dropouts." }),
      bool("protect", "Protect Moving Objects", true, { help: "Leaves out the pixels of neighboring frames that differ from the current frame, so moving subjects leave no ghost trails. Still areas are smoothed as usual." }),
      num("threshold", "Motion Threshold", 1, 100, 12, { decimals: 1, show: (p) => p.protect !== false, help: "Difference to the current frame (largest of R, G and B in 0-255 levels, weighted mean over 3x3 pixels) above which a pixel counts as moving and is left out: changes of brightness and of color both count. Raise it for very noisy footage, lower it if faint ghosts remain." }),
      bool("showMask", "Show Protected Areas", false, { show: (p) => p.protect !== false, help: "Shows the image in gray with the pixels left out because of motion in red (stronger where more frames were left out), to check the threshold. Turn it off before exporting." }),
    ],
  },
  {
    id: "super_resolution", name: "Super Resolution", category: "Integrate", kind: "filter", temporal: true, slow: true, reference: REF.sr, overlayOn: "any",
    description: "Combines the frames with sub-pixel registration to increase the resolution.",
    hint: "Hint: select a region on the object for registration. Works best on stabilized, slightly moving content.",
    params: [int("scale", "Scale Factor", 2, 4, 2), rect("roi", "Registration Region (optional)"), int("maxFrames", "Maximum Frames", 2, 200, 30), sel("kernel", "Splat Kernel", [["gaussian", "Gaussian"], ["bilinear", "Bilinear"]], "gaussian")],
  },
  // ============================== Presentation
  { id: "add_text", name: "Add Text", category: "Presentation", kind: "filter", overlayOn: "any", description: "Adds a text to the image.", params: [text("text", "Text", "Text", { multiline: true }), point("position", "Position", { x: 20, y: 20 }), int("size", "Size", 6, 300, 32), sel("font", "Font", [["sans", "Sans Serif"], ["serif", "Serif"], ["mono", "Monospace"]], "sans"), bool("bold", "Bold", true), color("color", "Color", "#ffffff"), bool("background", "Background", true), color("bgColor", "Background Color", "#000000"), num("bgOpacity", "Background Opacity", 0, 1, 0.6, { decimals: 2 })] },
  {
    id: "add_shape", name: "Add Shape", category: "Presentation", kind: "filter", overlayOn: "any",
    description: "Select and draw shapes on current frame.",
    tabs: ["Settings", "Selection"],
    params: [sel("shape", "Shape Type", [["rectangle", "Rectangle"], ["ellipse", "Ellipse"], ["line", "Line"], ["arrow", "Arrow"], ["double_arrow", "Double Arrow"]], "rectangle"), int("thickness", "Border Thickness", 0, 50, 3), color("borderColor", "Border Color", "#ff2020"), bool("fill", "Fill Area", false, { show: (p) => p.shape === "rectangle" || p.shape === "ellipse" }), color("fillColor", "Fill Color", "#ff2020", { show: (p) => p.fill && (p.shape === "rectangle" || p.shape === "ellipse") }), num("fillOpacity", "Fill Opacity", 0, 1, 0.3, { decimals: 2, show: (p) => p.fill && (p.shape === "rectangle" || p.shape === "ellipse") }), rect("rect", "Area", { tab: "Selection", show: (p) => p.shape === "rectangle" || p.shape === "ellipse" }), line("line", "Line", { tab: "Selection", show: (p) => p.shape === "line" || p.shape === "arrow" || p.shape === "double_arrow" }), frame("from", "From Frame", 0, { tab: "Selection" }), frame("to", "To Frame (-1 = end)", -1, { tab: "Selection", allowLast: true })],
  },
  { id: "hide_selection", name: "Hide Selection", category: "Presentation", kind: "filter", overlayOn: "any", description: "Hides a region (faces, plates of bystanders) by blurring, pixelating or filling.", params: [rect("rect", "Region"), sel("shape", "Shape", [["rectangle", "Rectangle"], ["ellipse", "Ellipse"]], "rectangle"), sel("mode", "Mode", [["pixelate", "Pixelate"], ["blur", "Blur"], ["fill", "Fill"]], "pixelate"), int("strength", "Strength", 2, 100, 16), color("color", "Fill Color", "#000000", { show: (p) => p.mode === "fill" })] },
  { id: "spotlight", name: "Spotlight", category: "Presentation", kind: "filter", overlayOn: "any", description: "Highlights a region by dimming the rest of the image.", params: [rect("rect", "Region"), sel("shape", "Shape", [["ellipse", "Ellipse"], ["rectangle", "Rectangle"]], "ellipse"), num("dim", "Dimming", 0, 1, 0.6, { decimals: 2 }), int("feather", "Feather", 0, 200, 16), bool("border", "Border", true), color("borderColor", "Border Color", "#ffd400")] },
  { id: "magnify", name: "Magnify", category: "Presentation", kind: "filter", overlayOn: "any", description: "Shows a magnified inset of a region.", params: [rect("rect", "Region"), num("zoom", "Zoom", 1, 10, 2.5, { decimals: 2 }), sel("position", "Position", CORNERS.slice(0, 4), "tr"), sel("interp", "Interpolation", INTERP, "bicubic"), int("border", "Border", 0, 20, 2), color("borderColor", "Border Color", "#ffd400")] },
  { id: "add_timestamp", name: "Add Timestamp", category: "Presentation", kind: "filter", description: "Adds the frame number and/or time to each frame.", params: [sel("format", "Format", [["both", "Frame and Time"], ["frame", "Frame Number"], ["time", "Time"], ["datetime", "Date and Time"]], "both"), text("start", "Start Date/Time", "2026-01-01 00:00:00.000", { show: (p) => p.format === "datetime" }), sel("position", "Position", CORNERS.slice(0, 4), "bl"), int("size", "Size", 8, 120, 20), color("color", "Color", "#ffffff"), bool("background", "Background", true)] },
  { id: "add_logo", name: "Add Logo", category: "Presentation", kind: "filter", description: "Adds a logo or watermark image.", params: [{ type: "image", key: "image", label: "Logo Image", default: "" }, sel("position", "Position", CORNERS.slice(0, 4), "tr"), num("scale", "Scale (%)", 1, 200, 20, { decimals: 1 }), num("opacity", "Opacity", 0, 1, 0.85, { decimals: 2 }), int("margin", "Margin", 0, 200, 12)] },
  { id: "add_grid", name: "Add Grid", category: "Presentation", kind: "filter", description: "Overlays a grid for reference.", params: [int("spacing", "Spacing", 4, 1000, 50), int("thickness", "Thickness", 1, 10, 1), color("color", "Color", "#00ff66"), num("opacity", "Opacity", 0, 1, 0.5, { decimals: 2 }), bool("labels", "Coordinates", false)] },
  { id: "change_frame_rate", name: "Change Frame Rate", category: "Presentation", kind: "filter", description: "Changes the nominal frame rate (playback speed) without changing the frames.", params: [num("fps", "Frame Rate", 0.1, 240, 25, { decimals: 3, slider: false })] },
  { id: "convert_frame_rate", name: "Convert Frame Rate", category: "Presentation", kind: "filter", description: "Converts the frame rate by duplicating, dropping or blending frames.", params: [num("fps", "Target Frame Rate", 0.1, 240, 25, { decimals: 3, slider: false }), sel("method", "Method", [["nearest", "Duplicate/Drop"], ["blend", "Blend"]], "nearest")] },
  { id: "reverse", name: "Reverse", category: "Presentation", kind: "filter", description: "Reverses the order of the frames.", params: [] },
  { id: "freeze_frame", name: "Freeze Frame", category: "Presentation", kind: "filter", description: "Holds a frame for a number of frames.", params: [frame("frame", "Frame"), int("duration", "Duration (frames)", 1, 100000, 50, { slider: false })] },
];

export const FILTERS: Record<string, FilterDef> = Object.fromEntries(FILTER_LIST.map((f) => [f.id, f]));

export function filtersInCategory(cat: Category): FilterDef[] {
  return FILTER_LIST.filter((f) => f.category === cat);
}

export function defaultParams(def: FilterDef): ParamValues {
  const p: ParamValues = {};
  for (const d of def.params) {
    if (d.type === "action" || d.type === "psf" || d.type === "info" || d.type === "fileinfo") continue;
    const v = (d as any).default;
    p[d.key] = v === undefined ? null : structuredClone(v);
  }
  return p;
}

/** Fill missing params (projects saved by older versions): the legacy value when declared, else the default. */
export function normalizeParams(def: FilterDef, params: ParamValues): ParamValues {
  const out = defaultParams(def);
  for (const d of def.params) if (d.legacy !== undefined && !(params && d.key in params)) out[d.key] = structuredClone(d.legacy);
  for (const k of Object.keys(params || {})) out[k] = params[k];
  return out;
}

export function isOverlayParam(d: ParamDef): d is RectParam | PointParam | PointsParam | LineParam {
  return d.type === "rect" || d.type === "point" || d.type === "points" || d.type === "line";
}

/** Human readable rendering of a parameter value (used by the report and History tooltips). */
export function formatParam(d: ParamDef, v: any, chainName?: (id: string) => string): string {
  if (v === null || v === undefined || v === "") return "—";
  switch (d.type) {
    case "number": return Number(v).toFixed(d.decimals ?? 2);
    case "int": return String(Math.round(v));
    case "bool": return v ? "Yes" : "No";
    case "select": return d.options.find((o) => o[0] === v)?.[1] ?? String(v);
    case "rect": return `x=${Math.round(v.x)}, y=${Math.round(v.y)}, w=${Math.round(v.w)}, h=${Math.round(v.h)}`;
    case "point": return `(${v.x.toFixed(1)}, ${v.y.toFixed(1)})`;
    case "points": return (v as Pt[]).map((p) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`).join(" ") || "—";
    case "line": return `(${v[0].x.toFixed(1)}, ${v[0].y.toFixed(1)}) → (${v[1].x.toFixed(1)}, ${v[1].y.toFixed(1)})`;
    case "curve": return (v as Pt[]).map((p) => `${Math.round(p.x)}→${Math.round(p.y)}`).join(", ");
    case "chain": return chainName ? chainName(v) : String(v);
    case "chains": return (v as string[]).map((id) => (chainName ? chainName(id) : id)).join(", ") || "—";
    case "frame": return v === -1 ? "Last" : String(v);
    default: return String(v);
  }
}
