package com.clearufo.forensics.media

import com.clearufo.forensics.engine.Frame
import com.clearufo.forensics.engine.to8
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.CRC32
import java.util.zip.Inflater
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

// Exact image codecs. Decoders: PNG (every color type, 1–16 bits, palettes with tRNS, Adam7) and TIFF (strips or
// tiles; none, LZW, Deflate, PackBits; 8/16-bit integer or 32-bit float). Writers: uncompressed PNG ("stored" deflate
// blocks), TIFF and BMP, readable by every viewer. 16-bit samples are value × 257 (8-bit levels map exactly) and
// read back ÷ 257 so fractions are kept; 32-bit float TIFF holds 0.0..1.0 = black..white. These are the conventions
// of the browser workbench, so files move between the two applications unchanged.

class DecodedImage(val frame: Frame, val depth: Int, val description: String, val hasAlpha: Boolean)

private fun u32(b: ByteArray, p: Int) = ((b[p].toInt() and 255) shl 24) or ((b[p + 1].toInt() and 255) shl 16) or ((b[p + 2].toInt() and 255) shl 8) or (b[p + 3].toInt() and 255)

object PngCodec {
    fun isPng(b: ByteArray) = b.size > 8 && b[0] == 0x89.toByte() && b[1] == 'P'.code.toByte() && b[2] == 'N'.code.toByte() && b[3] == 'G'.code.toByte()

    private val CHANNELS = mapOf(0 to 1, 2 to 3, 3 to 1, 4 to 2, 6 to 4)

    fun decode(b: ByteArray): DecodedImage {
        if (!isPng(b)) throw IllegalArgumentException("Not a PNG file")
        var p = 8
        var w = 0; var h = 0; var depth = 0; var ct = -1; var interlaced = false; var animated = false
        var palette: ByteArray? = null; var trns: ByteArray? = null
        val idat = ByteArrayOutputStream()
        while (p + 8 <= b.size) {
            val len = u32(b, p); val id = String(b, p + 4, 4, Charsets.ISO_8859_1)
            val data = p + 8
            if (data + len > b.size) throw IllegalArgumentException("The PNG file is truncated (chunk $id)")
            when (id) {
                "IHDR" -> { w = u32(b, data); h = u32(b, data + 4); depth = b[data + 8].toInt() and 255; ct = b[data + 9].toInt() and 255; interlaced = b[data + 12].toInt() != 0 }
                "PLTE" -> palette = b.copyOfRange(data, data + len)
                "tRNS" -> trns = b.copyOfRange(data, data + len)
                "IDAT" -> idat.write(b, data, len)
                "acTL" -> animated = true
                "IEND" -> break
            }
            p = data + len + 4
        }
        val ch = CHANNELS[ct] ?: throw IllegalArgumentException("Invalid PNG color type $ct")
        if (w <= 0 || h <= 0) throw IllegalArgumentException("Invalid PNG size")
        val inf = Inflater()
        inf.setInput(idat.toByteArray())
        val bitsPP = ch * depth; val bpp = max(1, bitsPP shr 3)
        val passes = if (interlaced) listOf(intArrayOf(0, 0, 8, 8), intArrayOf(4, 0, 8, 8), intArrayOf(0, 4, 4, 8), intArrayOf(2, 0, 4, 4), intArrayOf(0, 2, 2, 4), intArrayOf(1, 0, 2, 2), intArrayOf(0, 1, 1, 2)) else listOf(intArrayOf(0, 0, 1, 1))
        val out = FloatArray(w * h * 4)
        val max = (1 shl depth) - 1
        val mul = if (depth < 8) 255.0 else 1.0; val div = if (depth == 16) 257.0 else if (depth == 8) 1.0 else max.toDouble()
        val trGray = if (ct == 0 && trns != null && trns.size >= 2) ((trns[0].toInt() and 255) shl 8) or (trns[1].toInt() and 255) else -1
        val trRgb = if (ct == 2 && trns != null && trns.size >= 6) IntArray(3) { ((trns[it * 2].toInt() and 255) shl 8) or (trns[it * 2 + 1].toInt() and 255) } else null
        for (ps in passes) {
            val x0 = ps[0]; val y0 = ps[1]; val dx = ps[2]; val dy = ps[3]
            val pw = if (w > x0) (w - x0 + dx - 1) / dx else 0; val ph = if (h > y0) (h - y0 + dy - 1) / dy else 0
            if (pw == 0 || ph == 0) continue
            val stride = (pw * bitsPP + 7) / 8
            var prev = ByteArray(stride); var cur = ByteArray(stride)
            val ft = ByteArray(1)
            for (ry in 0 until ph) {
                readFully(inf, ft, 1); readFully(inf, cur, stride)
                unfilter(ft[0].toInt() and 255, cur, prev, bpp)
                val y = y0 + ry * dy
                for (i in 0 until pw) {
                    val x = x0 + i * dx
                    val o = (y * w + x) * 4
                    fun sample(c: Int): Int = when (depth) {
                        16 -> ((cur[(i * ch + c) * 2].toInt() and 255) shl 8) or (cur[(i * ch + c) * 2 + 1].toInt() and 255)
                        8 -> cur[i * ch + c].toInt() and 255
                        else -> { val bit = (i * ch + c) * depth; ((cur[bit shr 3].toInt() and 255) shr (8 - depth - (bit and 7))) and max }
                    }
                    if (ct == 3) {
                        val idx = sample(0)
                        val pl = palette ?: throw IllegalArgumentException("PNG palette missing")
                        out[o] = (pl.getOrElse(idx * 3) { 0 }.toInt() and 255).toFloat(); out[o + 1] = (pl.getOrElse(idx * 3 + 1) { 0 }.toInt() and 255).toFloat(); out[o + 2] = (pl.getOrElse(idx * 3 + 2) { 0 }.toInt() and 255).toFloat()
                        out[o + 3] = if (trns != null && idx < trns.size) (trns[idx].toInt() and 255).toFloat() else 255f
                        continue
                    }
                    val s0 = sample(0)
                    val v0 = (s0 * mul / div).toFloat()
                    when (ct) {
                        0 -> { out[o] = v0; out[o + 1] = v0; out[o + 2] = v0; out[o + 3] = if (s0 == trGray) 0f else 255f }
                        4 -> { out[o] = v0; out[o + 1] = v0; out[o + 2] = v0; out[o + 3] = (sample(1) * mul / div).toFloat() }
                        2 -> { val s1 = sample(1); val s2 = sample(2); out[o] = v0; out[o + 1] = (s1 * mul / div).toFloat(); out[o + 2] = (s2 * mul / div).toFloat(); out[o + 3] = if (trRgb != null && s0 == trRgb[0] && s1 == trRgb[1] && s2 == trRgb[2]) 0f else 255f }
                        6 -> { out[o] = v0; out[o + 1] = (sample(1) * mul / div).toFloat(); out[o + 2] = (sample(2) * mul / div).toFloat(); out[o + 3] = (sample(3) * mul / div).toFloat() }
                    }
                }
                val t = prev; prev = cur; cur = t
            }
        }
        inf.end()
        val types = mapOf(0 to "grayscale", 2 to "RGB", 3 to "indexed", 4 to "grayscale + alpha", 6 to "RGBA")
        return DecodedImage(Frame(w, h, out), depth, "PNG ${types[ct]}, $depth-bit${if (interlaced) ", Adam7 interlaced" else ""}${if (animated) " (animated: first frame)" else ""} — decoded exactly by ClearUFO", ct == 4 || ct == 6 || trns != null)
    }

    private fun readFully(inf: Inflater, buf: ByteArray, n: Int) {
        var off = 0
        while (off < n) {
            val r = inf.inflate(buf, off, n - off)
            if (r == 0) { if (inf.finished() || inf.needsInput()) throw IllegalArgumentException("The PNG image data is truncated"); if (inf.needsDictionary()) throw IllegalArgumentException("Invalid PNG data") }
            off += r
        }
    }

    private fun unfilter(type: Int, cur: ByteArray, prev: ByteArray, bpp: Int) {
        val n = cur.size
        when (type) {
            0 -> {}
            1 -> for (i in bpp until n) cur[i] = (cur[i] + cur[i - bpp]).toByte()
            2 -> for (i in 0 until n) cur[i] = (cur[i] + prev[i]).toByte()
            3 -> for (i in 0 until n) { val a = if (i >= bpp) cur[i - bpp].toInt() and 255 else 0; cur[i] = (cur[i] + ((a + (prev[i].toInt() and 255)) shr 1)).toByte() }
            4 -> for (i in 0 until n) {
                val a = if (i >= bpp) cur[i - bpp].toInt() and 255 else 0; val bb = prev[i].toInt() and 255; val c = if (i >= bpp) prev[i - bpp].toInt() and 255 else 0
                val pp = a + bb - c; val pa = abs(pp - a); val pb = abs(pp - bb); val pc = abs(pp - c)
                cur[i] = (cur[i] + (if (pa <= pb && pa <= pc) a else if (pb <= pc) bb else c)).toByte()
            }
            else -> throw IllegalArgumentException("Invalid PNG filter type $type")
        }
    }

    // ---------------------------------------------------------------- writer
    private fun chunk(out: OutputStream, type: String, data: ByteArray) {
        val bb = ByteBuffer.allocate(4).order(ByteOrder.BIG_ENDIAN)
        out.write(bb.putInt(data.size).array())
        val t = type.toByteArray(Charsets.ISO_8859_1)
        out.write(t); out.write(data)
        val crc = CRC32(); crc.update(t); crc.update(data)
        out.write(ByteBuffer.allocate(4).putInt(crc.value.toInt()).array())
    }

    /** RGB PNG, 8 or 16 bits per channel, image data in zlib "stored" blocks (uncompressed). */
    fun encode(f: Frame, sixteen: Boolean): ByteArray {
        val w = f.w; val h = f.h; val bps = if (sixteen) 2 else 1
        val raw = ByteArray((w * 3 * bps + 1) * h)
        var p = 0
        for (y in 0 until h) {
            raw[p++] = 0
            for (x in 0 until w) {
                val k = (y * w + x) * 4
                for (c in 0 until 3) {
                    if (sixteen) { val v = to16(f.d[k + c]); raw[p++] = (v shr 8).toByte(); raw[p++] = v.toByte() } else raw[p++] = to8(f.d[k + c]).toByte()
                }
            }
        }
        // zlib with stored deflate blocks (max 65535 bytes each)
        val z = ByteArrayOutputStream(raw.size + raw.size / 65535 * 5 + 16)
        z.write(0x78); z.write(0x01)
        var off = 0
        while (off < raw.size || raw.isEmpty()) {
            val n = min(65535, raw.size - off)
            val last = off + n >= raw.size
            z.write(if (last) 1 else 0); z.write(n and 255); z.write(n shr 8); z.write(n.inv() and 255); z.write((n.inv() shr 8) and 255)
            z.write(raw, off, n)
            off += n
            if (last) break
        }
        var a = 1L; var bsum = 0L
        for (v in raw) { a = (a + (v.toInt() and 255)) % 65521; bsum = (bsum + a) % 65521 }
        z.write(ByteBuffer.allocate(4).putInt(((bsum shl 16) or a).toInt()).array())
        val out = ByteArrayOutputStream(z.size() + 128)
        out.write(byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(), 13, 10, 26, 10))
        chunk(out, "IHDR", ByteBuffer.allocate(13).putInt(w).putInt(h).put((if (sixteen) 16 else 8).toByte()).put(2).put(0).put(0).put(0).array())
        chunk(out, "IDAT", z.toByteArray())
        chunk(out, "IEND", ByteArray(0))
        return out.toByteArray()
    }
}

/** 0..255 float → 16-bit sample (value × 257, round half to even, clamped). */
fun to16(v: Float): Int {
    if (v.isNaN() || v <= 0f) return 0
    val s = v.toDouble() * 257
    if (s >= 65535) return 65535
    return Math.rint(s).toInt()
}

object TiffCodec {
    fun isTiff(b: ByteArray) = b.size > 8 && ((b[0] == 'I'.code.toByte() && b[1] == 'I'.code.toByte() && b[2].toInt() == 42) || (b[0] == 'M'.code.toByte() && b[1] == 'M'.code.toByte() && b[3].toInt() == 42))

    fun decode(b: ByteArray): DecodedImage {
        val le = b[0] == 'I'.code.toByte()
        val bb = ByteBuffer.wrap(b).order(if (le) ByteOrder.LITTLE_ENDIAN else ByteOrder.BIG_ENDIAN)
        val ifd = bb.getInt(4)
        val n = bb.getShort(ifd).toInt() and 0xffff
        val tags = HashMap<Int, LongArray>()
        for (i in 0 until n) {
            val e = ifd + 2 + i * 12
            val tag = bb.getShort(e).toInt() and 0xffff; val type = bb.getShort(e + 2).toInt() and 0xffff; val count = bb.getInt(e + 4)
            val size = when (type) { 3 -> 2; 4 -> 4; 1, 2, 6, 7 -> 1; 16 -> 8; else -> 4 }
            val inline = size * count <= 4
            val base = if (inline) e + 8 else bb.getInt(e + 8)
            if (count > 1 shl 24) continue
            tags[tag] = LongArray(count) { k ->
                when (type) {
                    3 -> (bb.getShort(base + k * 2).toInt() and 0xffff).toLong()
                    4 -> bb.getInt(base + k * 4).toLong() and 0xffffffffL
                    1, 7 -> (b[base + k].toInt() and 255).toLong()
                    else -> bb.getInt(base + k * 4).toLong() and 0xffffffffL
                }
            }
        }
        fun get(t: Int, def: Long = 0) = tags[t]?.getOrNull(0) ?: def
        val w = get(256).toInt(); val h = get(257).toInt(); val spp = get(277, 1).toInt()
        val bits = get(258, 1).toInt(); val comp = get(259, 1).toInt(); val photo = get(262, 1).toInt()
        val planar = get(284, 1).toInt(); val pred = get(317, 1).toInt(); val fmt = get(339, 1).toInt()
        if (w <= 0 || h <= 0) throw IllegalArgumentException("Invalid TIFF size")
        if (bits !in listOf(1, 8, 16, 32)) throw IllegalArgumentException("TIFF with $bits-bit samples is not supported")
        if (planar != 1 && spp > 1) throw IllegalArgumentException("Planar TIFF is not supported")
        val tiled = tags.containsKey(322)
        val bw = if (tiled) get(322).toInt() else w; val bh = if (tiled) get(323).toInt() else get(278, h.toLong()).toInt().coerceAtMost(h)
        val offs = tags[if (tiled) 324 else 273] ?: throw IllegalArgumentException("TIFF without image data")
        val counts = tags[if (tiled) 325 else 279] ?: LongArray(offs.size) { (b.size - offs[it]) }
        val bps = max(1, bits / 8)
        val rowBytes = if (bits == 1) (bw * spp + 7) / 8 else bw * spp * bps
        val out = FloatArray(w * h * 4)
        val cmap = tags[320]
        val tilesAcross = (w + bw - 1) / bw
        for (s in offs.indices) {
            val raw = decompress(b, offs[s].toInt(), counts[s].toInt(), comp, rowBytes * bh)
            if (pred == 2 && bits == 8) for (r in 0 until bh) for (i in spp until rowBytes) { val p = r * rowBytes + i; if (p < raw.size) raw[p] = (raw[p] + raw[p - spp]).toByte() }
            if (pred == 2 && bits == 16) {
                val sb = ByteBuffer.wrap(raw).order(bb.order())
                for (r in 0 until bh) for (i in spp until bw * spp) { val p = r * rowBytes + i * 2; if (p + 1 < raw.size) sb.putShort(p, (sb.getShort(p) + sb.getShort(p - spp * 2)).toShort()) }
            }
            val sbuf = ByteBuffer.wrap(raw).order(bb.order())
            val ox = if (tiled) (s % tilesAcross) * bw else 0; val oy = if (tiled) (s / tilesAcross) * bh else s * bh
            for (r in 0 until bh) {
                val y = oy + r
                if (y >= h) break
                for (i in 0 until bw) {
                    val x = ox + i
                    if (x >= w) break
                    fun sample(c: Int): Double {
                        val k = r * rowBytes + (i * spp + c) * bps
                        if (bits == 1) { val bit = r * rowBytes * 8 + i * spp + c; return if (((raw.getOrElse(bit shr 3) { 0 }.toInt() shr (7 - (bit and 7))) and 1) == 1) 255.0 else 0.0 }
                        if (k + bps > raw.size) return 0.0
                        return when (bits) {
                            8 -> (raw[k].toInt() and 255).toDouble()
                            16 -> (sbuf.getShort(k).toInt() and 0xffff) / 257.0
                            else -> if (fmt == 3) sbuf.getFloat(k) * 255.0 else (sbuf.getInt(k).toLong() and 0xffffffffL) / 16843009.0
                        }
                    }
                    val o = (y * w + x) * 4
                    when {
                        photo == 3 && cmap != null -> {
                            val idx = sample(0).toInt().let { if (bits == 16) (it * 257.0 / 1).toInt() else it }
                            val m = cmap.size / 3
                            out[o] = (cmap[idx.coerceIn(0, m - 1)] / 257.0).toFloat(); out[o + 1] = (cmap[m + idx.coerceIn(0, m - 1)] / 257.0).toFloat(); out[o + 2] = (cmap[2 * m + idx.coerceIn(0, m - 1)] / 257.0).toFloat(); out[o + 3] = 255f
                        }
                        spp >= 3 -> { out[o] = sample(0).toFloat(); out[o + 1] = sample(1).toFloat(); out[o + 2] = sample(2).toFloat(); out[o + 3] = if (spp >= 4) sample(3).toFloat() else 255f }
                        else -> { var v = sample(0); if (photo == 0) v = 255 - v; val f = v.toFloat(); out[o] = f; out[o + 1] = f; out[o + 2] = f; out[o + 3] = if (spp == 2) sample(1).toFloat() else 255f }
                    }
                }
            }
        }
        val cname = mapOf(1 to "uncompressed", 5 to "LZW", 8 to "Deflate", 32946 to "Deflate", 32773 to "PackBits")[comp] ?: "compression $comp"
        return DecodedImage(Frame(w, h, out), bits, "TIFF ${if (fmt == 3) "32-bit float" else "$bits-bit"}, $spp sample(s)/pixel, $cname${if (tiled) ", tiled" else ""} — decoded exactly by ClearUFO", spp == 4 || spp == 2)
    }

    private fun decompress(b: ByteArray, off: Int, len: Int, comp: Int, expect: Int): ByteArray {
        val end = min(b.size, off + len)
        return when (comp) {
            1 -> b.copyOfRange(off, end).let { if (it.size < expect) it.copyOf(expect) else it }
            8, 32946 -> { val inf = Inflater(); inf.setInput(b, off, end - off); val o = ByteArray(expect); var p = 0; while (p < expect && !inf.finished()) { val r = inf.inflate(o, p, expect - p); if (r == 0 && (inf.needsInput() || inf.needsDictionary())) break; p += r }; inf.end(); o }
            32773 -> { val o = ByteArray(expect); var p = 0; var i = off; while (i < end && p < expect) { val c = b[i++].toInt(); if (c >= 0) { val k = min(c + 1, expect - p); System.arraycopy(b, i, o, p, min(k, end - i)); i += c + 1; p += k } else if (c != -128) { val k = min(1 - c, expect - p); val v = b.getOrElse(i++) { 0 }; for (q in 0 until k) o[p++] = v } }; o }
            5 -> lzw(b, off, end, expect)
            else -> throw IllegalArgumentException("TIFF compression $comp is not supported")
        }
    }

    private fun lzw(b: ByteArray, off: Int, end: Int, expect: Int): ByteArray {
        val out = ByteArray(expect); var op = 0
        val prefix = IntArray(4096); val suffix = ByteArray(4096); val length = IntArray(4096)
        for (i in 0 until 256) { suffix[i] = i.toByte(); length[i] = 1; prefix[i] = -1 }
        var next = 258; var width = 9; var bitPos = off.toLong() * 8; val endBits = end.toLong() * 8
        var old = -1
        val tmp = ByteArray(4096)
        fun readCode(): Int {
            if (bitPos + width > endBits) return 257
            var v = 0
            for (k in 0 until width) { val byte = b[((bitPos + k) shr 3).toInt()].toInt() and 255; v = (v shl 1) or ((byte shr (7 - ((bitPos + k) and 7).toInt())) and 1) }
            bitPos += width
            return v
        }
        fun emit(code: Int): Byte {
            var c = code; var n = length[c]; val first: Byte
            var k = n
            while (c >= 0 && k > 0) { tmp[--k] = suffix[c]; c = prefix[c] }
            first = tmp[0]
            for (q in 0 until n) { if (op < expect) out[op++] = tmp[q] }
            n = 0
            return first
        }
        while (op < expect) {
            val code = readCode()
            if (code == 257) break
            if (code == 256) { next = 258; width = 9; old = -1; continue }
            if (old == -1) { emit(code); old = code; continue }
            if (code < next) {
                val first = emit(code)
                if (next < 4096) { prefix[next] = old; suffix[next] = first; length[next] = length[old] + 1; next++ }
            } else {
                // KwKwK case
                var c = old; while (prefix[c] >= 0) c = prefix[c]
                val first = suffix[c]
                if (next < 4096) { prefix[next] = old; suffix[next] = first; length[next] = length[old] + 1; next++ }
                emit(next - 1)
            }
            old = code
            if (next + 1 >= (1 shl width) && width < 12) width++
        }
        return out
    }

    /** The stored R, G, B samples of an uncompressed single-strip chunky TIFF (as written by encode), unconverted. */
    fun rawSamples(b: ByteArray): DoubleArray {
        val le = b[0] == 'I'.code.toByte()
        val bb = ByteBuffer.wrap(b).order(if (le) ByteOrder.LITTLE_ENDIAN else ByteOrder.BIG_ENDIAN)
        val ifd = bb.getInt(4); val n = bb.getShort(ifd).toInt() and 0xffff
        var w = 0; var h = 0; var bits = 8; var off = 0; var fmt = 1; var spp = 3
        for (i in 0 until n) {
            val e = ifd + 2 + i * 12; val tag = bb.getShort(e).toInt() and 0xffff; val type = bb.getShort(e + 2).toInt() and 0xffff; val count = bb.getInt(e + 4)
            val v = if (type == 3 && count == 1) bb.getShort(e + 8).toInt() and 0xffff else bb.getInt(e + 8)
            when (tag) { 256 -> w = v; 257 -> h = v; 273 -> off = v; 277 -> spp = v
                258 -> bits = if (count == 1) v else bb.getShort(v).toInt() and 0xffff
                339 -> fmt = if (count == 1) v else bb.getShort(v).toInt() and 0xffff }
        }
        val bps = bits / 8
        return DoubleArray(w * h * 3) { k ->
            val p = off + ((k / 3) * spp + k % 3) * bps
            when (bits) { 8 -> (b[p].toInt() and 255).toDouble(); 16 -> (bb.getShort(p).toInt() and 0xffff).toDouble(); else -> if (fmt == 3) bb.getFloat(p).toDouble() else (bb.getInt(p).toLong() and 0xffffffffL).toDouble() }
        }
    }

    /** Uncompressed chunky RGB TIFF: 1 = 8-bit, 2 = 16-bit, 4 = 32-bit float (0.0..1.0). Little endian, one strip. */
    fun encode(f: Frame, bytesPerSample: Int): ByteArray {
        val w = f.w; val h = f.h
        val dataLen = w * h * 3 * bytesPerSample
        val nTags = 12
        val ifd = 8
        val ifdLen = 2 + nTags * 12 + 4
        val bitsOff = ifd + ifdLen; val fmtOff = bitsOff + 6; val resOff = fmtOff + 6; val dataOff = resOff + 16
        val bb = ByteBuffer.allocate(dataOff + dataLen).order(ByteOrder.LITTLE_ENDIAN)
        bb.put('I'.code.toByte()).put('I'.code.toByte()).putShort(42).putInt(ifd)
        bb.position(ifd); bb.putShort(nTags.toShort())
        fun tag(t: Int, type: Int, count: Int, value: Int) { bb.putShort(t.toShort()).putShort(type.toShort()).putInt(count); if (type == 3 && count == 1) bb.putShort(value.toShort()).putShort(0) else bb.putInt(value) }
        tag(256, 4, 1, w); tag(257, 4, 1, h); tag(258, 3, 3, bitsOff); tag(259, 3, 1, 1); tag(262, 3, 1, 2)
        tag(273, 4, 1, dataOff); tag(277, 3, 1, 3); tag(278, 4, 1, h); tag(279, 4, 1, dataLen)
        tag(282, 5, 1, resOff); tag(283, 5, 1, resOff + 8); tag(339, 3, 3, fmtOff)
        bb.putInt(0)
        bb.position(bitsOff); repeat(3) { bb.putShort((bytesPerSample * 8).toShort()) }
        bb.position(fmtOff); repeat(3) { bb.putShort((if (bytesPerSample == 4) 3 else 1).toShort()) }
        bb.position(resOff); bb.putInt(72).putInt(1).putInt(72).putInt(1)
        bb.position(dataOff)
        val d = f.d
        for (i in 0 until w * h) for (c in 0 until 3) {
            val v = d[i * 4 + c]
            when (bytesPerSample) { 1 -> bb.put(to8(v).toByte()); 2 -> bb.putShort(to16(v).toShort()); else -> bb.putFloat(v / 255f) }
        }
        return bb.array()
    }
}

object BmpCodec {
    /** 24-bit uncompressed BMP (bottom-up rows padded to 4 bytes). */
    fun encode(f: Frame): ByteArray {
        val w = f.w; val h = f.h; val row = (w * 3 + 3) and 3.inv()
        val size = 54 + row * h
        val bb = ByteBuffer.allocate(size).order(ByteOrder.LITTLE_ENDIAN)
        bb.put('B'.code.toByte()).put('M'.code.toByte()).putInt(size).putInt(0).putInt(54)
        bb.putInt(40).putInt(w).putInt(h).putShort(1).putShort(24).putInt(0).putInt(row * h).putInt(2835).putInt(2835).putInt(0).putInt(0)
        for (y in h - 1 downTo 0) {
            val start = bb.position()
            for (x in 0 until w) { val k = (y * w + x) * 4; bb.put(to8(f.d[k + 2]).toByte()).put(to8(f.d[k + 1]).toByte()).put(to8(f.d[k]).toByte()) }
            bb.position(start + row)
        }
        return bb.array()
    }
}
