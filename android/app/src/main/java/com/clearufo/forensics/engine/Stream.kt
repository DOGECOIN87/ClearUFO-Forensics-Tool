package com.clearufo.forensics.engine

import kotlin.math.max
import kotlin.math.min

/** Description of a processed stream at some point of a chain. */
data class StreamInfo(val width: Int, val height: Int, val frameCount: Int, val fps: Double, val par: Double = 1.0)

/** Per-frame metadata: compression type (I/P/B/S/?), presentation timestamp (s), key frame, coded size, source frame. */
data class FrameMeta(val type: Char = '?', val pts: Double? = null, val key: Boolean = false, val bytes: Int = 0, val src: Int? = null)

/** Lazy frame stream: every filter turns its input stream into an output stream. */
interface Stream {
    val info: StreamInfo
    suspend fun getFrame(i: Int): Frame
    fun meta(i: Int): FrameMeta
}

class FilterException(message: String, val filterId: String? = null, cause: Throwable? = null) : Exception(message, cause)

fun needInput(input: Stream?): Stream = input ?: throw IllegalStateException("This filter needs an input: add a loader first")

/** Frame-wise filter. */
fun mapStream(input: Stream?, info: StreamInfo? = null, fn: suspend (Frame, Int) -> Frame): Stream {
    val src = needInput(input)
    val inf = info ?: src.info
    return object : Stream {
        override val info = inf
        override suspend fun getFrame(i: Int) = fn(src.getFrame(i), i)
        override fun meta(i: Int) = src.meta(i)
    }
}

/** Output frame i is input frame index[i]. */
fun remapStream(input: Stream, index: IntArray, info: StreamInfo? = null): Stream {
    val n = index.size
    if (n == 0) throw IllegalStateException("No frames selected")
    val inf = info ?: input.info.copy(frameCount = n)
    fun at(i: Int) = index[max(0, min(n - 1, i))]
    return object : Stream {
        override val info = inf
        override suspend fun getFrame(i: Int) = input.getFrame(at(i))
        override fun meta(i: Int) = input.meta(at(i))
    }
}

fun constantStream(frame: Frame, info: StreamInfo, meta: FrameMeta): Stream = object : Stream {
    override val info = info.copy(frameCount = 1, width = frame.w, height = frame.h)
    override suspend fun getFrame(i: Int) = frame
    override fun meta(i: Int) = meta
}

fun clampFrameIndex(v: Double, n: Int, allowLast: Boolean = false): Int {
    if (allowLast && v < 0) return n - 1
    return max(0, min(n - 1, jsRound(if (v.isNaN()) 0.0 else v)))
}

// ---------------------------------------------------------------- export formats
data class FormatInfo(val label: String, val short: String, val lossy: Boolean, val video: Boolean, val ext: String, val mime: String, val depth: String, val bpp: Int = 0)

object WriteFormats {
    val ALL: Map<String, FormatInfo> = linkedMapOf(
        "avi-raw" to FormatInfo("AVI — uncompressed RGB, 8-bit", "AVI (uncompressed)", false, true, "avi", "video/x-msvideo", "8-bit", 3),
        "tiff16" to FormatInfo("TIFF — uncompressed, 16-bit", "TIFF 16-bit (uncompressed)", false, false, "tif", "image/tiff", "16-bit", 6),
        "tiff" to FormatInfo("TIFF — uncompressed, 8-bit", "TIFF 8-bit (uncompressed)", false, false, "tif", "image/tiff", "8-bit", 3),
        "tiff32f" to FormatInfo("TIFF — uncompressed, 32-bit float", "TIFF 32-bit float (uncompressed)", false, false, "tif", "image/tiff", "32-bit float", 12),
        "png16" to FormatInfo("PNG — uncompressed, 16-bit", "PNG 16-bit (uncompressed)", false, false, "png", "image/png", "16-bit", 6),
        "png" to FormatInfo("PNG — uncompressed, 8-bit", "PNG 8-bit (uncompressed)", false, false, "png", "image/png", "8-bit", 3),
        "bmp" to FormatInfo("BMP — uncompressed, 8-bit", "BMP (uncompressed)", false, false, "bmp", "image/bmp", "8-bit", 3),
        "avi-mjpeg" to FormatInfo("AVI — Motion JPEG (lossy)", "AVI Motion JPEG (lossy)", true, true, "avi", "video/x-msvideo", ""),
        "mp4" to FormatInfo("MP4 — H.264 or HEVC, hardware encoder (lossy)", "MP4 (lossy)", true, true, "mp4", "video/mp4", ""),
        "webm" to FormatInfo("WebM — VP9 or VP8 (lossy)", "WebM (lossy)", true, true, "webm", "video/webm", ""),
        "jpeg" to FormatInfo("JPEG (lossy)", "JPEG (lossy)", true, false, "jpg", "image/jpeg", "8-bit"),
        "webp" to FormatInfo("WebP (lossy)", "WebP (lossy)", true, false, "webp", "image/webp", "8-bit"),
    )
    val VIDEO_EXPORT = listOf("avi-raw", "tiff16", "tiff32f", "png16", "tiff", "png", "avi-mjpeg", "mp4", "webm")
    val IMAGE_EXPORT = listOf("tiff16", "tiff", "tiff32f", "png16", "png", "bmp", "jpeg", "webp")

    fun of(f: String): FormatInfo? = ALL[f]
    fun label(f: String, sequence: Boolean): String {
        val fi = ALL[f] ?: return f
        return if (sequence && !fi.video) fi.label.replace(Regex("^(\\w+) —"), "$1 sequence —") else fi.label
    }
    fun sanitizeName(name: String) = name.replace(Regex("[\\\\/:*?\"<>|]+"), "_").trim().ifEmpty { "output" }
    fun sequenceName(base: String, frame: Int, last: Int, ext: String) = "${base}_${frame.toString().padStart(max(4, last.toString().length), '0')}.$ext"
    /** File name and type of an export of `count` frames (several image frames go into one ZIP). */
    fun outputFile(f: String, name: String, count: Int): Triple<String, String, Boolean> {
        val fi = ALL.getValue(f); val zip = !fi.video && count > 1
        return Triple("${sanitizeName(name)}.${if (zip) "zip" else fi.ext}", if (zip) "application/zip" else fi.mime, zip)
    }
}
