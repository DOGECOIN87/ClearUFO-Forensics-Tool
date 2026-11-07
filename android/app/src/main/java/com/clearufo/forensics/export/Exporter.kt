package com.clearufo.forensics.export

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import com.clearufo.forensics.engine.Frame
import com.clearufo.forensics.engine.Stream
import com.clearufo.forensics.engine.WriteFormats
import com.clearufo.forensics.engine.to8
import com.clearufo.forensics.engine.toArgb
import com.clearufo.forensics.media.BmpCodec
import com.clearufo.forensics.media.Files
import com.clearufo.forensics.media.PngCodec
import com.clearufo.forensics.media.TiffCodec
import com.clearufo.forensics.media.to16
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.FileOutputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import java.security.MessageDigest
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import kotlin.coroutines.coroutineContext
import kotlin.math.max
import kotlin.math.min

data class WriteResult(val uri: Uri, val name: String, val format: String, val frames: Int, val bytes: Long, val md5: String, val sha256: String, val verified: String)

/**
 * Exports. Lossless formats are verified after writing: the file is read back from storage, decoded, and every sample
 * is compared with the samples that were meant to be written (8-bit level, 16-bit level × 257, or the 32-bit float).
 */
object Exporter {
    fun encodeImage(f: Frame, format: String, quality: Double): ByteArray = when (format) {
        "png16" -> PngCodec.encode(f, true)
        "png" -> PngCodec.encode(f, false)
        "tiff16" -> TiffCodec.encode(f, 2)
        "tiff" -> TiffCodec.encode(f, 1)
        "tiff32f" -> TiffCodec.encode(f, 4)
        "bmp" -> BmpCodec.encode(f)
        "jpeg", "webp" -> {
            val bmp = Bitmap.createBitmap(f.toArgb(), f.w, f.h, Bitmap.Config.ARGB_8888)
            val o = ByteArrayOutputStream()
            @Suppress("DEPRECATION") val fmt = if (format == "jpeg") Bitmap.CompressFormat.JPEG else Bitmap.CompressFormat.WEBP_LOSSY
            bmp.compress(fmt, (quality * 100).toInt().coerceIn(1, 100), o); bmp.recycle()
            o.toByteArray()
        }
        else -> throw IllegalArgumentException("Unknown image format $format")
    }

    /** Samples as written (for verification): 8-bit, 16-bit or float per R, G, B. */
    private fun expected(f: Frame, format: String): DoubleArray = DoubleArray(f.w * f.h * 3) { k ->
        val v = f.d[(k / 3) * 4 + k % 3]
        when (format) { "png16", "tiff16" -> to16(v).toDouble(); "tiff32f" -> (v / 255f).toDouble(); else -> to8(v).toDouble() }
    }

    private fun decodedSamples(bytes: ByteArray, format: String): DoubleArray {
        if (format.startsWith("tiff")) return TiffCodec.rawSamples(bytes)
        val img = when (format) {
            "png", "png16" -> PngCodec.decode(bytes)
            "bmp" -> null
            else -> return DoubleArray(0)
        }
        if (img == null) { // BMP: bottom-up BGR rows
            val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            val off = bb.getInt(10); val w = bb.getInt(18); val h = bb.getInt(22); val row = (w * 3 + 3) and 3.inv()
            return DoubleArray(w * h * 3) { k -> val px = k / 3; val c = k % 3; val y = px / w; val x = px % w; (bytes[off + (h - 1 - y) * row + x * 3 + (2 - c)].toInt() and 255).toDouble() }
        }
        val f = img.frame
        return DoubleArray(f.w * f.h * 3) { k ->
            val v = f.d[(k / 3) * 4 + k % 3].toDouble()
            if (format == "png16") Math.round(v * 257).toDouble() else v
        }
    }

    private fun sameSamples(a: DoubleArray, b: DoubleArray, float: Boolean): Boolean {
        if (a.size != b.size) return false
        for (i in a.indices) if (if (float) a[i].toFloat() != b[i].toFloat() else a[i] != b[i]) return false
        return true
    }

    private fun hashes(ctx: Context, uri: Uri) = Files.hash(ctx, uri)

    /** Writes frames [start, end] of a stream to `uri`. */
    suspend fun write(ctx: Context, stream: Stream, uri: Uri, name: String, format: String, start: Int, end: Int, fps0: Double, quality: Double, progress: (Double) -> Unit): WriteResult = withContext(Dispatchers.Default) {
        val fi = WriteFormats.of(format) ?: throw IllegalArgumentException("Unknown format $format")
        val count = end - start + 1
        val fps = if (fps0 > 0) fps0 else stream.info.fps.takeIf { it > 0 } ?: 25.0
        var verified = "not applicable (lossy format)"
        when {
            format == "avi-raw" || format == "avi-mjpeg" -> {
                val digests = AviWriter.write(ctx, stream, uri, start, end, fps, format == "avi-mjpeg", quality, progress)
                if (format == "avi-raw") { progress(0.99); verified = AviWriter.verify(ctx, uri, digests) }
            }
            format == "mp4" || format == "webm" -> VideoEncoder.write(ctx, stream, uri, start, end, fps, format == "webm", quality, progress)
            count == 1 -> {
                val f = stream.getFrame(start)
                val bytes = encodeImage(f, format, quality)
                ctx.contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) } ?: throw IllegalStateException("The destination cannot be written")
                if (!fi.lossy) {
                    val back = Files.readAll(ctx, uri)
                    verified = if (sameSamples(expected(f, format), decodedSamples(back, format), format == "tiff32f")) "verified: the file was read back and all ${f.w * f.h * 3} samples match" else throw IllegalStateException("Verification failed: the file read back differs from the processed frame")
                }
                progress(1.0)
            }
            else -> {
                // image sequence: numbered files in one ZIP archive, stored (no compression)
                val last = end
                val digests = ArrayList<String>()
                ctx.contentResolver.openOutputStream(uri, "wt")?.use { os ->
                    ZipOutputStream(os.buffered(1 shl 20)).use { zip ->
                        zip.setMethod(ZipOutputStream.STORED)
                        for (i in start..end) {
                            coroutineContext.ensureActive()
                            val f = stream.getFrame(i)
                            val bytes = encodeImage(f, format, quality)
                            val e = ZipEntry(WriteFormats.sequenceName(WriteFormats.sanitizeName(name), i, last, fi.ext))
                            val crc = CRC32(); crc.update(bytes)
                            e.method = ZipEntry.STORED; e.size = bytes.size.toLong(); e.compressedSize = bytes.size.toLong(); e.crc = crc.value
                            zip.putNextEntry(e); zip.write(bytes); zip.closeEntry()
                            if (!fi.lossy) digests.add(md5(expected(f, format)))
                            progress((i - start + 1).toDouble() / count * 0.95)
                        }
                    }
                } ?: throw IllegalStateException("The destination cannot be written")
                if (!fi.lossy) {
                    var k = 0
                    ctx.contentResolver.openInputStream(uri)?.use { ins -> ZipInputStream(ins.buffered(1 shl 20)).use { z ->
                        while (true) { z.nextEntry ?: break; val b = z.readBytes(); if (md5(decodedSamples(b, format)) != digests.getOrNull(k)) throw IllegalStateException("Verification failed at image ${k + 1} of the archive"); k++ }
                    } }
                    if (k != count) throw IllegalStateException("Verification failed: the archive holds $k of $count images")
                    verified = "verified: the archive was read back and all $count images match sample for sample"
                }
            }
        }
        progress(1.0)
        val h = hashes(ctx, uri)
        WriteResult(uri, name, format, count, h.bytes, h.md5, h.sha256, verified)
    }

    fun md5(samples: DoubleArray): String {
        val m = MessageDigest.getInstance("MD5"); val bb = ByteBuffer.allocate(8)
        for (v in samples) { bb.clear(); bb.putDouble(v); m.update(bb.array()) }
        return Files.hex(m.digest())
    }
}

// ---------------------------------------------------------------- AVI (RIFF), uncompressed BGR 24-bit or Motion JPEG
object AviWriter {
    private class Out(val ch: FileChannel) {
        fun put(b: ByteBuffer) { b.flip(); while (b.hasRemaining()) ch.write(b) }
        fun at(pos: Long, b: ByteBuffer) { b.flip(); var p = pos; while (b.hasRemaining()) p += ch.write(b, p) }
    }

    private fun le(n: Int) = ByteBuffer.allocate(n).order(ByteOrder.LITTLE_ENDIAN)
    private fun fourcc(b: ByteBuffer, s: String) { for (c in s) b.put(c.code.toByte()) }

    /** Returns the MD5 of each frame's stored BGR bytes (raw) for the verification read-back. */
    suspend fun write(ctx: Context, stream: Stream, uri: Uri, start: Int, end: Int, fps: Double, mjpeg: Boolean, quality: Double, progress: (Double) -> Unit): List<String> {
        val w = stream.info.width; val h = stream.info.height; val n = end - start + 1
        val row = (w * 3 + 3) and 3.inv(); val frameBytes = row * h
        if (!mjpeg && (frameBytes.toLong() + 8) * n > 0xFFFF0000L - 4096) throw IllegalStateException("The uncompressed AVI would exceed 4 GB: choose a TIFF/PNG sequence or a shorter range")
        val pfd = ctx.contentResolver.openFileDescriptor(uri, "rw") ?: throw IllegalStateException("The destination cannot be written")
        val digests = ArrayList<String>()
        pfd.use {
            val ch = FileOutputStream(it.fileDescriptor).channel
            ch.truncate(0)
            val o = Out(ch)
            val scale = 1000; val rate = Math.round(fps * 1000).toInt()
            // header (sizes patched at the end)
            val hdr = le(8 + 4 + 8 + 4 + 8 + 56 + 8 + 4 + 8 + 56 + 8 + 40 + 8 + 4)
            fourcc(hdr, "RIFF"); hdr.putInt(0); fourcc(hdr, "AVI ")
            fourcc(hdr, "LIST"); hdr.putInt(4 + 8 + 56 + 8 + 4 + 8 + 56 + 8 + 40); fourcc(hdr, "hdrl")
            fourcc(hdr, "avih"); hdr.putInt(56)
            hdr.putInt(Math.round(1e6 / fps).toInt()); hdr.putInt(0); hdr.putInt(0); hdr.putInt(0x10) // AVIF_HASINDEX
            hdr.putInt(n); hdr.putInt(0); hdr.putInt(1); hdr.putInt(if (mjpeg) 0 else frameBytes); hdr.putInt(w); hdr.putInt(h); repeat(4) { hdr.putInt(0) }
            fourcc(hdr, "LIST"); hdr.putInt(4 + 8 + 56 + 8 + 40); fourcc(hdr, "strl")
            fourcc(hdr, "strh"); hdr.putInt(56); fourcc(hdr, "vids"); fourcc(hdr, if (mjpeg) "MJPG" else "DIB ")
            hdr.putInt(0); hdr.putShort(0); hdr.putShort(0); hdr.putInt(0); hdr.putInt(scale); hdr.putInt(rate); hdr.putInt(0); hdr.putInt(n)
            hdr.putInt(if (mjpeg) 0 else frameBytes); hdr.putInt(-1); hdr.putInt(0); hdr.putShort(0); hdr.putShort(0); hdr.putShort(w.toShort()); hdr.putShort(h.toShort())
            fourcc(hdr, "strf"); hdr.putInt(40)
            hdr.putInt(40); hdr.putInt(w); hdr.putInt(h); hdr.putShort(1); hdr.putShort(24)
            if (mjpeg) fourcc(hdr, "MJPG") else hdr.putInt(0)
            hdr.putInt(if (mjpeg) w * h * 3 else frameBytes); hdr.putInt(0); hdr.putInt(0); hdr.putInt(0); hdr.putInt(0)
            fourcc(hdr, "LIST"); val moviSizePos = hdr.position().toLong(); hdr.putInt(0); fourcc(hdr, "movi")
            o.put(hdr)
            val moviStart = moviSizePos + 4 // position of "movi"
            var pos = moviStart + 4
            val index = ArrayList<Pair<Long, Int>>()
            val buf = ByteArray(frameBytes)
            for (i in start..end) {
                kotlin.coroutines.coroutineContext.ensureActive()
                val f = stream.getFrame(i)
                val data: ByteArray = if (mjpeg) Exporter.encodeImage(f, "jpeg", quality) else {
                    java.util.Arrays.fill(buf, 0)
                    for (y in 0 until h) { val dy = h - 1 - y; for (x in 0 until w) { val k = (y * w + x) * 4; val q = dy * row + x * 3; buf[q] = to8(f.d[k + 2]).toByte(); buf[q + 1] = to8(f.d[k + 1]).toByte(); buf[q + 2] = to8(f.d[k]).toByte() } }
                    digests.add(Files.hex(MessageDigest.getInstance("MD5").digest(buf)))
                    buf
                }
                val c = le(8); fourcc(c, if (mjpeg) "00dc" else "00db"); c.putInt(data.size); o.put(c)
                index.add((pos - moviStart) to data.size)
                ch.write(ByteBuffer.wrap(data))
                pos += 8 + data.size
                if (data.size and 1 == 1) { ch.write(ByteBuffer.wrap(byteArrayOf(0))); pos++ }
                progress((i - start + 1).toDouble() / n * 0.95)
            }
            val moviSize = pos - moviStart
            val idx = le(8 + index.size * 16); fourcc(idx, "idx1"); idx.putInt(index.size * 16)
            for ((off, size) in index) { fourcc(idx, if (mjpeg) "00dc" else "00db"); idx.putInt(0x10); idx.putInt(off.toInt()); idx.putInt(size) }
            o.put(idx)
            val total = pos + 8 + index.size * 16
            o.at(4, le(4).putInt((total - 8).toInt()))
            o.at(moviSizePos, le(4).putInt(moviSize.toInt()))
            ch.force(true)
        }
        return digests
    }

    /** Reads the AVI back and compares the MD5 of every stored frame with the frames that were written. */
    fun verify(ctx: Context, uri: Uri, digests: List<String>): String {
        val r = com.clearufo.forensics.media.RandomReader(ctx, uri)
        r.use {
            var p = 12L; var k = 0
            fun walk(s: Long, e: Long) {
                var q = s
                while (q + 8 <= e) {
                    val h = r.read(q, 12); val id = String(h, 0, 4, Charsets.ISO_8859_1); val size = ByteBuffer.wrap(h, 4, 4).order(ByteOrder.LITTLE_ENDIAN).int.toLong() and 0xffffffffL
                    if (id == "LIST") walk(q + 12, q + 8 + size)
                    else if (id == "00db") {
                        val d = Files.hex(MessageDigest.getInstance("MD5").digest(r.read(q + 8, size.toInt())))
                        if (d != digests.getOrNull(k)) throw IllegalStateException("Verification failed at frame ${k + 1} of the AVI")
                        k++
                    }
                    q += 8 + size + (size and 1)
                }
            }
            walk(p, r.size); p = 0
            if (k != digests.size) throw IllegalStateException("Verification failed: the AVI holds $k of ${digests.size} frames")
            return "verified: the AVI was read back and all $k frames match byte for byte"
        }
    }
}

// ---------------------------------------------------------------- MP4 / WebM with the hardware encoders
object VideoEncoder {
    suspend fun write(ctx: Context, stream: Stream, uri: Uri, start: Int, end: Int, fps: Double, webm: Boolean, quality: Double, progress: (Double) -> Unit) {
        val w = stream.info.width and 1.inv(); val h = stream.info.height and 1.inv()
        if (w < 2 || h < 2) throw IllegalStateException("The frames are too small to encode")
        val list = MediaCodecList(MediaCodecList.REGULAR_CODECS)
        val mimes = if (webm) listOf(MediaFormat.MIMETYPE_VIDEO_VP9, MediaFormat.MIMETYPE_VIDEO_VP8) else listOf(MediaFormat.MIMETYPE_VIDEO_AVC, MediaFormat.MIMETYPE_VIDEO_HEVC)
        var fmt: MediaFormat? = null; var name: String? = null
        for (m in mimes) {
            val f = MediaFormat.createVideoFormat(m, w, h).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
                setInteger(MediaFormat.KEY_BIT_RATE, max(200_000, (w.toDouble() * h * fps * (0.05 + quality.coerceIn(0.0, 1.0) * 0.35)).toInt()))
                setFloat(MediaFormat.KEY_FRAME_RATE, fps.toFloat())
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
                setInteger(MediaFormat.KEY_COLOR_STANDARD, MediaFormat.COLOR_STANDARD_BT709)
                setInteger(MediaFormat.KEY_COLOR_RANGE, MediaFormat.COLOR_RANGE_LIMITED)
                setInteger(MediaFormat.KEY_COLOR_TRANSFER, MediaFormat.COLOR_TRANSFER_SDR_VIDEO)
            }
            list.findEncoderForFormat(f)?.let { fmt = f; name = it }
            if (name != null) break
        }
        if (name == null) throw IllegalStateException("This device has no ${if (webm) "VP9/VP8" else "H.264/HEVC"} encoder for ${w}x$h")
        val pfd = ctx.contentResolver.openFileDescriptor(uri, "rw") ?: throw IllegalStateException("The destination cannot be written")
        pfd.use {
            FileOutputStream(it.fileDescriptor).channel.truncate(0)
            val muxer = MediaMuxer(it.fileDescriptor, if (webm) MediaMuxer.OutputFormat.MUXER_OUTPUT_WEBM else MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            val codec = MediaCodec.createByCodecName(name!!)
            codec.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            var track = -1; var muxing = false
            val bi = MediaCodec.BufferInfo()
            val n = end - start + 1
            var next = start; var inputDone = false; var outputDone = false
            try {
                while (!outputDone) {
                    kotlin.coroutines.coroutineContext.ensureActive()
                    if (!inputDone) {
                        val ib = codec.dequeueInputBuffer(5000)
                        if (ib >= 0) {
                            if (next > end) { codec.queueInputBuffer(ib, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputDone = true }
                            else {
                                val f = stream.getFrame(next)
                                val img = codec.getInputImage(ib) ?: throw IllegalStateException("The encoder gave no input image")
                                fillYuv(img, f, w, h)
                                codec.queueInputBuffer(ib, 0, w * h * 3 / 2, ((next - start) * 1_000_000.0 / fps).toLong(), 0)
                                next++
                                progress((next - start).toDouble() / n * 0.97)
                            }
                        }
                    }
                    val ob = codec.dequeueOutputBuffer(bi, 5000)
                    if (ob == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { track = muxer.addTrack(codec.outputFormat); muxer.start(); muxing = true }
                    else if (ob >= 0) {
                        val out = codec.getOutputBuffer(ob)!!
                        if (bi.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) bi.size = 0
                        if (bi.size > 0 && muxing) { out.position(bi.offset); out.limit(bi.offset + bi.size); muxer.writeSampleData(track, out, bi) }
                        codec.releaseOutputBuffer(ob, false)
                        if (bi.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
                    }
                }
            } finally {
                try { codec.stop(); codec.release() } catch (_: Exception) { }
                try { if (muxing) muxer.stop(); muxer.release() } catch (_: Exception) { }
            }
        }
    }

    /** RGB (0..255 float) → BT.709 limited-range YUV 4:2:0 in the encoder's input image (2x2 chroma average). */
    private fun fillYuv(img: android.media.Image, f: Frame, w: Int, h: Int) {
        val P = img.planes
        val yb = P[0].buffer; val ys = P[0].rowStride; val yp = P[0].pixelStride
        for (y in 0 until h) for (x in 0 until w) {
            val k = (y * f.w + x) * 4
            val r = to8(f.d[k]); val g = to8(f.d[k + 1]); val b = to8(f.d[k + 2])
            yb.put(y * ys + x * yp, (16 + (0.2126 * r + 0.7152 * g + 0.0722 * b) * 219 / 255 + 0.5).toInt().coerceIn(0, 255).toByte())
        }
        val ub = P[1].buffer; val vb = P[2].buffer; val us = P[1].rowStride; val up = P[1].pixelStride; val vs = P[2].rowStride; val vp = P[2].pixelStride
        for (cy in 0 until h / 2) for (cx in 0 until w / 2) {
            var r = 0.0; var g = 0.0; var b = 0.0
            for (dy in 0..1) for (dx in 0..1) { val k = ((cy * 2 + dy) * f.w + cx * 2 + dx) * 4; r += to8(f.d[k]); g += to8(f.d[k + 1]); b += to8(f.d[k + 2]) }
            r /= 4; g /= 4; b /= 4
            val yy = 0.2126 * r + 0.7152 * g + 0.0722 * b
            val u = 128 + (b - yy) / 1.8556 * 224 / 255; val v = 128 + (r - yy) / 1.5748 * 224 / 255
            ub.put(cy * us + cx * up, (u + 0.5).toInt().coerceIn(0, 255).toByte())
            vb.put(cy * vs + cx * vp, (v + 0.5).toInt().coerceIn(0, 255).toByte())
        }
    }
}

