package com.clearufo.forensics.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import androidx.exifinterface.media.ExifInterface
import com.clearufo.forensics.engine.Frame
import com.clearufo.forensics.engine.FrameMeta
import java.io.ByteArrayInputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import kotlin.math.max
import kotlin.math.min

/** A file picked through the Storage Access Framework (read-only; the evidence is never modified). */
data class EvidenceFile(val uri: Uri, val name: String, val size: Long, val mime: String?, val lastModified: Long = 0)

data class Hashes(val md5: String, val sha1: String, val sha256: String, val bytes: Long)

object Files {
    fun describe(ctx: Context, uri: Uri): EvidenceFile {
        var name = uri.lastPathSegment ?: "evidence"; var size = -1L
        try {
            ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { if (!c.isNull(it)) name = c.getString(it) }
                    c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 }?.let { if (!c.isNull(it)) size = c.getLong(it) }
                }
            }
        } catch (_: Exception) { }
        if (size < 0) size = try { ctx.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: 0L } catch (_: Exception) { 0L }
        return EvidenceFile(uri, name, size, ctx.contentResolver.getType(uri))
    }

    fun readAll(ctx: Context, uri: Uri): ByteArray = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: throw IllegalStateException("The file cannot be read")

    fun head(ctx: Context, uri: Uri, n: Int = 64): ByteArray = ctx.contentResolver.openInputStream(uri)?.use { s ->
        val b = ByteArray(n); var off = 0
        while (off < n) { val r = s.read(b, off, n - off); if (r <= 0) break; off += r }
        b.copyOf(off)
    } ?: ByteArray(0)

    /** MD5, SHA-1 and SHA-256 of the original bytes, read in 4 MiB chunks (constant memory). */
    fun hash(ctx: Context, uri: Uri, progress: (Double) -> Unit = {}, cancel: () -> Boolean = { false }): Hashes {
        val md5 = MessageDigest.getInstance("MD5"); val sha1 = MessageDigest.getInstance("SHA-1"); val sha256 = MessageDigest.getInstance("SHA-256")
        val total = describe(ctx, uri).size
        var n = 0L
        ctx.contentResolver.openInputStream(uri)?.use { s ->
            val buf = ByteArray(4 shl 20)
            while (true) {
                if (cancel()) throw InterruptedException("Hashing cancelled")
                val r = s.read(buf)
                if (r < 0) break
                md5.update(buf, 0, r); sha1.update(buf, 0, r); sha256.update(buf, 0, r)
                n += r
                if (total > 0) progress(n.toDouble() / total)
            }
        } ?: throw IllegalStateException("The file cannot be read")
        return Hashes(hex(md5.digest()), hex(sha1.digest()), hex(sha256.digest()), n)
    }

    fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    /** Natural sort key (img2 before img10). */
    val naturalOrder: Comparator<String> = Comparator { a, b ->
        val ra = Regex("\\d+|\\D+").findAll(a.lowercase()).map { it.value }.toList()
        val rb = Regex("\\d+|\\D+").findAll(b.lowercase()).map { it.value }.toList()
        for (i in 0 until min(ra.size, rb.size)) {
            val x = ra[i]; val y = rb[i]
            val c = if (x[0].isDigit() && y[0].isDigit()) x.toBigInteger().compareTo(y.toBigInteger()).let { if (it == 0) x.length - y.length else it } else x.compareTo(y)
            if (c != 0) return@Comparator c
        }
        ra.size - rb.size
    }
}

/** Decodes a still image: PNG and TIFF exactly with ClearUFO's own decoders, other formats with the platform decoder. */
object StillDecoder {
    fun decode(bytes: ByteArray): DecodedImage {
        if (PngCodec.isPng(bytes)) return PngCodec.decode(bytes)
        if (TiffCodec.isTiff(bytes)) return TiffCodec.decode(bytes)
        // Platform decoder (JPEG, WebP, BMP, GIF, HEIF, AVIF): no color-space conversion (the bitmap keeps the space
        // embedded in the file), no premultiplication, EXIF orientation not applied (pixels as stored).
        val o = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888; inPremultiplied = false; inScaled = false; inMutable = false }
        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o) ?: throw IllegalArgumentException("The image format is not supported by this device")
        val f = bitmapToFrame(bmp)
        val cs = bmp.colorSpace?.name ?: "sRGB"
        val hasAlpha = bmp.hasAlpha()
        bmp.recycle()
        return DecodedImage(f, 8, "${o.outMimeType ?: "image"}, decoded by the Android platform decoder (8-bit, color space \"$cs\" as stored, not converted)", hasAlpha)
    }

    /**
     * Byte offsets of R, G, B and A in an ARGB_8888 bitmap's memory (RGBA on Android devices; the platform does not
     * guarantee it, so it is measured once with a probe pixel).
     */
    private val order: IntArray by lazy {
        try {
            val b = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
            b.setPixel(0, 0, android.graphics.Color.argb(0xFF, 0x11, 0x22, 0x33))
            val buf = ByteBuffer.allocate(4); b.copyPixelsToBuffer(buf); b.recycle()
            val a = buf.array().map { it.toInt() and 255 }
            val o = intArrayOf(a.indexOf(0x11), a.indexOf(0x22), a.indexOf(0x33), a.indexOf(0xFF))
            if (o.any { it < 0 } || o.toSet().size != 4) intArrayOf(0, 1, 2, 3) else o
        } catch (_: Throwable) { intArrayOf(0, 1, 2, 3) }
    }

    /** Raw samples of an ARGB_8888 bitmap (copyPixelsToBuffer: no color conversion, unlike getPixels). */
    fun bitmapToFrame(bmp0: Bitmap): Frame {
        val bmp = if (bmp0.config != Bitmap.Config.ARGB_8888) bmp0.copy(Bitmap.Config.ARGB_8888, false) else bmp0
        val w = bmp.width; val h = bmp.height
        val buf = ByteBuffer.allocate(bmp.rowBytes * h)
        bmp.copyPixelsToBuffer(buf)
        val b = buf.array(); val row = bmp.rowBytes
        val f = Frame.alloc(w, h, false)
        val ri = order[0]; val gi = order[1]; val bi = order[2]; val ai = order[3]
        for (y in 0 until h) for (x in 0 until w) {
            val s = y * row + x * 4; val o = (y * w + x) * 4
            f.d[o] = (b[s + ri].toInt() and 255).toFloat(); f.d[o + 1] = (b[s + gi].toInt() and 255).toFloat(); f.d[o + 2] = (b[s + bi].toInt() and 255).toFloat(); f.d[o + 3] = (b[s + ai].toInt() and 255).toFloat()
        }
        if (bmp !== bmp0) bmp.recycle()
        return f
    }

    fun exif(bytes: ByteArray): List<Pair<String, String>> = try {
        val e = ExifInterface(ByteArrayInputStream(bytes))
        val tags = listOf(
            ExifInterface.TAG_MAKE to "Camera Make", ExifInterface.TAG_MODEL to "Camera Model", ExifInterface.TAG_DATETIME_ORIGINAL to "Date Taken",
            ExifInterface.TAG_DATETIME to "Date Modified", ExifInterface.TAG_OFFSET_TIME_ORIGINAL to "Time Zone", ExifInterface.TAG_SOFTWARE to "Software",
            ExifInterface.TAG_ORIENTATION to "Orientation", ExifInterface.TAG_EXPOSURE_TIME to "Exposure Time", ExifInterface.TAG_F_NUMBER to "F-Number",
            ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY to "ISO", ExifInterface.TAG_FOCAL_LENGTH to "Focal Length", ExifInterface.TAG_LENS_MODEL to "Lens",
            ExifInterface.TAG_IMAGE_UNIQUE_ID to "Image Unique ID", ExifInterface.TAG_ARTIST to "Artist", ExifInterface.TAG_COPYRIGHT to "Copyright",
            ExifInterface.TAG_IMAGE_DESCRIPTION to "Description", ExifInterface.TAG_USER_COMMENT to "User Comment",
        )
        val out = tags.mapNotNull { (t, l) -> e.getAttribute(t)?.takeIf { it.isNotBlank() }?.let { "EXIF $l" to it.trim() } }.toMutableList()
        e.latLong?.let { out.add("EXIF GPS" to "%.6f, %.6f".format(it[0], it[1])) }
        e.getAttribute(ExifInterface.TAG_GPS_ALTITUDE)?.let { out.add("EXIF GPS Altitude" to it) }
        if (e.hasThumbnail()) out.add("EXIF Thumbnail" to "embedded (${e.thumbnailBytes?.size ?: 0} bytes)")
        out
    } catch (_: Exception) { emptyList() }
}

class ImageSource(override val info: SourceInfo, private val frame: Frame) : SourceProvider {
    override suspend fun getFrame(i: Int, opts: DecodeOptions) = frame
    override fun meta(i: Int) = FrameMeta('I', 0.0, true, info.fileSize.toInt(), 0)

    companion object {
        fun open(ctx: Context, id: String, f: EvidenceFile): ImageSource {
            val bytes = Files.readAll(ctx, f.uri)
            val dec = StillDecoder.decode(bytes)
            val info = SourceInfo(id, "image", f.name, bytes.size.toLong(), 1, f.mime, dec.frame.w, dec.frame.h, 1, 25.0, 0.0,
                container = f.name.substringAfterLast('.', "").uppercase(), codec = dec.description.substringBefore(","), bitDepth = dec.depth, engine = dec.description)
            info.metadata.add("Decoding" to dec.description)
            info.metadata.add("Alpha channel" to if (dec.hasAlpha) "yes" else "no")
            info.metadata.addAll(StillDecoder.exif(bytes))
            return ImageSource(info, dec.frame)
        }
    }
}

class SequenceSource(override val info: SourceInfo, private val ctx: Context, private val files: List<EvidenceFile>) : SourceProvider {
    override suspend fun getFrame(i: Int, opts: DecodeOptions): Frame {
        val f = files[max(0, min(files.size - 1, i))]
        return StillDecoder.decode(Files.readAll(ctx, f.uri)).frame
    }
    override fun meta(i: Int) = FrameMeta('I', i / info.fps, true, files.getOrNull(i)?.size?.toInt() ?: 0, i)

    companion object {
        fun open(ctx: Context, id: String, files0: List<EvidenceFile>, fps: Double): SequenceSource {
            val files = files0.sortedWith { a, b -> Files.naturalOrder.compare(a.name, b.name) }
            val first = StillDecoder.decode(Files.readAll(ctx, files[0].uri))
            val info = SourceInfo(id, "sequence", "${files[0].name} … (${files.size} images)", files.sumOf { it.size }, files.size, files[0].mime,
                first.frame.w, first.frame.h, files.size, fps, files.size / fps, container = "Image sequence", codec = first.description.substringBefore(","), bitDepth = first.depth, engine = first.description)
            info.metadata.add("First file" to files.first().name); info.metadata.add("Last file" to files.last().name)
            return SequenceSource(info, ctx, files)
        }
    }
}
