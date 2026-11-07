package com.clearufo.forensics.media

import android.content.Context
import android.graphics.BitmapFactory
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.ParcelFileDescriptor
import com.clearufo.forensics.engine.Frame
import com.clearufo.forensics.engine.FrameMeta
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import kotlin.math.max
import kotlin.math.min

// Files that Android's MediaExtractor does not open, typical of CCTV / DVR exports:
//  - AVI (RIFF, with OpenDML extensions): uncompressed RGB, Motion JPEG, H.264 / HEVC
//  - raw H.264 / HEVC elementary streams (.h264, .264, .h265, .265, .hevc)
// Compressed video is decoded with MediaCodec from the access units, in decode order; ClearUFO converts the YUV.

/** Positional reads of a content URI (no copy of the evidence). */
class RandomReader(ctx: Context, uri: android.net.Uri) : AutoCloseable {
    private val pfd: ParcelFileDescriptor = ctx.contentResolver.openFileDescriptor(uri, "r") ?: throw IllegalStateException("The file cannot be opened")
    private val ch: FileChannel = FileInputStream(pfd.fileDescriptor).channel
    val size: Long = ch.size()
    @Synchronized fun read(pos: Long, n: Int): ByteArray {
        val b = ByteBuffer.allocate(max(0, min(n.toLong(), size - pos).toInt()))
        var p = pos
        while (b.hasRemaining()) { val r = ch.read(b, p); if (r <= 0) break; p += r }
        return b.array()
    }
    override fun close() { try { ch.close(); pfd.close() } catch (_: Exception) { } }
}

class AccessUnit(val pos: Long, val size: Int, var key: Boolean)

/** Decodes access units of an H.264 / HEVC stream with MediaCodec; frame i is the i-th picture in output order. */
class AnnexBDecoder(private val mime: String, private val units: List<AccessUnit>, private val reader: RandomReader, private val fps: Double) {
    private var codec: MediaCodec? = null
    private var segmentStart = -1
    private var nextFeed = 0
    private var nextOut = 0
    private var inputDone = false
    val cache = object : LinkedHashMap<Int, Yuv.Planes>(16, 0.75f, true) { override fun removeEldestEntry(e: MutableMap.MutableEntry<Int, Yuv.Planes>?) = size > 8 }
    var colors = ColorFacts(); private set
    var name = ""; private set

    private fun start() {
        // parameter sets of the first key unit as codec specific data
        val first = units.firstOrNull { it.key } ?: units.first()
        val au = reader.read(first.pos, first.size)
        val f = MediaFormat.createVideoFormat(mime, 1920, 1080)
        val ps = java.io.ByteArrayOutputStream()
        for (u in NalTypes.units(au)) {
            val t = if (mime == MediaFormat.MIMETYPE_VIDEO_AVC) au[u[0]].toInt() and 0x1f else (au[u[0]].toInt() shr 1) and 0x3f
            val isPs = if (mime == MediaFormat.MIMETYPE_VIDEO_AVC) t == 7 || t == 8 else t in 32..34
            if (isPs) { ps.write(byteArrayOf(0, 0, 0, 1)); ps.write(au, u[0], u[1] - u[0]) }
        }
        if (ps.size() > 0) f.setByteBuffer("csd-0", ByteBuffer.wrap(ps.toByteArray()))
        f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
        f.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, max(1 shl 20, units.maxOf { it.size } + 1024))
        name = MediaCodecList(MediaCodecList.REGULAR_CODECS).findDecoderForFormat(f) ?: throw IllegalArgumentException("This device has no decoder for $mime")
        codec = MediaCodec.createByCodecName(name).apply { configure(f, null, null, 0); start() }
    }

    fun release() { try { codec?.stop(); codec?.release() } catch (_: Exception) { }; codec = null; segmentStart = -1 }

    fun decode(target: Int): Yuv.Planes {
        cache[target]?.let { return it }
        if (codec == null) start()
        val c = codec!!
        var s = target; while (s > 0 && !units[s].key) s--
        if (!(segmentStart >= 0 && !inputDone && s >= segmentStart && s <= nextFeed && target >= nextOut)) {
            c.flush(); segmentStart = s; nextFeed = s; nextOut = s; inputDone = false
        }
        val bi = MediaCodec.BufferInfo()
        var idle = 0
        while (true) {
            var progressed = false
            if (!inputDone) {
                val ib = c.dequeueInputBuffer(2000)
                if (ib >= 0) {
                    if (nextFeed >= units.size) { c.queueInputBuffer(ib, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputDone = true }
                    else {
                        val u = units[nextFeed]; val data = reader.read(u.pos, u.size)
                        val buf = c.getInputBuffer(ib)!!; buf.clear(); buf.put(data, 0, min(data.size, buf.remaining()))
                        c.queueInputBuffer(ib, 0, min(data.size, buf.capacity()), (nextFeed * 1e6 / fps).toLong(), if (u.key) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
                        nextFeed++
                    }
                    progressed = true
                }
            }
            val ob = c.dequeueOutputBuffer(bi, 2000)
            if (ob >= 0) {
                progressed = true
                var got: Yuv.Planes? = null
                c.getOutputImage(ob)?.let { img -> val p = copyImage(img); img.close(); cache[nextOut] = p; if (nextOut == target) got = p; nextOut++ }
                c.releaseOutputBuffer(ob, false)
                if (got != null) return got!!
                if (bi.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) { segmentStart = -1; throw IllegalStateException("Frame $target could not be decoded") }
            } else if (ob == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                val of = c.outputFormat
                colors = ColorFacts(of.optIntOrNull(MediaFormat.KEY_COLOR_STANDARD), of.optIntOrNull(MediaFormat.KEY_COLOR_RANGE), of.optIntOrNull(MediaFormat.KEY_COLOR_TRANSFER))
                progressed = true
            }
            if (!progressed && ++idle > 2500) { release(); throw IllegalStateException("The decoder stopped responding at frame $target") }
            if (progressed) idle = 0
        }
    }
}

/** AVI and raw elementary streams. */
class StreamSource private constructor(private val ctx: Context, override val info: SourceInfo, private val reader: RandomReader) : SourceProvider {
    private var units: List<AccessUnit> = emptyList()
    private var kind = "" // rgb24 | rgb32 | mjpeg | avc | hevc
    private var bottomUp = true
    private var decoder: AnnexBDecoder? = null
    private val lock = Mutex()
    private var types: CharArray? = null

    override suspend fun getFrame(i: Int, opts: DecodeOptions): Frame = withContext(Dispatchers.IO) {
        val idx = max(0, min(units.size - 1, i))
        when (kind) {
            "rgb24", "rgb32" -> rgbFrame(reader.read(units[idx].pos, units[idx].size))
            "mjpeg" -> {
                val b = reader.read(units[idx].pos, units[idx].size)
                val bmp = BitmapFactory.decodeByteArray(b, 0, b.size, BitmapFactory.Options().apply { inPremultiplied = false })
                    ?: throw IllegalStateException("Motion JPEG frame $idx cannot be decoded")
                StillDecoder.bitmapToFrame(bmp).also { bmp.recycle() }
            }
            else -> {
                val d = decoder!!
                val p = lock.withLock { d.decode(idx) }
                planesToFrame(p, d.colors, opts, info)
            }
        }
    }

    private fun rgbFrame(b: ByteArray): Frame {
        val w = info.width; val h = info.height
        val bpp = if (kind == "rgb32") 4 else 3
        val row = (w * bpp + 3) and 3.inv()
        val f = Frame.alloc(w, h, true)
        for (y in 0 until h) {
            val sy = if (bottomUp) h - 1 - y else y
            for (x in 0 until w) {
                val s = sy * row + x * bpp; val o = (y * w + x) * 4
                if (s + 2 >= b.size) continue
                f.d[o] = (b[s + 2].toInt() and 255).toFloat(); f.d[o + 1] = (b[s + 1].toInt() and 255).toFloat(); f.d[o + 2] = (b[s].toInt() and 255).toFloat()
            }
        }
        return f
    }

    override fun meta(i: Int): FrameMeta {
        val u = units[max(0, min(units.size - 1, i))]
        return FrameMeta(types?.getOrNull(i) ?: if (u.key) 'I' else '?', i / info.fps, u.key, u.size, i)
    }

    override suspend fun analyze(progress: (Double) -> Unit) = withContext(Dispatchers.IO) {
        val parser = when (kind) { "avc" -> NalTypes.Avc(); "hevc" -> NalTypes.Hevc(); else -> null }
        if (parser != null) {
            val t = CharArray(units.size) { '?' }
            units.forEachIndexed { k, u -> parser.frameType(reader.read(u.pos, min(u.size, 1 shl 16)))?.let { t[k] = it }; if (k % 200 == 0) progress(k.toDouble() / units.size) }
            types = t
        }
        info.frameTypesReady = true
    }

    override fun dispose() { decoder?.release(); reader.close() }

    companion object {
        val RAW_EXT = setOf("h264", "264", "avc", "h265", "265", "hevc", "hvc")

        fun isAvi(head: ByteArray) = head.size >= 12 && String(head, 0, 4, Charsets.ISO_8859_1) == "RIFF" && String(head, 8, 4, Charsets.ISO_8859_1).startsWith("AVI")
        fun isRaw(name: String, head: ByteArray) = name.substringAfterLast('.', "").lowercase() in RAW_EXT ||
            (head.size > 5 && head[0].toInt() == 0 && head[1].toInt() == 0 && (head[2].toInt() == 1 || (head[2].toInt() == 0 && head[3].toInt() == 1)))

        suspend fun open(ctx: Context, id: String, f: EvidenceFile, head: ByteArray): StreamSource = withContext(Dispatchers.IO) {
            val r = RandomReader(ctx, f.uri)
            val info = SourceInfo(id, "video", f.name, r.size, 1, f.mime)
            val s = StreamSource(ctx, info, r)
            try {
                if (isAvi(head)) s.parseAvi() else s.parseRaw(f.name)
                if (s.units.isEmpty()) throw IllegalArgumentException("No video frames were found in the file")
                info.frameCount = s.units.size
                info.duration = s.units.size / info.fps
                if (s.kind == "avc" || s.kind == "hevc") {
                    val mime = if (s.kind == "avc") MediaFormat.MIMETYPE_VIDEO_AVC else MediaFormat.MIMETYPE_VIDEO_HEVC
                    val d = AnnexBDecoder(mime, s.units, r, info.fps)
                    s.decoder = d
                    val p = d.decode(0)
                    info.width = p.w; info.height = p.h; info.bitDepth = p.bits
                    info.engine = "MediaCodec (${d.name}) + ClearUFO YUV → RGB"
                    info.frameTypesReady = false
                } else info.engine = if (s.kind == "mjpeg") "Android platform JPEG decoder (Motion JPEG)" else "ClearUFO (uncompressed RGB, exact)"
                info.metadata.add("Frames indexed" to "${s.units.size} (key frames: ${s.units.count { it.key }})")
            } catch (e: Exception) { s.dispose(); throw e }
            s
        }
    }

    private fun parseAvi() {
        info.container = "AVI (RIFF)"
        var vidStream = -1; var handler = ""; var compression = ""; var bits = 24
        var scale = 1; var rate = 25; var usPerFrame = 0
        val chunks = ArrayList<AccessUnit>()
        val idxFlags = HashMap<Long, Boolean>()
        var moviStart = -1L
        var streamCount = 0
        fun le32(b: ByteArray, p: Int) = ByteBuffer.wrap(b, p, 4).order(ByteOrder.LITTLE_ENDIAN).int
        fun walk(start: Long, end: Long, depth: Int) {
            var p = start
            while (p + 8 <= end && p + 8 <= reader.size) {
                val hdr = reader.read(p, 12)
                if (hdr.size < 8) break
                val id = String(hdr, 0, 4, Charsets.ISO_8859_1)
                val size = le32(hdr, 4).toLong() and 0xffffffffL
                val data = p + 8
                when {
                    id == "RIFF" || id == "LIST" -> {
                        val type = String(hdr, 8, 4, Charsets.ISO_8859_1)
                        if (type == "movi") moviStart = data
                        if (type == "strl") streamCount++
                        if (depth < 6) walk(data + 4, min(end, data + size), depth + 1)
                    }
                    id == "avih" -> { val b = reader.read(data, 56); usPerFrame = le32(b, 0); info.width = le32(b, 32); info.height = le32(b, 36) }
                    id == "strh" -> {
                        val b = reader.read(data, 40)
                        if (String(b, 0, 4, Charsets.ISO_8859_1) == "vids" && vidStream < 0) { vidStream = streamCount - 1; handler = String(b, 4, 4, Charsets.ISO_8859_1); scale = max(1, le32(b, 20)); rate = max(1, le32(b, 24)) }
                    }
                    id == "strf" && vidStream == streamCount - 1 && compression.isEmpty() -> {
                        val b = reader.read(data, 40)
                        info.width = le32(b, 4); val hh = le32(b, 8); bottomUp = hh > 0; info.height = kotlin.math.abs(hh)
                        bits = ByteBuffer.wrap(b, 14, 2).order(ByteOrder.LITTLE_ENDIAN).short.toInt()
                        val c = le32(b, 16); compression = if (c == 0) "RGB " else String(b, 16, 4, Charsets.ISO_8859_1)
                    }
                    id == "idx1" -> {
                        val n = (size / 16).toInt()
                        val b = reader.read(data, min(size, 256L * 1024 * 1024).toInt())
                        for (k in 0 until min(n, b.size / 16)) { val o = k * 16; idxFlags[le32(b, o + 8).toLong() and 0xffffffffL] = (le32(b, o + 4) and 0x10) != 0 }
                    }
                    vidStream >= 0 && id.length == 4 && id.substring(0, 2) == "%02d".format(vidStream) && (id.endsWith("dc") || id.endsWith("db")) && size > 0 ->
                        chunks.add(AccessUnit(data, size.toInt(), true))
                }
                p = data + size + (size and 1)
            }
        }
        walk(0, reader.size, 0)
        info.fps = if (rate > 0 && scale > 0) rate.toDouble() / scale else if (usPerFrame > 0) 1e6 / usPerFrame else 25.0
        val fourcc = compression.trim().uppercase().ifEmpty { handler.trim().uppercase() }
        kind = when {
            fourcc == "RGB" || fourcc == "DIB" || fourcc.isEmpty() -> if (bits == 32) "rgb32" else "rgb24"
            fourcc in setOf("MJPG", "AVRN", "LJPG", "JPEG", "DMB1") -> "mjpeg"
            fourcc in setOf("H264", "X264", "AVC1", "DAVC", "VSSH", "H.264") -> "avc"
            fourcc in setOf("HEVC", "H265", "HVC1", "HEV1", "X265") -> "hevc"
            else -> throw IllegalArgumentException("AVI with \"$fourcc\" video is not supported")
        }
        info.codec = when (kind) { "rgb24", "rgb32" -> "Uncompressed RGB ($bits-bit)"; "mjpeg" -> "Motion JPEG"; "avc" -> "H.264 (AVC)"; else -> "H.265 (HEVC)" }
        if ((kind == "avc" || kind == "hevc")) {
            if (idxFlags.isNotEmpty() && moviStart > 0) for (c in chunks) { idxFlags[c.pos - 8 - moviStart]?.let { c.key = it } ?: idxFlags[c.pos - 8]?.let { c.key = it } }
            else for (c in chunks) c.key = isKeyUnit(reader.read(c.pos, min(c.size, 4096)), kind == "avc")
            if (chunks.none { it.key }) for (c in chunks) c.key = isKeyUnit(reader.read(c.pos, min(c.size, 4096)), kind == "avc")
        }
        units = chunks
    }

    private fun isKeyUnit(b: ByteArray, avc: Boolean): Boolean = NalTypes.units(b).any { u ->
        if (avc) (b[u[0]].toInt() and 0x1f).let { it == 5 || it == 7 } else ((b[u[0]].toInt() shr 1) and 0x3f).let { it in 16..23 || it == 32 || it == 33 }
    }

    /** Raw Annex B stream: splits it into access units at each new picture (AUD, or the first slice of a picture). */
    private fun parseRaw(name: String) {
        val ext = name.substringAfterLast('.', "").lowercase()
        var hevc = ext in setOf("h265", "265", "hevc", "hvc")
        // sniff: an HEVC VPS (type 32) near the start decides when the extension does not
        val head = reader.read(0, 4096)
        if (ext !in RAW_EXT) hevc = NalTypes.units(head).any { ((head[it[0]].toInt() shr 1) and 0x3f) == 32 }
        kind = if (hevc) "hevc" else "avc"
        info.container = "Raw ${if (hevc) "HEVC" else "H.264"} elementary stream (Annex B)"
        info.codec = if (hevc) "H.265 (HEVC)" else "H.264 (AVC)"
        info.fps = 25.0
        info.metadata.add("Frame rate" to "not stored in raw streams: 25 fps assumed (use Change Frame Rate to set the real rate)")
        val out = ArrayList<AccessUnit>()
        var auStart = -1L; var auKey = false; var seenVcl = false
        val chunk = 4 shl 20
        var base = 0L
        var zeros = 0
        var pendingNal = -1L
        fun nalAt(pos: Long) {
            val h = reader.read(pos, 3)
            if (h.size < 2) return
            val t = if (hevc) (h[0].toInt() shr 1) and 0x3f else h[0].toInt() and 0x1f
            val vcl = if (hevc) t <= 31 else t in 1..5
            val firstSlice = if (hevc) vcl && (h[2].toInt() and 0x80) != 0 else vcl && (h[1].toInt() and 0x80) != 0
            val aud = if (hevc) t == 35 else t == 9
            val ps = if (hevc) t in 32..34 else t == 7 || t == 8
            val newAu = aud || (firstSlice && seenVcl) || (ps && seenVcl)
            val start = pos - 3
            if (newAu || auStart < 0) {
                if (auStart >= 0) out.add(AccessUnit(auStart, (start - auStart).toInt(), auKey))
                auStart = start; auKey = false; seenVcl = false
            }
            if (vcl) seenVcl = true
            if (if (hevc) t in 16..23 else t == 5) auKey = true
        }
        while (base < reader.size) {
            val b = reader.read(base, chunk)
            if (b.isEmpty()) break
            for (i in b.indices) {
                val v = b[i].toInt()
                if (v == 1 && zeros >= 2) pendingNal = base + i + 1
                zeros = if (v == 0) zeros + 1 else 0
                if (pendingNal >= 0 && base + i + 1 > pendingNal + 2) { nalAt(pendingNal); pendingNal = -1 }
            }
            base += b.size
        }
        if (pendingNal >= 0) nalAt(pendingNal)
        if (auStart >= 0) out.add(AccessUnit(auStart, (reader.size - auStart).toInt(), auKey))
        units = out.filter { it.size > 4 }
    }
}
