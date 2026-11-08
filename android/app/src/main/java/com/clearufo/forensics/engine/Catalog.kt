package com.clearufo.forensics.engine

// Filter catalog: metadata + parameter schemas shared by the UI and the engine. A port of the browser
// workbench's src/shared/filters.ts: same ids, parameter keys, defaults and ranges, so projects (.lfp)
// are interchangeable between the two applications.

enum class FilterKind { LOADER, FILTER, LINK, WRITER }

data class Category(val name: String, val description: String)

val CATEGORIES = listOf(
    Category("Load", "Loads image and video files."),
    Category("Link", "Combines the outputs of different chains."),
    Category("Write", "Writes the processed images and videos to file."),
    Category("Select Frames", "Selects a subset of the frames of the video."),
    Category("Deinterlacing", "Processes the interlaced videos."),
    Category("Edit", "Geometric transformations and corrections."),
    Category("Channels", "Color conversion and extraction functions."),
    Category("Adjust", "Brightness, contrast, levels and color adjustments."),
    Category("Extract", "Extracts information not visible in the original data."),
    Category("Verify", "Compares and verifies processing results."),
    Category("Measure", "Measures distances on images."),
    Category("Sharpen", "Enhances the details of the image."),
    Category("Denoise", "Reduces the noise of the image."),
    Category("Deblurring", "Corrects motion and optical blur."),
    Category("Stabilization", "Stabilizes the video on a region or globally."),
    Category("Integrate", "Combines information of several frames."),
    Category("Presentation", "Annotations and presentation tools."),
)

class FilterDef(
    val id: String, val name: String, val category: String, val kind: FilterKind, val description: String,
    val params: List<ParamDef>, val hint: String? = null,
    /** Where interactive overlays are drawn: on the filter input (geometry-changing filters) or on either view. */
    val overlayOn: String? = null,
    val temporal: Boolean = false, val slow: Boolean = false, val reference: String? = null,
    val tabs: List<String> = listOf("Settings"),
)

// ---------------------------------------------------------------- helpers (as in filters.ts)
private fun <T : ParamDef> T.opts(tab: String? = null, help: String? = null, show: ((Params) -> Boolean)? = null, overlayIf: ((Params) -> Boolean)? = null, legacy: Any? = null): T {
    this.tab = tab; this.help = help; this.show = show; this.overlayIf = overlayIf; this.legacy = legacy; return this
}
private fun num(key: String, label: String, min: Double, max: Double, def: Double, decimals: Int = 2, slider: Boolean = true, log: Boolean = false, step: Double? = null, show: ((Params) -> Boolean)? = null, help: String? = null, tab: String? = null) =
    NumberParam(key, label, min, max, def, false, decimals, step, slider, log).opts(tab = tab, show = show, help = help)
private fun int(key: String, label: String, min: Int, max: Int, def: Int, slider: Boolean = true, step: Double = 1.0, show: ((Params) -> Boolean)? = null, help: String? = null, tab: String? = null) =
    NumberParam(key, label, min.toDouble(), max.toDouble(), def.toDouble(), true, 0, step, slider).opts(tab = tab, show = show, help = help)
private fun sel(key: String, label: String, options: List<Pair<String, String>>, def: String, show: ((Params) -> Boolean)? = null, help: String? = null, tab: String? = null, legacy: Any? = null) =
    SelectParam(key, label, options, def).opts(tab = tab, show = show, help = help, legacy = legacy)
private fun bool(key: String, label: String, def: Boolean, show: ((Params) -> Boolean)? = null, help: String? = null) = BoolParam(key, label, def).opts(show = show, help = help)
private fun color(key: String, label: String, def: String, show: ((Params) -> Boolean)? = null) = ColorParam(key, label, def).opts(show = show)
private fun text(key: String, label: String, def: String, multiline: Boolean = false, show: ((Params) -> Boolean)? = null) = TextParam(key, label, def, multiline).opts(show = show)
private fun rect(key: String, label: String, tab: String? = null, show: ((Params) -> Boolean)? = null) = RectParam(key, label).opts(tab = tab, show = show)
private fun point(key: String, label: String, def: Pt?, show: ((Params) -> Boolean)? = null) = PointParam(key, label, def).opts(show = show)
private fun points(key: String, label: String, minPoints: Int = 0, maxPoints: Int = 1000, closed: Boolean = false, polyline: Boolean = false, show: ((Params) -> Boolean)? = null, overlayIf: ((Params) -> Boolean)? = null) =
    PointsParam(key, label, minPoints, maxPoints, closed, polyline).opts(show = show, overlayIf = overlayIf)
private fun line(key: String, label: String, tab: String? = null, show: ((Params) -> Boolean)? = null) = LineParam(key, label).opts(tab = tab, show = show)
private fun frame(key: String, label: String, def: Int = 0, allowLast: Boolean = false, tab: String? = null) = FrameParam(key, label, def.toDouble(), allowLast).opts(tab = tab)
private fun chain(key: String, label: String) = ChainParam(key, label)
private fun chains(key: String, label: String) = ChainsParam(key, label)
private fun action(key: String, label: String, act: String) = ActionParam(key, label, act)
private fun psf() = PsfParam("_psf", "Point Spread Function")
private fun fileInfo() = FileInfoParam("_info", "Original File").opts(tab = "Original File")
private fun o(vararg p: Pair<String, String>) = p.toList()

private val INTERP = o("nearest" to "Nearest Neighbor", "bilinear" to "Bilinear", "bicubic" to "Bicubic", "lanczos" to "Lanczos-3")
private val DECONV = o("wiener" to "Wiener Filter", "rl" to "Richardson-Lucy", "tikhonov" to "Tikhonov (Regularized)")
private val CORNERS = o("tl" to "Top Left", "tr" to "Top Right", "bl" to "Bottom Left", "br" to "Bottom Right")
private val FIELD = o("top" to "Top (Even)", "bottom" to "Bottom (Odd)")

private object REF {
    const val gw = "R.C. Gonzalez, R.E. Woods, \"Digital Image Processing\", 4th ed., Pearson, 2018."
    const val wiener = "N. Wiener, \"Extrapolation, Interpolation, and Smoothing of Stationary Time Series\", MIT Press, 1949; R.C. Gonzalez, R.E. Woods, \"Digital Image Processing\", ch. 5."
    const val rl = "W.H. Richardson, \"Bayesian-Based Iterative Method of Image Restoration\", JOSA 62(1), 1972; L.B. Lucy, \"An iterative technique for the rectification of observed distributions\", Astronomical Journal 79, 1974."
    const val fft = "J.W. Cooley, J.W. Tukey, \"An algorithm for the machine calculation of complex Fourier series\", Mathematics of Computation 19, 1965."
    const val keys = "R. Keys, \"Cubic convolution interpolation for digital image processing\", IEEE Trans. ASSP 29(6), 1981; C.E. Duchon, \"Lanczos filtering in one and two dimensions\", J. Applied Meteorology 18, 1979."
    const val hz = "R. Hartley, A. Zisserman, \"Multiple View Geometry in Computer Vision\", 2nd ed., Cambridge University Press, 2004."
    const val brown = "D.C. Brown, \"Decentering distortion of lenses\", Photogrammetric Engineering 32(3), 1966."
    const val bt = "ITU-R Recommendation BT.601-7 (2011) and BT.709-6 (2015); CIE 15:2004 Colorimetry."
    const val clahe = "K. Zuiderveld, \"Contrast Limited Adaptive Histogram Equalization\", Graphics Gems IV, Academic Press, 1994."
    const val grayworld = "G. Buchsbaum, \"A spatial processor model for object colour perception\", Journal of the Franklin Institute 310(1), 1980."
    const val sobel = "I. Sobel, G. Feldman, \"A 3x3 isotropic gradient operator for image processing\", Stanford AI Project, 1968; H. Scharr, PhD thesis, Heidelberg University, 2000."
    const val ela = "N. Krawetz, \"A Picture's Worth: Digital Image Analysis and Forensics\", Black Hat Briefings, 2007."
    const val metrology = "A. Criminisi, I. Reid, A. Zisserman, \"Single View Metrology\", International Journal of Computer Vision 40(2), 2000."
    const val bilateral = "C. Tomasi, R. Manduchi, \"Bilateral filtering for gray and color images\", Proc. ICCV, 1998."
    const val nlm = "A. Buades, B. Coll, J.-M. Morel, \"A non-local algorithm for image denoising\", Proc. CVPR, 2005."
    const val median = "T.S. Huang, G.J. Yang, G.Y. Tang, \"A fast two-dimensional median filtering algorithm\", IEEE Trans. ASSP 27(1), 1979."
    const val lim = "J.S. Lim, \"Two-Dimensional Signal and Image Processing\", Prentice Hall, 1990, p. 548 (adaptive Wiener filter)."
    const val deblock = "P. List, A. Joch, J. Lainema, G. Bjontegaard, M. Karczewicz, \"Adaptive deblocking filter\", IEEE Trans. CSVT 13(7), 2003."
    const val ncc = "J.P. Lewis, \"Fast Normalized Cross-Correlation\", Vision Interface, 1995."
    const val phase = "C.D. Kuglin, D.C. Hines, \"The phase correlation image alignment method\", Proc. IEEE Conf. Cybernetics and Society, 1975."
    const val sr = "M. Irani, S. Peleg, \"Improving resolution by image registration\", CVGIP: Graphical Models and Image Processing 53(3), 1991; S. Farsiu et al., \"Fast and robust multiframe super resolution\", IEEE Trans. Image Processing 13(10), 2004."
    const val deint = "G. de Haan, E.B. Bellers, \"Deinterlacing — An overview\", Proceedings of the IEEE 86(9), 1998."
    const val sigma = "P.J. Huber, \"Robust Statistics\", Wiley, 1981 (sigma-clipped mean)."
    const val tnr = "J.C. Brailean, R.P. Kleihorst, S. Efstratiadis, A.K. Katsaggelos, R.L. Lagendijk, \"Noise reduction filters for dynamic image sequences: a review\", Proceedings of the IEEE 83(9), 1995."
}

private fun mode(p: Params) = p.str("mode")
private fun isLossyFormat(f: String) = WriteFormats.of(f)?.lossy ?: true

val FILTER_LIST: List<FilterDef> = listOf(
    // ============================== Load
    FilterDef("image_loader", "Image Loader", "Load", FilterKind.LOADER, "Loads an image from file.",
        listOf(SourceParam("source", "File"), fileInfo()),
        hint = "Hint: supported formats include PNG (8 and 16-bit, decoded exactly), JPEG, BMP, GIF, WebP, HEIF/AVIF and TIFF. EXIF metadata is shown in the Original File tab.",
        tabs = listOf("Parameters", "Original File")),
    FilterDef("video_loader", "Video Loader", "Load", FilterKind.LOADER, "Loads image and video files.",
        listOf(
            SourceParam("source", "File"),
            sel("engine", "Video Engine", o("webcodecs" to "MediaCodec + exact YUV conversion (frame accurate)", "media" to "Platform frame retriever"), "webcodecs",
                help = "MediaCodec decodes the stream on the phone's hardware decoder; ClearUFO converts the decoded YUV planes itself (matrix, range and chroma below) and indexes every frame by its timestamp. The platform retriever is a fallback for files MediaCodec cannot handle."),
            sel("colorRange", "Color Range", o("auto" to "From File", "limited" to "Limited", "full" to "Full"), "auto"),
            sel("matrix", "Color Matrix", o("auto" to "From File", "bt601" to "BT.601", "bt709" to "BT.709", "bt2020" to "BT.2020"), "auto"),
            sel("chroma", "Chroma Filter", o("bicubic" to "Bicubic (highest quality)", "bilinear" to "Bilinear", "nearest" to "Nearest (replicate samples)"), "bicubic", legacy = "nearest",
                help = "Most video stores color at half resolution (4:2:0). Bicubic rebuilds full-resolution color from the correctly sited samples; Nearest repeats each color sample over its 2×2 pixel block."),
            sel("siting", "Chroma Siting", o("auto" to "From File", "left" to "Left (MPEG-2, H.264, HEVC)", "center" to "Center (JPEG, MPEG-1)", "topleft" to "Top-left (co-sited)"), "auto",
                show = { it.str("chroma") != "nearest" }, help = "Where the color samples sit on the pixel grid."),
            sel("hdr", "HDR Video", o("tonemap" to "Tone map to SDR (BT.2390)", "none" to "Signal values as decoded"), "tonemap", legacy = "none",
                help = "HDR video (PQ / HDR10, or HLG) holds brightness and colors an ordinary display cannot show. Tone map converts it like a phone or TV does; \"Signal values as decoded\" keeps the raw code values for measurement."),
            num("hdrPeak", "HDR Peak (cd/m²)", 200.0, 10000.0, 1000.0, decimals = 0, step = 50.0, slider = false, show = { it.str("hdr") != "none" }),
            fileInfo(),
        ),
        hint = "Hint: if a video does not seek correctly, try the other Video Engine or convert it to MP4.",
        tabs = listOf("Parameters", "Original File")),
    FilterDef("sequence_loader", "Sequence Loader", "Load", FilterKind.LOADER, "Loads a sequence of images as a video.",
        listOf(SourceParam("source", "Files"), num("fps", "Frame Rate", 0.1, 240.0, 25.0, decimals = 3, slider = false), fileInfo()),
        hint = "Hint: images are sorted by file name using natural ordering (img2 before img10).", tabs = listOf("Parameters", "Original File")),
    FilterDef("test_pattern", "Test Pattern", "Load", FilterKind.LOADER, "Generates synthetic test material to validate the processing.",
        listOf(
            sel("pattern", "Pattern", o("plate" to "License Plate (degraded)", "bars" to "Color Bars", "chart" to "Resolution Chart", "zone" to "Zone Plate", "grid" to "Calibration Grid", "periodic" to "Periodic Noise"), "plate"),
            int("width", "Width", 64, 3840, 640, slider = false), int("height", "Height", 64, 2160, 360, slider = false),
            int("frames", "Frames", 1, 10000, 60, slider = false), num("fps", "Frame Rate", 1.0, 120.0, 25.0, slider = false),
            num("blur", "Motion Blur", 0.0, 40.0, 9.0, decimals = 1), num("blurAngle", "Blur Angle", -90.0, 90.0, 12.0, decimals = 0),
            num("noise", "Noise", 0.0, 60.0, 10.0, decimals = 1), num("shake", "Camera Shake", 0.0, 30.0, 4.0, decimals = 1),
            int("seed", "Seed", 0, 9999, 7, slider = false),
        ),
        hint = "Hint: the license plate pattern simulates motion blur, noise and camera shake; use it to test stabilization, frame averaging and deblurring."),
    // ============================== Link
    FilterDef("video_mixer", "Video Mixer", "Link", FilterKind.LINK, "Mixes the current chain with another chain.",
        listOf(
            chain("second", "Second Input"),
            sel("mode", "Mode", o("blend" to "Blend", "difference" to "Difference", "absdiff" to "Absolute Difference", "sbs_h" to "Side-by-Side Horizontally", "sbs_v" to "Side-by-Side Vertically", "wipe_h" to "Wipe Horizontal", "wipe_v" to "Wipe Vertical", "checker" to "Checkerboard"), "blend"),
            num("balance", "Balance", 0.0, 1.0, 0.5, decimals = 4), num("gain", "Gain", 1.0, 20.0, 1.0, decimals = 1),
            int("offset", "Frame Offset", -1000, 1000, 0, slider = false), int("checker", "Checker Size", 4, 256, 32, show = { mode(it) == "checker" }),
            sel("sync", "Synchronize", o("frame" to "By frame number", "time" to "By time (timestamps)"), "frame", legacy = "frame",
                help = "By frame number (default, as the browser version), frame N of this chain is shown with frame N of the other chain, plus the offset. By time, each frame is matched with the frame of the other chain shown at the same moment, so videos with different or variable frame rates stay in step; the offset is in frames of this chain."),
        ), hint = "Hint: use \"Difference\" to highlight changes between two versions of the same video."),
    FilterDef("multiview", "Multiview", "Link", FilterKind.LINK, "Shows several chains at the same time in a grid.",
        listOf(chains("chains", "Chains"), int("columns", "Columns (0 = auto)", 0, 8, 0), bool("labels", "Show Labels", true), int("border", "Border", 0, 20, 2), color("borderColor", "Border Color", "#202020"),
            sel("sync", "Synchronize", o("frame" to "By frame number", "time" to "By time (timestamps)"), "frame", legacy = "frame",
                help = "By frame number (default, as the browser version), frame N of this chain is shown with frame N of the other chain, plus the offset. By time, each frame is matched with the frame of the other chain shown at the same moment, so videos with different or variable frame rates stay in step; the offset is in frames of this chain."))),
    FilterDef("picture_in_picture", "Picture In Picture", "Link", FilterKind.LINK, "Inserts the output of another chain as an inset.",
        listOf(chain("inset", "Inset Chain"), num("x", "Position X (%)", 0.0, 100.0, 70.0, decimals = 1), num("y", "Position Y (%)", 0.0, 100.0, 5.0, decimals = 1), num("scale", "Scale (%)", 5.0, 100.0, 25.0, decimals = 1), int("border", "Border", 0, 20, 2), color("borderColor", "Border Color", "#ffffff"), int("offset", "Frame Offset", -1000, 1000, 0, slider = false),
            sel("sync", "Synchronize", o("frame" to "By frame number", "time" to "By time (timestamps)"), "frame", legacy = "frame",
                help = "By frame number (default, as the browser version), frame N of this chain is shown with frame N of the other chain, plus the offset. By time, each frame is matched with the frame of the other chain shown at the same moment, so videos with different or variable frame rates stay in step; the offset is in frames of this chain."))),
    FilterDef("timeline", "Timeline", "Link", FilterKind.LINK, "Concatenates other chains after the current one.", listOf(chains("chains", "Append Chains"),
            sel("sync", "Timing", o("frame" to "Frame by frame", "time" to "Resample to this chain's frame rate"), "frame", legacy = "frame",
                help = "Frame by frame (default, as the browser version) keeps every frame of the appended chains; resampling plays them at their real speed when their frame rate differs.")),
        hint = "Hint: frames of the appended chains are resized to the size of the current chain."),
    // ============================== Write
    FilterDef("video_writer", "Video Writer", "Write", FilterKind.WRITER, "Writes the processed video to file.",
        listOf(
            sel("format", "Format", WriteFormats.VIDEO_EXPORT.map { it to WriteFormats.label(it, true) }, "avi-raw"),
            num("quality", "Quality (lossy only)", 0.1, 1.0, 1.0, show = { isLossyFormat(it.str("format")) }),
            num("fps", "Frame Rate (0 = input)", 0.0, 240.0, 0.0, slider = false, decimals = 3),
            sel("range", "Frames", o("all" to "All Frames", "inout" to "Player In/Out Range"), "all"),
            text("name", "File Name", "output"), action("_write", "Write Video", "write"),
        ), hint = "Hint: AVI (uncompressed) stores every frame exactly, 8 bits per channel. TIFF and PNG sequences keep 16 bits per channel or 32-bit float, numbered files in one ZIP archive without compression."),
    FilterDef("image_writer", "Image Writer", "Write", FilterKind.WRITER, "Writes the processed frames as images.",
        listOf(
            sel("format", "Format", WriteFormats.IMAGE_EXPORT.map { it to WriteFormats.label(it, false) }, "tiff16"),
            num("quality", "Quality (lossy only)", 0.1, 1.0, 0.95, show = { isLossyFormat(it.str("format")) }),
            sel("range", "Frames", o("current" to "Current Frame", "all" to "All Frames", "inout" to "Player In/Out Range"), "current"),
            text("name", "File Name", "frame"), action("_write", "Write Images", "write"),
        ), hint = "Hint: TIFF and PNG are written uncompressed. 16-bit keeps the fractional values the filters compute (8-bit levels map exactly: level × 257); 32-bit float keeps the full processing precision."),
    // ============================== Select Frames
    FilterDef("single_selector", "Single Selector", "Select Frames", FilterKind.FILTER, "Selects a single frame of the video.", listOf(frame("frame", "Frame"))),
    FilterDef("range_selector", "Range Selector", "Select Frames", FilterKind.FILTER, "Selects a range of frames of the video.",
        listOf(frame("start", "First Frame", 0), frame("end", "Last Frame (-1 = end)", -1, allowLast = true), int("step", "Step", 1, 1000, 1, slider = false)),
        hint = "Hint: use the In/Out markers of the player or the \"Current\" buttons to set the range."),
    FilterDef("sparse_selector", "Sparse Selector", "Select Frames", FilterKind.FILTER, "Selects a list of frames of the video.",
        listOf(text("frames", "Frames", "0"), action("_add", "Add Current Frame", "addCurrentFrame")), hint = "Hint: comma separated list of frames and ranges, e.g. 0, 12, 30-45."),
    FilterDef("remove_duplicates", "Remove Duplicates", "Select Frames", FilterKind.FILTER, "Removes duplicated frames (typical of CCTV recordings at variable frame rate).",
        listOf(num("threshold", "Threshold", 0.0, 50.0, 0.5), rect("roi", "Region (optional)")), temporal = true, overlayOn = "any",
        hint = "Hint: the difference is the mean absolute difference per pixel (0-255) with the last kept frame."),
    FilterDef("iframes_selector", "Frame Type Selector", "Select Frames", FilterKind.FILTER, "Selects frames by their compression type (I, P, B).",
        listOf(bool("keepI", "I Frames", true), bool("keepP", "P Frames", false), bool("keepB", "B Frames", false)),
        hint = "Hint: I-frames are intra coded and typically have the best quality in a group of pictures."),
    FilterDef("demultiplexer", "Demultiplexer", "Select Frames", FilterKind.FILTER, "Automatically selects similar frames (to discard bad frames or separate multiplexed cameras) with the ability to set a similarity threshold and a reference frame.",
        listOf(frame("reference", "Reference Frame"), num("threshold", "Similarity Threshold", 0.0, 100.0, 75.0, decimals = 1), rect("roi", "Region (optional)")), temporal = true, overlayOn = "any"),
    FilterDef("motion_detection", "Motion Detection", "Select Frames", FilterKind.FILTER, "Selects the frames with motion in a region.",
        listOf(rect("roi", "Region"), num("threshold", "Pixel Threshold", 1.0, 128.0, 20.0, decimals = 0), num("minArea", "Minimum Area (%)", 0.0, 100.0, 0.5), sel("mode", "Keep", o("motion" to "Frames With Motion", "still" to "Frames Without Motion"), "motion")),
        temporal = true, overlayOn = "any"),
    // ============================== Deinterlacing
    FilterDef("deinterlace", "Deinterlace", "Deinterlacing", FilterKind.FILTER, "Removes the interlacing artifacts.",
        listOf(sel("field", "Field", FIELD, "top"), sel("method", "Method", o("linear" to "Linear Interpolation", "duplicate" to "Line Duplication", "blend" to "Field Blending", "bob" to "Bob (Double Frame Rate)"), "linear")), reference = REF.deint),
    FilterDef("line_doubling", "Line Doubling", "Deinterlacing", FilterKind.FILTER, "Keeps one field and doubles its lines.", listOf(sel("field", "Field", FIELD, "top")), reference = REF.deint),
    FilterDef("field_separation", "Field Separation", "Deinterlacing", FilterKind.FILTER, "Separates the two fields of each frame.", listOf(sel("mode", "Mode", o("stack" to "Stacked (Top/Bottom)", "sequence" to "Sequence (Double Frames)"), "stack"))),
    FilterDef("field_shift", "Field Shift", "Deinterlacing", FilterKind.FILTER, "Shifts one field to correct misaligned interlaced recordings.", listOf(sel("field", "Field", FIELD, "bottom"), int("dx", "Shift X", -64, 64, 0), int("dy", "Shift Y", -8, 8, 0))),
    FilterDef("interleave", "Interleave", "Deinterlacing", FilterKind.FILTER, "Interleaves pairs of consecutive frames as the two fields of a frame.", listOf(sel("first", "First Frame As", o("top" to "Top Field", "bottom" to "Bottom Field"), "top"))),
    // ============================== Edit
    FilterDef("crop", "Crop", "Edit", FilterKind.FILTER, "Crops a region of the image.", listOf(rect("rect", "Region")), overlayOn = "input",
        hint = "Hint: draw the region on the Viewer (the input is shown while editing)."),
    FilterDef("resize", "Resize", "Edit", FilterKind.FILTER, "Changes the size of the image.",
        listOf(
            sel("mode", "Mode", o("scale" to "Scale Factor", "size" to "Absolute Size"), "scale"),
            num("scale", "Scale (%)", 1.0, 1600.0, 200.0, decimals = 1, show = { mode(it) == "scale" }),
            int("width", "Width", 1, 16384, 1280, slider = false, show = { mode(it) == "size" }),
            int("height", "Height", 1, 16384, 720, slider = false, show = { mode(it) == "size" }),
            bool("keepAspect", "Keep Aspect Ratio", true, show = { mode(it) == "size" }),
            sel("interp", "Interpolation", INTERP, "bicubic"),
        ), reference = REF.keys),
    FilterDef("rotate", "Rotate", "Edit", FilterKind.FILTER, "Rotates the image.",
        listOf(num("angle", "Angle", -180.0, 180.0, 0.0), sel("interp", "Interpolation", INTERP.take(3), "bicubic"), bool("expand", "Expand Canvas", true), color("background", "Background", "#000000")), reference = REF.keys),
    FilterDef("flip", "Flip", "Edit", FilterKind.FILTER, "Flips the image horizontally or vertically.", listOf(bool("horizontal", "Horizontal", true), bool("vertical", "Vertical", false))),
    FilterDef("correct_perspective", "Correct Perspective", "Edit", FilterKind.FILTER, "Rectifies a planar surface seen in perspective (e.g. a license plate or a document).",
        listOf(points("points", "Corners", 4, 4, closed = true), int("outWidth", "Output Width (0 = auto)", 0, 8192, 0, slider = false), int("outHeight", "Output Height (0 = auto)", 0, 8192, 0, slider = false), sel("interp", "Interpolation", INTERP.take(3), "bicubic")),
        overlayOn = "input", reference = REF.hz, hint = "Hint: tap the four corners of the plane in clockwise order starting from the top left (the input is shown while editing)."),
    FilterDef("lens_distortion", "Correct Lens Distortion", "Edit", FilterKind.FILTER, "Corrects the radial (barrel or pincushion) distortion of wide angle lenses.",
        listOf(num("k1", "Radial k1", -1.0, 1.0, 0.0, decimals = 4), num("k2", "Radial k2", -1.0, 1.0, 0.0, decimals = 4), num("cx", "Center X", 0.0, 1.0, 0.5, decimals = 3), num("cy", "Center Y", 0.0, 1.0, 0.5, decimals = 3), num("zoom", "Zoom", 0.2, 3.0, 1.0, decimals = 3), sel("interp", "Interpolation", INTERP.take(3), "bicubic")), reference = REF.brown),
    FilterDef("aspect_ratio", "Correct Aspect Ratio", "Edit", FilterKind.FILTER, "Corrects non-square pixels (e.g. 704x576 PAL or 720x480 NTSC recordings).",
        listOf(sel("mode", "Pixel Aspect Ratio", o("source" to "From Source", "custom" to "Custom", "pal" to "PAL 4:3 (12:11)", "ntsc" to "NTSC 4:3 (10:11)", "half" to "Half Height CIF (2:1)"), "source"),
            num("par", "Custom PAR", 0.25, 4.0, 1.0, decimals = 4, show = { mode(it) == "custom" }), sel("direction", "Adjust", o("width" to "Width", "height" to "Height"), "width"), sel("interp", "Interpolation", INTERP, "bicubic")), reference = REF.keys),
    // ============================== Channels
    FilterDef("grayscale", "Grayscale Conversion", "Channels", FilterKind.FILTER, "Converts the image to grayscale.",
        listOf(sel("method", "Method", o("bt601" to "Luma BT.601", "bt709" to "Luma BT.709", "average" to "Average", "lightness" to "Lightness", "max" to "Maximum", "min" to "Minimum"), "bt601")), reference = REF.bt),
    FilterDef("color_conversion", "Color Conversion", "Channels", FilterKind.FILTER, "Converts the image to another color space and shows its channels as RGB.",
        listOf(sel("space", "Color Space", o("ycbcr601" to "YCbCr (BT.601)", "ycbcr709" to "YCbCr (BT.709)", "hsv" to "HSV", "hsl" to "HSL", "lab" to "CIE L*a*b*", "cmy" to "CMY", "xyz" to "CIE XYZ"), "ycbcr601")), reference = REF.bt),
    FilterDef("color_switch", "Color Switch", "Channels", FilterKind.FILTER, "Swaps the color channels.",
        listOf("r", "g", "b").map { c -> sel(c, "${c.uppercase()} Output", o("r" to "Red", "g" to "Green", "b" to "Blue", "zero" to "Zero", "full" to "Full"), if (c == "r") "b" else if (c == "b") "r" else "g") }),
    FilterDef("extract_channel", "Extract Channel", "Channels", FilterKind.FILTER, "Extracts a single channel as a grayscale image.",
        listOf(sel("channel", "Channel", o("r" to "Red", "g" to "Green", "b" to "Blue", "y" to "Luma (Y)", "cb" to "Chroma Blue (Cb)", "cr" to "Chroma Red (Cr)", "h" to "Hue", "s" to "Saturation", "v" to "Value", "l" to "Lightness L*", "a" to "a*", "bb" to "b*", "c" to "Cyan", "m" to "Magenta", "ye" to "Yellow", "k" to "Black (K)"), "y"), bool("stretch", "Stretch Values", false)), reference = REF.bt),
    FilterDef("enable_channels", "Enable Channels", "Channels", FilterKind.FILTER, "Enables or disables the single channels.", listOf(bool("r", "Red", true), bool("g", "Green", true), bool("b", "Blue", true))),
    FilterDef("replace_channel", "Replace Channel", "Channels", FilterKind.LINK, "Replaces a channel with a channel of another chain.",
        listOf(sel("target", "Target Channel", o("r" to "Red", "g" to "Green", "b" to "Blue"), "r"), chain("source", "Source Chain"), sel("sourceChannel", "Source Channel", o("r" to "Red", "g" to "Green", "b" to "Blue", "y" to "Luma"), "y"),
            sel("sync", "Synchronize", o("frame" to "By frame number", "time" to "By time (timestamps)"), "frame", legacy = "frame",
                help = "By frame number (default, as the browser version), frame N of this chain is shown with frame N of the other chain, plus the offset. By time, each frame is matched with the frame of the other chain shown at the same moment, so videos with different or variable frame rates stay in step; the offset is in frames of this chain."))),
    // ============================== Adjust
    FilterDef("levels", "Levels", "Adjust", FilterKind.FILTER, "Adjusts the input and output levels of the image.",
        listOf(sel("channel", "Channel", o("all" to "All", "r" to "Red", "g" to "Green", "b" to "Blue"), "all"), num("inBlack", "Input Black", 0.0, 255.0, 0.0, decimals = 1), num("inWhite", "Input White", 0.0, 255.0, 255.0, decimals = 1),
            num("gamma", "Gamma", 0.1, 10.0, 1.0, decimals = 3, log = true), num("outBlack", "Output Black", 0.0, 255.0, 0.0, decimals = 1), num("outWhite", "Output White", 0.0, 255.0, 255.0, decimals = 1), action("_auto", "Auto Levels", "autoLevels")), reference = REF.gw),
    FilterDef("curves", "Curves", "Adjust", FilterKind.FILTER, "Adjusts the tonal range with a curve.",
        listOf(sel("channel", "Channel", o("all" to "All", "r" to "Red", "g" to "Green", "b" to "Blue"), "all"), CurveParam("curve", "Curve", listOf(Pt(0.0, 0.0), Pt(255.0, 255.0)))),
        reference = REF.gw, hint = "Hint: tap to add points, drag to move them, double-tap a point to remove it."),
    FilterDef("brightness_contrast", "Brightness/Contrast", "Adjust", FilterKind.FILTER, "Adjusts the brightness and the contrast.", listOf(num("brightness", "Brightness", -255.0, 255.0, 0.0, decimals = 1), num("contrast", "Contrast", -100.0, 100.0, 0.0, decimals = 1))),
    FilterDef("exposure", "Exposure/Gamma", "Adjust", FilterKind.FILTER, "Adjusts exposure, gamma and offset.", listOf(num("exposure", "Exposure (stops)", -5.0, 5.0, 0.0), num("gamma", "Gamma", 0.1, 5.0, 1.0, decimals = 3, log = true), num("offset", "Offset", -128.0, 128.0, 0.0, decimals = 1))),
    FilterDef("auto_contrast", "Auto Contrast", "Adjust", FilterKind.FILTER, "Stretches the histogram automatically for each frame.", listOf(num("clipLow", "Clip Shadows (%)", 0.0, 20.0, 0.5), num("clipHigh", "Clip Highlights (%)", 0.0, 20.0, 0.5), bool("linked", "Link Channels", true)), reference = REF.gw),
    FilterDef("histogram_equalization", "Histogram Equalization", "Adjust", FilterKind.FILTER, "Equalizes the histogram globally or locally (CLAHE).",
        listOf(sel("mode", "Mode", o("global" to "Global", "clahe" to "Local (CLAHE)"), "clahe"), int("tiles", "Tiles", 2, 32, 8, show = { mode(it) == "clahe" }), num("clip", "Clip Limit", 1.0, 20.0, 3.0, decimals = 1, show = { mode(it) == "clahe" }),
            sel("target", "Apply To", o("luma" to "Luminance", "rgb" to "RGB Channels"), "luma"), num("amount", "Amount", 0.0, 1.0, 1.0)), reference = REF.clahe),
    FilterDef("white_balance", "Color Balance", "Adjust", FilterKind.FILTER, "Corrects color casts manually, automatically or from a neutral reference.",
        listOf(sel("mode", "Mode", o("manual" to "Manual Gains", "grayworld" to "Gray World", "whitepatch" to "White Patch", "point" to "Neutral Reference Point"), "grayworld"),
            num("r", "Red Gain", 0.0, 4.0, 1.0, decimals = 3, show = { mode(it) == "manual" }), num("g", "Green Gain", 0.0, 4.0, 1.0, decimals = 3, show = { mode(it) == "manual" }), num("b", "Blue Gain", 0.0, 4.0, 1.0, decimals = 3, show = { mode(it) == "manual" }),
            point("point", "Reference Point", null, show = { mode(it) == "point" }), int("radius", "Sample Radius", 0, 20, 3, show = { mode(it) == "point" })), reference = REF.grayworld, overlayOn = "any"),
    FilterDef("hue_saturation", "Hue/Saturation", "Adjust", FilterKind.FILTER, "Adjusts hue, saturation and lightness.", listOf(num("hue", "Hue", -180.0, 180.0, 0.0, decimals = 1), num("saturation", "Saturation", -100.0, 100.0, 0.0, decimals = 1), num("lightness", "Lightness", -100.0, 100.0, 0.0, decimals = 1))),
    FilterDef("negative", "Negative", "Adjust", FilterKind.FILTER, "Inverts the values of the image.", emptyList()),
    FilterDef("threshold", "Threshold", "Adjust", FilterKind.FILTER, "Converts the image to black and white.", listOf(num("level", "Level", 0.0, 255.0, 128.0, decimals = 1), sel("mode", "Mode", o("luma" to "Luminance", "rgb" to "Each Channel"), "luma"))),
    // ============================== Extract
    FilterDef("fourier", "Fourier", "Extract", FilterKind.FILTER, "Shows the Fourier spectrum of the image.",
        listOf(sel("mode", "Show", o("magnitude" to "Magnitude", "phase" to "Phase"), "magnitude"), bool("log", "Logarithmic", true), sel("channel", "Channel", o("y" to "Luminance", "r" to "Red", "g" to "Green", "b" to "Blue"), "y")), reference = REF.fft),
    FilterDef("fourier_filter", "Fourier Filter", "Extract", FilterKind.FILTER, "Removes periodic noise or applies low/high pass filters in the frequency domain.",
        listOf(sel("view", "View", o("filtered" to "Filtered Image", "spectrum" to "Spectrum"), "spectrum"), sel("filter", "Filter", o("notch" to "Notch Reject", "lowpass" to "Low Pass", "highpass" to "High Pass"), "notch"),
            points("points", "Notches", show = { it.str("filter") == "notch" }, overlayIf = { it.str("view") == "spectrum" }), num("radius", "Notch Radius", 1.0, 64.0, 8.0, decimals = 1, show = { it.str("filter") == "notch" }),
            bool("symmetric", "Symmetric Notches", true, show = { it.str("filter") == "notch" }), num("cutoff", "Cutoff", 0.005, 0.5, 0.1, decimals = 3, show = { it.str("filter") != "notch" }), bool("smooth", "Smooth Transition", true)),
        reference = REF.fft, overlayOn = "any", hint = "Hint: select \"View: Spectrum\" and tap the bright peaks of the periodic noise, then switch back to \"Filtered\"."),
    FilterDef("gradient", "Edge Detection", "Extract", FilterKind.FILTER, "Computes the gradient (edges) of the image.",
        listOf(sel("operator", "Operator", o("sobel" to "Sobel", "prewitt" to "Prewitt", "scharr" to "Scharr", "laplacian" to "Laplacian"), "sobel"), sel("output", "Output", o("magnitude" to "Magnitude", "x" to "Horizontal", "y" to "Vertical", "direction" to "Direction (Color)"), "magnitude"), num("gain", "Gain", 0.1, 20.0, 1.0)), reference = REF.sobel),
    FilterDef("frame_difference", "Frame Difference", "Extract", FilterKind.FILTER, "Shows the difference between each frame and a previous one.",
        listOf(int("offset", "Frame Offset", 1, 100, 1), num("gain", "Gain", 1.0, 20.0, 4.0, decimals = 1), sel("mode", "Mode", o("abs" to "Absolute", "signed" to "Signed (Gray = 0)"), "abs")), temporal = true),
    FilterDef("bit_plane", "Bit Plane", "Extract", FilterKind.FILTER, "Shows a single bit plane of a channel (hidden information, compression traces).",
        listOf(sel("channel", "Channel", o("r" to "Red", "g" to "Green", "b" to "Blue", "y" to "Luma"), "y"), int("bit", "Bit", 0, 7, 0)), reference = REF.gw),
    // ============================== Verify
    FilterDef("compare_original", "Compare Original", "Verify", FilterKind.FILTER, "Compares the processed image with the original.",
        listOf(sel("mode", "Mode", o("sbs_h" to "Side-by-Side Horizontally", "sbs_v" to "Side-by-Side Vertically", "blend" to "Blend", "wipe_h" to "Wipe Horizontal", "wipe_v" to "Wipe Vertical", "difference" to "Difference"), "sbs_h"),
            num("balance", "Balance", 0.0, 1.0, 0.5, decimals = 4), num("gain", "Gain", 1.0, 5.0, 1.0), color("lineColor", "Line Color", "#c0c0c0"), int("lineThickness", "Line Thickness", 0, 20, 0), bool("originalFirst", "Original First (Left/Top)", true)),
        hint = "Hint: for more advanced comparison functions, use the \"Video Mixer\" filter."),
    FilterDef("ela", "Error Level Analysis", "Verify", FilterKind.FILTER, "Highlights areas with a different JPEG compression level.",
        listOf(int("quality", "JPEG Quality", 50, 100, 90), sel("chroma", "Chroma Subsampling", o("420" to "4:2:0 (most cameras)", "444" to "4:4:4 (none)"), "420"), num("scale", "Scale", 1.0, 60.0, 15.0, decimals = 1)),
        reference = REF.ela, hint = "The image is re-compressed with a built-in JPEG model (IJG tables) instead of the platform encoder, so the result is identical on every device."),
    // ============================== Measure
    FilterDef("measure_1d", "Measure 1D", "Measure", FilterKind.FILTER, "Measures a length using a reference of known length on the same line.",
        listOf(line("refLine", "Reference Segment"), num("refLength", "Reference Length", 0.001, 100000.0, 1.0, slider = false, decimals = 3), text("unit", "Unit", "m"), line("line", "Measured Segment"), color("color", "Color", "#ffd400"), int("size", "Label Size", 8, 72, 16)),
        reference = REF.metrology, overlayOn = "any", hint = "Hint: draw the reference segment, enter its real length, then draw the segment to measure. Valid only for objects on the same plane and direction."),
    FilterDef("measure_2d", "Measure 2D", "Measure", FilterKind.FILTER, "Measures distances on a plane calibrated with a rectangle of known size.",
        listOf(points("refPoints", "Reference Rectangle", 4, 4, closed = true), num("refWidth", "Rectangle Width", 0.001, 100000.0, 0.52, slider = false, decimals = 3), num("refHeight", "Rectangle Height", 0.001, 100000.0, 0.11, slider = false, decimals = 3), text("unit", "Unit", "m"), line("line", "Measured Segment"), color("color", "Color", "#00e0ff"), int("size", "Label Size", 8, 72, 16)),
        reference = REF.metrology, overlayOn = "any", hint = "Hint: tap the four corners of a rectangle of known size (clockwise from top left), then draw the segment to measure."),
    // ============================== Sharpen
    FilterDef("unsharp_mask", "Unsharp Masking", "Sharpen", FilterKind.FILTER, "Sharpens the image by adding the difference with a blurred version.", listOf(num("radius", "Radius", 0.3, 20.0, 1.5), num("amount", "Amount", 0.0, 5.0, 1.0), num("threshold", "Threshold", 0.0, 50.0, 0.0, decimals = 1)), reference = REF.gw),
    FilterDef("laplacian_sharpening", "Laplacian Sharpening", "Sharpen", FilterKind.FILTER, "Sharpens the image with a Laplacian filter.", listOf(num("amount", "Amount", 0.0, 5.0, 1.0), bool("diagonals", "Include Diagonals", true)), reference = REF.gw),
    FilterDef("high_pass_sharpening", "High Pass Sharpening", "Sharpen", FilterKind.FILTER, "Enhances local contrast with a large radius high pass filter.", listOf(num("radius", "Radius", 2.0, 100.0, 20.0, decimals = 1), num("amount", "Amount", 0.0, 3.0, 0.5)), reference = REF.gw),
    // ============================== Denoise
    FilterDef("averaging_filter", "Averaging Filter", "Denoise", FilterKind.FILTER, "Reduces the noise by averaging neighboring pixels.", listOf(int("radius", "Radius", 1, 20, 1)), reference = REF.gw),
    FilterDef("gaussian_filter", "Gaussian Filter", "Denoise", FilterKind.FILTER, "Reduces the noise with a Gaussian blur.", listOf(num("sigma", "Sigma", 0.3, 30.0, 1.0)), reference = REF.gw),
    FilterDef("median_filter", "Median Filter", "Denoise", FilterKind.FILTER, "Reduces impulsive (salt and pepper) noise preserving edges.", listOf(int("radius", "Radius", 1, 7, 1)), reference = REF.median),
    FilterDef("bilateral_filter", "Bilateral Filter", "Denoise", FilterKind.FILTER, "Reduces the noise preserving the edges.", listOf(num("sigmaS", "Spatial Sigma", 0.5, 8.0, 2.0), num("sigmaR", "Range Sigma", 1.0, 100.0, 20.0, decimals = 1)), reference = REF.bilateral),
    FilterDef("nl_means", "Non-Local Means", "Denoise", FilterKind.FILTER, "Advanced denoising comparing patches in a search window.", listOf(num("h", "Strength", 1.0, 50.0, 10.0, decimals = 1), int("patch", "Patch Radius", 1, 3, 1), int("search", "Search Radius", 2, 10, 5)), reference = REF.nlm, slow = true),
    FilterDef("wiener_filter", "Wiener Filter", "Denoise", FilterKind.FILTER, "Adaptive filter based on local statistics.", listOf(int("radius", "Radius", 1, 6, 2), num("noise", "Noise Variance (0 = auto)", 0.0, 2000.0, 0.0, decimals = 1)), reference = REF.lim),
    FilterDef("deblocking", "Deblocking", "Denoise", FilterKind.FILTER, "Reduces the blocking artifacts of JPEG and MPEG compression.", listOf(int("block", "Block Size", 4, 32, 8, step = 4.0), num("strength", "Strength", 0.0, 1.0, 0.6), num("threshold", "Edge Threshold", 1.0, 80.0, 24.0, decimals = 1)), reference = REF.deblock),
    // ============================== Deblurring
    FilterDef("motion_deblurring", "Motion Deblurring", "Deblurring", FilterKind.FILTER, "Corrects a linear motion blur.",
        listOf(line("line", "Blur Trail"), num("length", "Length", 1.0, 150.0, 10.0, decimals = 1), num("angle", "Angle", -180.0, 180.0, 0.0, decimals = 1), sel("method", "Method", DECONV, "wiener"),
            num("noise", "Noise", 0.0001, 1.0, 0.01, decimals = 4, log = true), int("iterations", "Iterations", 1, 200, 25, show = { it.str("method") == "rl" }), psf()),
        reference = REF.wiener + " " + REF.rl, overlayOn = "any", hint = "Hint: draw a line along a blur trail in the Viewer to set length and angle, then adjust the noise."),
    FilterDef("optical_deblurring", "Optical Deblurring", "Deblurring", FilterKind.FILTER, "Corrects an out of focus blur.",
        listOf(num("radius", "Radius", 0.5, 40.0, 3.0), sel("method", "Method", DECONV, "wiener"), num("noise", "Noise", 0.0001, 1.0, 0.01, decimals = 4, log = true), int("iterations", "Iterations", 1, 200, 25, show = { it.str("method") == "rl" }), psf()), reference = REF.wiener),
    FilterDef("gaussian_deblurring", "Gaussian Deblurring", "Deblurring", FilterKind.FILTER, "Corrects a Gaussian blur (atmospheric or sensor).",
        listOf(num("sigma", "Sigma", 0.3, 20.0, 1.5), sel("method", "Method", DECONV, "wiener"), num("noise", "Noise", 0.0001, 1.0, 0.01, decimals = 4, log = true), int("iterations", "Iterations", 1, 200, 25, show = { it.str("method") == "rl" }), psf()), reference = REF.wiener),
    FilterDef("nonlinear_deblurring", "Nonlinear Deblurring", "Deblurring", FilterKind.FILTER, "Corrects a blur with a non linear trajectory.",
        listOf(points("points", "Points", 2, 64, polyline = true), num("noise", "Noise", 0.0001, 1.0, 0.01, decimals = 4, log = true), int("thickness", "Thickness", 1, 199, 1), psf(),
            sel("method", "Method", DECONV, "wiener", tab = "Advanced"), int("iterations", "Iterations", 1, 200, 25, tab = "Advanced")),
        reference = REF.wiener + " " + REF.rl, overlayOn = "any", tabs = listOf("Settings", "Advanced"), hint = "Hint: add points to follow the shape of the blur."),
    // ============================== Stabilization
    FilterDef("local_stabilization", "Local Stabilization", "Stabilization", FilterKind.FILTER, "Stabilizes the video on a selected object (e.g. a license plate).",
        listOf(rect("roi", "Tracked Region"), frame("reference", "Reference Frame"), int("search", "Search Range (px)", 4, 256, 32), bool("subpixel", "Sub-pixel Accuracy", true), sel("fill", "Borders", o("black" to "Black", "edge" to "Replicate Edge"), "black")),
        temporal = true, reference = REF.ncc, overlayOn = "any", hint = "Hint: select a small region with good details on the object to track. The reference frame is where the object position is kept."),
    FilterDef("global_stabilization", "Global Stabilization", "Stabilization", FilterKind.FILTER, "Stabilizes the whole frame with phase correlation.",
        listOf(frame("reference", "Reference Frame"), bool("subpixel", "Sub-pixel Accuracy", true), sel("fill", "Borders", o("black" to "Black", "edge" to "Replicate Edge"), "black")), temporal = true, reference = REF.phase),
    // ============================== Integrate
    FilterDef("frame_averaging", "Frame Averaging", "Integrate", FilterKind.FILTER, "Averages several frames to reduce the noise.",
        listOf(sel("mode", "Frames", o("all" to "All Frames", "window" to "Moving Window"), "all"), int("window", "Window Size", 2, 200, 5, show = { mode(it) == "window" }),
            sel("method", "Method", o("mean" to "Mean", "median" to "Median", "sigma" to "Sigma Clipped Mean"), "mean"), num("sigma", "Sigma", 1.0, 5.0, 2.0, show = { it.str("method") == "sigma" })),
        temporal = true, reference = REF.sigma, hint = "Hint: stabilize the video and select the range of frames before averaging. \"All Frames\" outputs a single integrated frame."),
    FilterDef("temporal_smoothing", "Temporal Smoothing", "Integrate", FilterKind.FILTER, "Reduces the noise of a video by combining each frame with its neighbors (moving window); the number of frames does not change.",
        listOf(
            int("size", "Size", 2, 31, 5, help = "Frames combined for each output frame: the current frame and its neighbors, half before and half after."),
            sel("method", "Method", o("mean" to "Mean", "gaussian" to "Gaussian Weighted", "median" to "Median"), "mean", help = "Mean: every frame weighs the same. Gaussian Weighted: the closer a frame, the more it weighs. Median: also removes short-lived specks."),
            bool("protect", "Protect Moving Objects", true, help = "Leaves out the pixels of neighboring frames that differ from the current frame, so moving subjects leave no ghost trails."),
            num("threshold", "Motion Threshold", 1.0, 100.0, 12.0, decimals = 1, show = { it["protect"] != false }, help = "Difference to the current frame (largest of R, G and B, weighted 3x3 mean) above which a pixel counts as moving."),
            bool("showMask", "Show Protected Areas", false, show = { it["protect"] != false }, help = "Shows the image in gray with the pixels left out because of motion in red."),
        ), temporal = true, reference = REF.tnr, hint = "Hint: stabilize the video first if the camera moves."),
    FilterDef("super_resolution", "Super Resolution", "Integrate", FilterKind.FILTER, "Combines the frames with sub-pixel registration to increase the resolution.",
        listOf(int("scale", "Scale Factor", 2, 4, 2), rect("roi", "Registration Region (optional)"), int("maxFrames", "Maximum Frames", 2, 200, 30), sel("kernel", "Splat Kernel", o("gaussian" to "Gaussian", "bilinear" to "Bilinear"), "gaussian"),
            sel("output", "Output", o("region" to "Registration region only", "frame" to "Whole frame"), "region", legacy = "frame",
                help = "With a registration region drawn, only that part is enlarged (identical to the same part of the whole-frame result, much faster and smaller; a phone cannot hold a 4× enlargement of a full HD frame). Without a region, or with Whole frame, the whole frame is enlarged as in the browser version.")),
        temporal = true, slow = true, reference = REF.sr, overlayOn = "any", hint = "Hint: select a region on the object for registration. Works best on stabilized, slightly moving content."),
    // ============================== Presentation
    FilterDef("add_text", "Add Text", "Presentation", FilterKind.FILTER, "Adds a text to the image.",
        listOf(text("text", "Text", "Text", multiline = true), point("position", "Position", Pt(20.0, 20.0)), int("size", "Size", 6, 300, 32), sel("font", "Font", o("sans" to "Sans Serif", "serif" to "Serif", "mono" to "Monospace"), "sans"),
            bool("bold", "Bold", true), color("color", "Color", "#ffffff"), bool("background", "Background", true), color("bgColor", "Background Color", "#000000"), num("bgOpacity", "Background Opacity", 0.0, 1.0, 0.6)), overlayOn = "any"),
    FilterDef("add_shape", "Add Shape", "Presentation", FilterKind.FILTER, "Select and draw shapes on current frame.",
        listOf(
            sel("shape", "Shape Type", o("rectangle" to "Rectangle", "ellipse" to "Ellipse", "line" to "Line", "arrow" to "Arrow", "double_arrow" to "Double Arrow"), "rectangle"),
            int("thickness", "Border Thickness", 0, 50, 3), color("borderColor", "Border Color", "#ff2020"),
            bool("fill", "Fill Area", false, show = { val s = it.str("shape"); s == "rectangle" || s == "ellipse" }),
            color("fillColor", "Fill Color", "#ff2020", show = { val s = it.str("shape"); it.bool("fill") && (s == "rectangle" || s == "ellipse") }),
            num("fillOpacity", "Fill Opacity", 0.0, 1.0, 0.3, show = { val s = it.str("shape"); it.bool("fill") && (s == "rectangle" || s == "ellipse") }),
            rect("rect", "Area", tab = "Selection", show = { val s = it.str("shape"); s == "rectangle" || s == "ellipse" }),
            line("line", "Line", tab = "Selection", show = { val s = it.str("shape"); s == "line" || s == "arrow" || s == "double_arrow" }),
            frame("from", "From Frame", 0, tab = "Selection"), frame("to", "To Frame (-1 = end)", -1, allowLast = true, tab = "Selection"),
        ), overlayOn = "any", tabs = listOf("Settings", "Selection")),
    FilterDef("hide_selection", "Hide Selection", "Presentation", FilterKind.FILTER, "Hides a region (faces, plates of bystanders) by blurring, pixelating or filling.",
        listOf(rect("rect", "Region"), sel("shape", "Shape", o("rectangle" to "Rectangle", "ellipse" to "Ellipse"), "rectangle"), sel("mode", "Mode", o("pixelate" to "Pixelate", "blur" to "Blur", "fill" to "Fill"), "pixelate"),
            int("strength", "Strength", 2, 100, 16), color("color", "Fill Color", "#000000", show = { mode(it) == "fill" })), overlayOn = "any"),
    FilterDef("spotlight", "Spotlight", "Presentation", FilterKind.FILTER, "Highlights a region by dimming the rest of the image.",
        listOf(rect("rect", "Region"), sel("shape", "Shape", o("ellipse" to "Ellipse", "rectangle" to "Rectangle"), "ellipse"), num("dim", "Dimming", 0.0, 1.0, 0.6), int("feather", "Feather", 0, 200, 16), bool("border", "Border", true), color("borderColor", "Border Color", "#ffd400")), overlayOn = "any"),
    FilterDef("magnify", "Magnify", "Presentation", FilterKind.FILTER, "Shows a magnified inset of a region.",
        listOf(rect("rect", "Region"), num("zoom", "Zoom", 1.0, 10.0, 2.5), sel("position", "Position", CORNERS, "tr"), sel("interp", "Interpolation", INTERP, "bicubic"), int("border", "Border", 0, 20, 2), color("borderColor", "Border Color", "#ffd400")), overlayOn = "any"),
    FilterDef("add_timestamp", "Add Timestamp", "Presentation", FilterKind.FILTER, "Adds the frame number and/or time to each frame.",
        listOf(sel("format", "Format", o("both" to "Frame and Time", "frame" to "Frame Number", "time" to "Time", "datetime" to "Date and Time"), "both"), text("start", "Start Date/Time", "2026-01-01 00:00:00.000", show = { it.str("format") == "datetime" }),
            sel("position", "Position", CORNERS, "bl"), int("size", "Size", 8, 120, 20), color("color", "Color", "#ffffff"), bool("background", "Background", true))),
    FilterDef("add_logo", "Add Logo", "Presentation", FilterKind.FILTER, "Adds a logo or watermark image.",
        listOf(ImageParam("image", "Logo Image"), sel("position", "Position", CORNERS, "tr"), num("scale", "Scale (%)", 1.0, 200.0, 20.0, decimals = 1), num("opacity", "Opacity", 0.0, 1.0, 0.85), int("margin", "Margin", 0, 200, 12))),
    FilterDef("add_grid", "Add Grid", "Presentation", FilterKind.FILTER, "Overlays a grid for reference.",
        listOf(int("spacing", "Spacing", 4, 1000, 50), int("thickness", "Thickness", 1, 10, 1), color("color", "Color", "#00ff66"), num("opacity", "Opacity", 0.0, 1.0, 0.5), bool("labels", "Coordinates", false))),
    FilterDef("change_frame_rate", "Change Frame Rate", "Presentation", FilterKind.FILTER, "Changes the nominal frame rate (playback speed) without changing the frames.", listOf(num("fps", "Frame Rate", 0.1, 240.0, 25.0, decimals = 3, slider = false))),
    FilterDef("convert_frame_rate", "Convert Frame Rate", "Presentation", FilterKind.FILTER, "Converts the frame rate by duplicating, dropping or blending frames.", listOf(num("fps", "Target Frame Rate", 0.1, 240.0, 25.0, decimals = 3, slider = false), sel("method", "Method", o("nearest" to "Duplicate/Drop", "blend" to "Blend"), "nearest"))),
    FilterDef("reverse", "Reverse", "Presentation", FilterKind.FILTER, "Reverses the order of the frames.", emptyList()),
    FilterDef("freeze_frame", "Freeze Frame", "Presentation", FilterKind.FILTER, "Holds a frame for a number of frames.", listOf(frame("frame", "Frame"), int("duration", "Duration (frames)", 1, 100000, 50, slider = false))),
)

val FILTERS: Map<String, FilterDef> = FILTER_LIST.associateBy { it.id }

/** Parameters of the Android edition that the browser catalog does not have (projects stay interchangeable). */
val ANDROID_ONLY_PARAMS = setOf("video_mixer.sync", "multiview.sync", "picture_in_picture.sync", "timeline.sync", "replace_channel.sync", "super_resolution.output")

fun filtersInCategory(cat: String) = FILTER_LIST.filter { it.category == cat }

fun defaultParams(def: FilterDef): MutableMap<String, Any?> {
    val p = LinkedHashMap<String, Any?>()
    for (d in def.params) if (!d.transient) p[d.key] = d.default
    return p
}

/** Fill missing params (projects saved by older versions): the legacy value when declared, else the default. */
fun normalizeParams(def: FilterDef, params: Params): Map<String, Any?> {
    val out = defaultParams(def)
    for (d in def.params) if (d.legacy != null && !params.containsKey(d.key)) out[d.key] = d.legacy
    out.putAll(params)
    return out
}
