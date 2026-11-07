package com.clearufo.forensics.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageFormat
import android.media.Image
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.os.ParcelFileDescriptor
import com.clearufo.forensics.engine.Frame
import com.clearufo.forensics.engine.FrameMeta
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.min

/** Copies a decoded MediaCodec image (YUV_420_888 or P010, cropped) into planes for the explicit YUV → RGB step. */
fun copyImage(img: Image): Yuv.Planes {
    val crop = img.cropRect
    val w = crop.width(); val h = crop.height(); val x0 = crop.left; val y0 = crop.top
    val ten = img.format == ImageFormat.YCBCR_P010
    val P = img.planes
    val cw = (w + 1) / 2; val ch = (h + 1) / 2
    val Y = ShortArray(w * h); val U = ShortArray(cw * ch); val V = ShortArray(cw * ch)
    fun readPlane(pl: Image.Plane, out: ShortArray, pw: Int, ph: Int, ox: Int, oy: Int) {
        val b = pl.buffer; val rs = pl.rowStride; val ps = pl.pixelStride
        if (!ten && ps == 1) {
            val row = ByteArray(pw)
            for (y in 0 until ph) {
                b.position((oy + y) * rs + ox); b.get(row, 0, min(pw, b.remaining()))
                for (x in 0 until pw) out[y * pw + x] = (row[x].toInt() and 255).toShort()
            }
            return
        }
        for (y in 0 until ph) {
            val base = (oy + y) * rs + ox * ps
            for (x in 0 until pw) {
                val p = base + x * ps
                out[y * pw + x] = if (ten) ((((b.get(p).toInt() and 255) or ((b.get(p + 1).toInt() and 255) shl 8)) ushr 6)).toShort() else (b.get(p).toInt() and 255).toShort()
            }
        }
    }
    readPlane(P[0], Y, w, h, x0, y0)
    readPlane(P[1], U, cw, ch, x0 / 2, y0 / 2)
    readPlane(P[2], V, cw, ch, x0 / 2, y0 / 2)
    return Yuv.Planes(w, h, Y, U, V, cw, ch, 1, 1, if (ten) 10 else 8)
}

/** Color facts of a stream: matrix, range and transfer, as signaled (null when not signaled). */
data class ColorFacts(val standard: Int? = null, val range: Int? = null, val transfer: Int? = null)

fun matrixName(std: Int?): String? = when (std) { MediaFormat.COLOR_STANDARD_BT709 -> "bt709"; MediaFormat.COLOR_STANDARD_BT601_PAL, MediaFormat.COLOR_STANDARD_BT601_NTSC -> "bt601"; MediaFormat.COLOR_STANDARD_BT2020 -> "bt2020"; else -> null }

/** YUV planes → frame with the Video Loader options; records how the conversion was done. */
fun planesToFrame(p: Yuv.Planes, c: ColorFacts, o: DecodeOptions, info: SourceInfo): Frame {
    val matrix = if (o.matrix != "auto") o.matrix else matrixName(c.standard) ?: if (p.h >= 720) "bt709" else "bt601"
    val full = if (o.colorRange != "auto") o.colorRange == "full" else c.range == MediaFormat.COLOR_RANGE_FULL
    val siting = if (o.siting != "auto") o.siting else "left"
    val f = Yuv.toFrame(p, matrix, full, o.chroma, siting)
    val hdr = c.transfer == MediaFormat.COLOR_TRANSFER_ST2084 || c.transfer == MediaFormat.COLOR_TRANSFER_HLG
    val tone = hdr && o.hdr != "none"
    if (tone) Hdr.toSdr(f, c.transfer == MediaFormat.COLOR_TRANSFER_ST2084, matrix == "bt2020", o.hdrPeak)
    info.conversion = "YUV → RGB by ClearUFO: ${matrix.uppercase().replace("BT", "BT.")} matrix, ${if (full) "full" else "limited"} range, ${p.bits}-bit samples, " +
        "${if (o.chroma == "nearest") "nearest (replicated)" else o.chroma} chroma${if (o.chroma != "nearest") " ($siting siting)" else ""}" +
        if (hdr) (if (tone) ", HDR tone mapped to SDR (BT.2390, peak ${o.hdrPeak.toInt()} cd/m²)" else ", HDR signal values as decoded") else ""
    return f
}

/**
 * Frame-accurate video decoding with MediaExtractor + MediaCodec (the phone's hardware decoders). Every sample is
 * indexed at open time (timestamp, sync flag, size); frame i is the i-th sample in presentation order. A request
 * seeks to the sync sample preceding the frame in decode order and decodes forward until the output with exactly
 * that timestamp appears; consecutive requests continue the running decode (playback).
 */
class VideoSource private constructor(private val ctx: Context, override val info: SourceInfo, private val file: EvidenceFile) : SourceProvider {
    private lateinit var dPts: LongArray
    private lateinit var dFlags: IntArray
    private lateinit var dSize: IntArray
    /** display index → decode index, and decode index → display index */
    private lateinit var order: IntArray
    private lateinit var rank: IntArray
    private var types: CharArray? = null
    private var track = -1
    private lateinit var trackFormat: MediaFormat
    private var colors = ColorFacts()
    private val lock = Mutex()
    private var pfd: ParcelFileDescriptor? = null
    private var codecName = ""
    /**
     * Independent decoding positions: linked chains, Compare Original or a mixer offset read the same file at two or
     * three places at once; each place keeps its own extractor and hardware decoder instead of seeking back and forth.
     */
    private inner class Cursor {
        var extractor: MediaExtractor? = null
        var codec: MediaCodec? = null
        var nextDecode = 0
        var segmentStart = -1
        var lastOutPts = Long.MIN_VALUE
        var inputDone = false
        var used = 0L
        fun release() {
            try { codec?.stop() } catch (_: Exception) { }
            try { codec?.release() } catch (_: Exception) { }
            try { extractor?.release() } catch (_: Exception) { }
            codec = null; extractor = null; segmentStart = -1; lastOutPts = Long.MIN_VALUE; inputDone = false
        }
    }
    private val cursors = ArrayList<Cursor>()
    private var clock = 0L
    /** Decoded pictures by timestamp, bounded by bytes (shared by the cursors). */
    private val cache = object : LinkedHashMap<Long, Yuv.Planes>(32, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, Yuv.Planes>?): Boolean {
            var bytes = 0L
            for (v in values) bytes += (v.y.size + v.u.size + v.v.size) * 2L
            return size > 2 && bytes > 24L * 1048576
        }
    }
    var decodable = true; private set
    private var retriever: MediaMetadataRetriever? = null

    private fun openExtractor(): MediaExtractor {
        val p = pfd ?: (ctx.contentResolver.openFileDescriptor(file.uri, "r") ?: throw IllegalStateException("The video cannot be opened")).also { pfd = it }
        return MediaExtractor().apply { setDataSource(p.fileDescriptor) }
    }

    private fun index() {
        val ex = openExtractor()
        try {
            for (t in 0 until ex.trackCount) {
                val f = ex.getTrackFormat(t); val mime = f.getString(MediaFormat.KEY_MIME) ?: continue
                if (mime.startsWith("video/") && track < 0) { track = t; trackFormat = f }
                else if (mime.startsWith("audio/")) {
                    info.hasAudio = true
                    info.audio = "$mime, ${f.optInt(MediaFormat.KEY_SAMPLE_RATE)} Hz, ${f.optInt(MediaFormat.KEY_CHANNEL_COUNT)} ch"
                }
            }
            if (track < 0) throw IllegalArgumentException("The file contains no video stream")
            ex.selectTrack(track)
            val pts = ArrayList<Long>(4096); val fl = ArrayList<Int>(4096); val sz = ArrayList<Int>(4096)
            while (true) {
                val t = ex.sampleTime
                if (t < 0) break
                pts.add(t); fl.add(ex.sampleFlags); sz.add(ex.sampleSize.toInt())
                if (!ex.advance()) break
            }
            if (pts.isEmpty()) throw IllegalArgumentException("The video stream is empty")
            dPts = pts.toLongArray(); dFlags = fl.toIntArray(); dSize = sz.toIntArray()
            order = dPts.indices.sortedWith(compareBy({ dPts[it] }, { it })).toIntArray()
            rank = IntArray(order.size).also { r -> order.forEachIndexed { disp, dec -> r[dec] = disp } }
        } finally { ex.release() }
        val f = trackFormat
        val mime = f.getString(MediaFormat.KEY_MIME) ?: "video/?"
        val n = dPts.size
        info.frameCount = n
        info.width = f.optInt(MediaFormat.KEY_WIDTH); info.height = f.optInt(MediaFormat.KEY_HEIGHT)
        info.codec = mime.removePrefix("video/").uppercase().replace("AVC", "H.264 (AVC)").replace("HEVC", "H.265 (HEVC)")
        info.rotation = f.optInt(MediaFormat.KEY_ROTATION)
        val span = (dPts[order[n - 1]] - dPts[order[0]]) / 1e6
        val declared = if (f.containsKey(MediaFormat.KEY_FRAME_RATE)) (try { f.getInteger(MediaFormat.KEY_FRAME_RATE).toDouble() } catch (_: Exception) { f.getFloat(MediaFormat.KEY_FRAME_RATE).toDouble() }) else 0.0
        info.fps = if (n > 1 && span > 0) (n - 1) / span else if (declared > 0) declared else 25.0
        info.duration = if (f.containsKey(MediaFormat.KEY_DURATION)) f.getLong(MediaFormat.KEY_DURATION) / 1e6 else span
        if (n > 2) {
            var mn = Double.MAX_VALUE; var mx = 0.0
            for (k in 1 until n) { val d = (dPts[order[k]] - dPts[order[k - 1]]) / 1e6; if (d < mn) mn = d; if (d > mx) mx = d }
            val avg = span / (n - 1)
            if (mx - mn > avg * 0.05) info.vfr = "variable frame rate: %.3f–%.3f s between frames (average %.4f s)".format(mn, mx, avg)
        }
        colors = ColorFacts(f.optIntOrNull(MediaFormat.KEY_COLOR_STANDARD), f.optIntOrNull(MediaFormat.KEY_COLOR_RANGE), f.optIntOrNull(MediaFormat.KEY_COLOR_TRANSFER))
        types = CharArray(n) { if (dFlags[order[it]] and MediaExtractor.SAMPLE_FLAG_SYNC != 0) 'I' else '?' }
        info.frameTypesReady = false
        var bytes = 0L; for (s in dSize) bytes += max(0, s)
        if (info.duration > 0) info.bitrate = (bytes * 8 / info.duration).toLong()
        info.metadata.add("Samples indexed" to "$n (sync samples: ${dFlags.count { it and MediaExtractor.SAMPLE_FLAG_SYNC != 0 }})")
        try {
            MediaMetadataRetriever().use { r ->
                r.setDataSource(ctx, file.uri)
                listOf(MediaMetadataRetriever.METADATA_KEY_DATE to "Creation Date", MediaMetadataRetriever.METADATA_KEY_LOCATION to "Location", MediaMetadataRetriever.METADATA_KEY_MIMETYPE to "Container MIME",
                    MediaMetadataRetriever.METADATA_KEY_TITLE to "Title", MediaMetadataRetriever.METADATA_KEY_ARTIST to "Artist", MediaMetadataRetriever.METADATA_KEY_WRITER to "Writer",
                    MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE to "Capture Frame Rate", MediaMetadataRetriever.METADATA_KEY_BITRATE to "Declared Bitrate").forEach { (k, l) -> r.extractMetadata(k)?.takeIf { it.isNotBlank() }?.let { info.metadata.add(l to it) } }
                info.container = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE) ?: info.container
            }
        } catch (_: Exception) { }
    }

    private fun startCodec(cur: Cursor) {
        val f = MediaFormat.createVideoFormat(trackFormat.getString(MediaFormat.KEY_MIME)!!, trackFormat.optInt(MediaFormat.KEY_WIDTH), trackFormat.optInt(MediaFormat.KEY_HEIGHT))
        for (k in listOf("csd-0", "csd-1", "csd-2")) if (trackFormat.containsKey(k)) f.setByteBuffer(k, trackFormat.getByteBuffer(k))
        for (k in listOf(MediaFormat.KEY_PROFILE, MediaFormat.KEY_LEVEL, MediaFormat.KEY_COLOR_STANDARD, MediaFormat.KEY_COLOR_RANGE, MediaFormat.KEY_COLOR_TRANSFER)) trackFormat.optIntOrNull(k)?.let { f.setInteger(k, it) }
        f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
        val name = MediaCodecList(MediaCodecList.REGULAR_CODECS).findDecoderForFormat(f) ?: throw IllegalArgumentException("This device has no decoder for ${trackFormat.getString(MediaFormat.KEY_MIME)}")
        val c = MediaCodec.createByCodecName(name)
        try { c.configure(f, null, null, 0); c.start() } catch (e: Exception) { c.release(); throw e }
        cur.codec = c; codecName = name
        info.engine = "MediaCodec ($name) + ClearUFO YUV → RGB"
        if (cur.extractor == null) cur.extractor = MediaExtractor().apply { setDataSource(pfd!!.fileDescriptor); selectTrack(track) }
    }

    private fun releaseAll() { cursors.forEach { it.release() }; cursors.clear() }

    private fun syncBefore(dec: Int): Int { var s = dec; while (s > 0 && dFlags[s] and MediaExtractor.SAMPLE_FLAG_SYNC == 0) s--; return s }

    private fun canContinue(c: Cursor, s: Int, target: Long) = c.codec != null && c.segmentStart >= 0 && !c.inputDone && s >= c.segmentStart && s <= c.nextDecode && target > c.lastOutPts

    /** The cursor that reaches `target` soonest: one already positioned before it, else a new one, else the least recently used. */
    private fun cursorFor(s: Int, dec: Int, target: Long): Cursor {
        cursors.filter { canContinue(it, s, target) }.minByOrNull { kotlin.math.abs(dec - it.nextDecode) }?.let { return it }
        if (cursors.size < MAX_CURSORS) {
            val c = Cursor()
            try { startCodec(c); cursors.add(c); return c } catch (e: Exception) { c.release(); if (cursors.isEmpty()) throw e }
        }
        return cursors.minBy { it.used }
    }

    private fun decodeTo(targetDisp: Int): Yuv.Planes {
        val target = dPts[order[targetDisp]]
        cache[target]?.let { return it }
        val dec = order[targetDisp]
        val s = syncBefore(dec)
        val cur = cursorFor(s, dec, target)
        cur.used = ++clock
        if (cur.codec == null) startCodec(cur)
        val c = cur.codec!!; val ex = cur.extractor!!
        if (!canContinue(cur, s, target)) {
            c.flush()
            ex.seekTo(dPts[s], MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
            // the extractor lands on a sync sample at or before the wanted one: step forward to it
            if (ex.sampleTime > dPts[s] || ex.sampleTime < 0) ex.seekTo(0, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
            var guard = 0
            while (ex.sampleTime >= 0 && ex.sampleTime != dPts[s] && guard++ < 1_000_000) if (!ex.advance()) break
            if (ex.sampleTime != dPts[s]) throw IllegalStateException("Seeking to frame $targetDisp failed")
            cur.nextDecode = s; cur.segmentStart = s; cur.lastOutPts = Long.MIN_VALUE; cur.inputDone = false
        }
        val bi = MediaCodec.BufferInfo()
        var found: Yuv.Planes? = null
        var idle = 0
        try {
            while (found == null) {
                var progressed = false
                if (!cur.inputDone) {
                    val ib = c.dequeueInputBuffer(2000)
                    if (ib >= 0) {
                        val buf = c.getInputBuffer(ib)!!
                        val n = ex.readSampleData(buf, 0)
                        if (n < 0) { c.queueInputBuffer(ib, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); cur.inputDone = true }
                        else { c.queueInputBuffer(ib, 0, n, ex.sampleTime, 0); ex.advance(); cur.nextDecode++ }
                        progressed = true
                    }
                }
                val ob = c.dequeueOutputBuffer(bi, 2000)
                if (ob >= 0) {
                    progressed = true
                    if (bi.size > 0 || bi.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM == 0) {
                        c.getOutputImage(ob)?.let { img ->
                            val pl = copyImage(img); img.close()
                            cache[bi.presentationTimeUs] = pl
                            cur.lastOutPts = bi.presentationTimeUs
                            if (bi.presentationTimeUs == target) found = pl
                        }
                    }
                    c.releaseOutputBuffer(ob, false)
                    if (bi.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0 && found == null) {
                        cur.segmentStart = -1
                        throw IllegalStateException("Frame $targetDisp could not be decoded (the decoder returned no picture for it)")
                    }
                } else if (ob == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    val of = c.outputFormat
                    colors = ColorFacts(colors.standard ?: of.optIntOrNull(MediaFormat.KEY_COLOR_STANDARD), colors.range ?: of.optIntOrNull(MediaFormat.KEY_COLOR_RANGE), colors.transfer ?: of.optIntOrNull(MediaFormat.KEY_COLOR_TRANSFER))
                    progressed = true
                }
                if (!progressed && ++idle > 2500) throw IllegalStateException("The decoder stopped responding at frame $targetDisp")
                if (progressed) idle = 0
            }
        } catch (e: Exception) {
            // a decoder in an error state is replaced on the next request
            cur.release(); cursors.remove(cur)
            throw if (e is IllegalStateException) e else IllegalStateException(e.message ?: e.javaClass.simpleName, e)
        }
        return found!!
    }

    override suspend fun getFrame(i: Int, opts: DecodeOptions): Frame = withContext(Dispatchers.IO) {
        val idx = max(0, min(info.frameCount - 1, i))
        if (opts.engine == "media" || !decodable) return@withContext retrieverFrame(idx)
        val planes = lock.withLock { decodeTo(idx) }
        planesToFrame(planes, colors, opts, info)
    }

    private fun retrieverFrame(i: Int): Frame {
        val r = retriever ?: MediaMetadataRetriever().also { it.setDataSource(ctx, file.uri); retriever = it }
        val bmp = synchronized(r) { r.getFrameAtIndex(i, MediaMetadataRetriever.BitmapParams().apply { preferredConfig = Bitmap.Config.ARGB_8888 }) }
            ?: throw IllegalStateException("The platform retriever returned no picture for frame $i")
        info.conversion = "YUV → RGB by the Android platform (MediaMetadataRetriever): the loader's matrix, range and chroma options do not apply"
        return StillDecoder.bitmapToFrame(bmp).also { bmp.recycle() }
    }

    override fun meta(i: Int): FrameMeta {
        val idx = max(0, min(info.frameCount - 1, i))
        val dec = order[idx]
        val key = dFlags[dec] and MediaExtractor.SAMPLE_FLAG_SYNC != 0
        return FrameMeta(types?.get(idx) ?: if (key) 'I' else '?', dPts[dec] / 1e6, key, dSize[dec], idx)
    }

    /** Frame types (I/P/B) from the slice headers of every sample (H.264 and HEVC). */
    override suspend fun analyze(progress: (Double) -> Unit) = withContext(Dispatchers.IO) {
        val mime = trackFormat.getString(MediaFormat.KEY_MIME) ?: ""
        val parser = NalTypes.forMime(mime) ?: run { info.frameTypesReady = true; return@withContext }
        for (k in listOf("csd-0", "csd-1")) if (trackFormat.containsKey(k)) parser.feedConfig(trackFormat.getByteBuffer(k)!!.duplicate())
        val ex = MediaExtractor()
        val p = ctx.contentResolver.openFileDescriptor(file.uri, "r") ?: return@withContext
        try {
            ex.setDataSource(p.fileDescriptor); ex.selectTrack(track)
            val buf = ByteBuffer.allocate(max(1, dSize.maxOrNull() ?: 1) + 64)
            val t = types ?: CharArray(info.frameCount)
            var dec = 0
            while (dec < dPts.size) {
                buf.clear()
                val n = ex.readSampleData(buf, 0)
                if (n < 0) break
                val bytes = ByteArray(n); buf.position(0); buf.get(bytes, 0, n)
                parser.frameType(bytes)?.let { t[rank[dec]] = it }
                dec++
                if (dec % 200 == 0) progress(dec.toDouble() / dPts.size)
                if (!ex.advance()) break
            }
            types = t
        } finally { ex.release(); p.close() }
        info.frameTypesReady = true
        progress(1.0)
    }

    override fun dispose() {
        try { releaseAll(); pfd?.close(); retriever?.release() } catch (_: Exception) { }
    }

    companion object {
        /** Decoding positions kept per video (each one holds a hardware decoder). */
        const val MAX_CURSORS = 3

        suspend fun open(ctx: Context, id: String, f: EvidenceFile): VideoSource = withContext(Dispatchers.IO) {
            val info = SourceInfo(id, "video", f.name, f.size, 1, f.mime, container = f.name.substringAfterLast('.', "").uppercase())
            val v = VideoSource(ctx, info, f)
            v.index()
            try {
                // decode the first frame now: validates the decoder and gives the exact (cropped) picture size
                val p = v.lock.withLock { v.decodeTo(0) }
                info.width = p.w; info.height = p.h; info.bitDepth = p.bits
            } catch (e: Exception) {
                v.releaseAll()
                v.decodable = false
                info.engine = "Android platform frame retriever (MediaCodec could not decode this file: ${e.message})"
                MediaMetadataRetriever().use { r ->
                    r.setDataSource(ctx, f.uri)
                    r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT)?.toIntOrNull()?.let { info.frameCount = it }
                }
            }
            val c = v.colors
            info.colorMatrix = matrixName(c.standard)?.uppercase() ?: "not signaled"
            info.colorRange = when (c.range) { MediaFormat.COLOR_RANGE_FULL -> "full"; MediaFormat.COLOR_RANGE_LIMITED -> "limited"; else -> "not signaled (limited assumed)" }
            info.transfer = when (c.transfer) { MediaFormat.COLOR_TRANSFER_ST2084 -> "PQ (SMPTE ST 2084, HDR10)"; MediaFormat.COLOR_TRANSFER_HLG -> "HLG (ARIB STD-B67)"; MediaFormat.COLOR_TRANSFER_SDR_VIDEO -> "SDR (BT.709)"; else -> "not signaled" }
            v
        }
    }
}

fun MediaFormat.optInt(k: String): Int = try { if (containsKey(k)) getInteger(k) else 0 } catch (_: Exception) { 0 }
fun MediaFormat.optIntOrNull(k: String): Int? = try { if (containsKey(k)) getInteger(k) else null } catch (_: Exception) { null }

/** Frame type (I/P/B) from the first slice header of an access unit (Annex B or length-prefixed NAL units). */
abstract class NalTypes {
    abstract fun frameType(au: ByteArray): Char?
    open fun feedConfig(b: ByteBuffer) {}

    companion object {
        fun forMime(m: String): NalTypes? = when (m) { MediaFormat.MIMETYPE_VIDEO_AVC -> Avc(); MediaFormat.MIMETYPE_VIDEO_HEVC -> Hevc(); else -> null }

        /** NAL units of an access unit: Annex B start codes, else 4-byte length prefixes. */
        fun units(b: ByteArray): List<IntArray> {
            val out = ArrayList<IntArray>()
            val annexB = b.size > 4 && b[0].toInt() == 0 && b[1].toInt() == 0 && (b[2].toInt() == 1 || (b[2].toInt() == 0 && b[3].toInt() == 1))
            if (annexB) {
                var i = 0; var start = -1
                while (i + 2 < b.size) {
                    if (b[i].toInt() == 0 && b[i + 1].toInt() == 0 && b[i + 2].toInt() == 1) {
                        if (start >= 0) out.add(intArrayOf(start, trimEnd(b, start, i)))
                        start = i + 3; i += 3
                    } else i++
                }
                if (start >= 0) out.add(intArrayOf(start, b.size))
            } else {
                var p = 0
                while (p + 4 <= b.size) {
                    val n = ((b[p].toInt() and 255) shl 24) or ((b[p + 1].toInt() and 255) shl 16) or ((b[p + 2].toInt() and 255) shl 8) or (b[p + 3].toInt() and 255)
                    if (n <= 0 || p + 4 + n > b.size) break
                    out.add(intArrayOf(p + 4, p + 4 + n)); p += 4 + n
                }
            }
            return out
        }
        private fun trimEnd(b: ByteArray, s: Int, e0: Int): Int { var e = e0; while (e > s && b[e - 1].toInt() == 0) e--; return e }
    }

    /** Exp-Golomb bit reader over an RBSP (emulation prevention bytes removed). */
    class Bits(src: ByteArray, from: Int, to: Int) {
        private val d: ByteArray
        private var pos = 0
        init {
            val o = java.io.ByteArrayOutputStream(min(64, to - from)); var zeros = 0
            for (i in from until min(to, from + 64)) { val v = src[i].toInt() and 255; if (zeros >= 2 && v == 3) { zeros = 0; continue }; o.write(v); zeros = if (v == 0) zeros + 1 else 0 }
            d = o.toByteArray()
        }
        fun u(n: Int): Int { var v = 0; repeat(n) { val byte = d.getOrElse(pos shr 3) { 0 }.toInt(); v = (v shl 1) or ((byte shr (7 - (pos and 7))) and 1); pos++ }; return v }
        fun ue(): Int { var z = 0; while (u(1) == 0 && z < 32) z++; return if (z == 0) 0 else (1 shl z) - 1 + u(z) }
    }

    class Avc : NalTypes() {
        override fun frameType(au: ByteArray): Char? {
            for ((s, e) in units(au).map { it[0] to it[1] }) {
                val t = au[s].toInt() and 0x1f
                if (t == 5) return 'I'
                if (t == 1) {
                    val b = Bits(au, s + 1, e); b.ue()
                    return when (b.ue() % 5) { 0, 3 -> 'P'; 1 -> 'B'; else -> 'I' }
                }
            }
            return null
        }
    }

    class Hevc : NalTypes() {
        private val extraBits = HashMap<Int, Int>()
        override fun feedConfig(b: ByteBuffer) { val a = ByteArray(b.remaining()); b.get(a); scanPps(a) }
        private fun scanPps(a: ByteArray) {
            for ((s, e) in units(a).map { it[0] to it[1] }) if (((a[s].toInt() shr 1) and 0x3f) == 34) {
                val r = Bits(a, s + 2, e); val id = r.ue(); r.ue(); r.u(1); r.u(1); extraBits[id] = r.u(3)
            }
        }
        override fun frameType(au: ByteArray): Char? {
            scanPps(au)
            for ((s, e) in units(au).map { it[0] to it[1] }) {
                val t = (au[s].toInt() shr 1) and 0x3f
                if (t > 31) continue
                if (t in 16..23) return 'I'
                val r = Bits(au, s + 2, e)
                if (r.u(1) == 0) continue // not the first slice segment of the picture
                val pps = r.ue()
                r.u(extraBits[pps] ?: 0)
                return when (r.ue()) { 0 -> 'B'; 1 -> 'P'; else -> 'I' }
            }
            return null
        }
    }
}
