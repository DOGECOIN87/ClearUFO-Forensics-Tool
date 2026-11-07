package com.clearufo.forensics.media

import com.clearufo.forensics.engine.Frame
import com.clearufo.forensics.engine.FrameMeta
import com.clearufo.forensics.engine.Par
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt

/** What the app knows about an opened evidence file (File Info, report, project). */
class SourceInfo(
    val id: String,
    val kind: String, // image | sequence | video | synthetic
    var name: String,
    var fileSize: Long = 0,
    var fileCount: Int = 1,
    var mime: String? = null,
    var width: Int = 0,
    var height: Int = 0,
    var frameCount: Int = 1,
    var fps: Double = 25.0,
    var duration: Double = 0.0,
    var container: String? = null,
    var codec: String? = null,
    var par: Pair<Int, Int>? = null,
    var colorRange: String? = null,
    var colorMatrix: String? = null,
    var colorPrimaries: String? = null,
    var transfer: String? = null,
    var rotation: Int = 0,
    var bitrate: Long? = null,
    var hasAudio: Boolean = false,
    var audio: String? = null,
    var bitDepth: Int = 8,
    val metadata: MutableList<Pair<String, String>> = mutableListOf(),
    var frameTypesReady: Boolean = true,
    var engine: String = "",
    var conversion: String? = null,
    var vfr: String? = null,
)

/** Video Loader decoding options (same keys and values as the browser workbench). */
data class DecodeOptions(
    val engine: String = "webcodecs", val colorRange: String = "auto", val matrix: String = "auto",
    val chroma: String = "bicubic", val siting: String = "auto", val hdr: String = "tonemap", val hdrPeak: Double = 1000.0,
)

interface SourceProvider {
    val info: SourceInfo
    suspend fun getFrame(i: Int, opts: DecodeOptions = DecodeOptions()): Frame
    fun meta(i: Int): FrameMeta
    /** Background analysis (frame types and sizes); sets info.frameTypesReady. */
    suspend fun analyze(progress: (Double) -> Unit) {}
    fun dispose() {}
}

// ---------------------------------------------------------------- YUV → RGB (sources/yuv.ts)
/**
 * Explicit YUV → RGB conversion of decoded video frames: the examiner controls the color matrix, the range and the
 * chroma reconstruction, and float precision is kept (10-bit samples keep their fractional values on 0..255).
 */
object Yuv {
    class Planes(
        val w: Int, val h: Int,
        val y: ShortArray, val u: ShortArray, val v: ShortArray,
        /** Chroma plane size and subsampling shifts (1 = half resolution). */
        val cw: Int, val ch: Int, val sx: Int, val sy: Int,
        val bits: Int,
    )

    private fun coefficients(matrix: String, full: Boolean): DoubleArray {
        val kr = when (matrix) { "bt709" -> 0.2126; "bt2020" -> 0.2627; else -> 0.299 }
        val kb = when (matrix) { "bt709" -> 0.0722; "bt2020" -> 0.0593; else -> 0.114 }
        val kg = 1 - kr - kb
        val ys = if (full) 1.0 else 255.0 / 219; val yo = if (full) 0.0 else 16.0; val cs = if (full) 1.0 else 255.0 / 224
        return doubleArrayOf(ys, yo, 2 * (1 - kr) * cs, 2 * (1 - kb) * cs, (-2 * (1 - kb) * kb / kg) * cs, (-2 * (1 - kr) * kr / kg) * cs)
    }

    /** Luma-grid position of chroma sample (0, 0) for 4:2:0, in luma pixels. */
    private fun site(siting: String): DoubleArray = when (siting) {
        "center" -> doubleArrayOf(0.5, 0.5); "topleft" -> doubleArrayOf(0.0, 0.0); "top" -> doubleArrayOf(0.5, 0.0)
        "bottomleft" -> doubleArrayOf(0.0, 1.0); "bottom" -> doubleArrayOf(0.5, 1.0); else -> doubleArrayOf(0.0, 0.5)
    }

    private fun catmullRom(t: Double): DoubleArray {
        val t2 = t * t; val t3 = t2 * t
        return doubleArrayOf((-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2)
    }

    /**
     * Taps bringing `srcN` chroma samples to `n` luma positions: chroma sample i sits at luma position 2i + off. Beyond
     * the edges the plane is mirrored (half-sample symmetric, as zimg does), not repeated.
     */
    private class Taps(val k: Int, val idx: IntArray, val wt: DoubleArray)
    private fun taps(n: Int, srcN: Int, sub: Int, off: Double, bicubic: Boolean): Taps {
        val k = if (sub != 0) (if (bicubic) 4 else 2) else 1
        val idx = IntArray(n * k); val wt = DoubleArray(n * k)
        fun cl(i0: Int): Int { if (srcN == 1) return 0; var i = i0; while (i < 0 || i >= srcN) i = if (i < 0) -i - 1 else 2 * srcN - i - 1; return i }
        for (x in 0 until n) {
            if (k == 1) { idx[x] = cl(x); wt[x] = 1.0; continue }
            val c = (x - off) / 2; val i0 = floor(c).toInt(); val t = c - i0
            if (k == 2) { idx[x * 2] = cl(i0); idx[x * 2 + 1] = cl(i0 + 1); wt[x * 2] = 1 - t; wt[x * 2 + 1] = t; continue }
            val wv = catmullRom(t)
            for (j in 0 until 4) { idx[x * 4 + j] = cl(i0 - 1 + j); wt[x * 4 + j] = wv[j] }
        }
        return Taps(k, idx, wt)
    }

    fun toFrame(p: Planes, matrix: String, full: Boolean, chroma: String, siting: String): Frame {
        val w = p.w; val h = p.h
        val c = coefficients(matrix, full)
        val ys = c[0]; val yo = c[1]; val crR = c[2]; val cbB = c[3]; val cbG = c[4]; val crG = c[5]
        // sample scale onto 0..255 (limited range scales by 2^(n-8); full range by 255 / (2^n - 1))
        val norm: Double; val center: Double
        if (p.bits == 8) { norm = 1.0; center = 128.0 } else if (!full) { norm = 1.0 / (1 shl (p.bits - 8)); center = 128.0 } else { norm = 255.0 / ((1 shl p.bits) - 1); center = (1 shl (p.bits - 1)) * norm }
        val out = Frame.alloc(w, h, true)
        val d = out.d
        val cw = p.cw; val ch = p.ch
        fun luma(i: Int) = if (p.bits == 8) ((p.y[i].toInt() and 0xffff) - yo) * ys else ((p.y[i].toInt() and 0xffff) * norm - yo) * ys
        if (chroma == "nearest" || (p.sx == 0 && p.sy == 0)) {
            Par.forRows(h) { y0, y1 ->
                for (y in y0 until y1) for (x in 0 until w) {
                    val ci = min(ch - 1, y shr p.sy) * cw + min(cw - 1, x shr p.sx)
                    val u = (p.u[ci].toInt() and 0xffff) * norm - center; val v = (p.v[ci].toInt() and 0xffff) * norm - center
                    val yy = luma(y * w + x); val k = (y * w + x) * 4
                    d[k] = (yy + crR * v).toFloat(); d[k + 1] = (yy + cbG * u + crG * v).toFloat(); d[k + 2] = (yy + cbB * u).toFloat()
                }
            }
            return out
        }
        // separable reconstruction in float, as the browser workbench: chroma centred on 0, horizontal pass, then
        // the vertical pass fused with the matrix
        val bic = chroma != "bilinear"
        val st = site(siting)
        val U = FloatArray(cw * ch) { ((p.u[it].toInt() and 0xffff) * norm - center).toFloat() }
        val V = FloatArray(cw * ch) { ((p.v[it].toInt() and 0xffff) * norm - center).toFloat() }
        var Uh = U; var Vh = V
        if (p.sx != 0) {
            val tx = taps(w, cw, 1, st[0], bic)
            Uh = FloatArray(w * ch); Vh = FloatArray(w * ch)
            Par.forRows(ch) { j0, j1 ->
                for (j in j0 until j1) {
                    val s0 = j * cw; val o = j * w
                    for (x in 0 until w) {
                        var su = 0.0; var sv = 0.0
                        for (q in 0 until tx.k) { val a = tx.wt[x * tx.k + q]; val i = s0 + tx.idx[x * tx.k + q]; su += a * U[i]; sv += a * V[i] }
                        Uh[o + x] = su.toFloat(); Vh[o + x] = sv.toFloat()
                    }
                }
            }
        }
        val ty = taps(h, ch, p.sy, if (p.sy != 0) st[1] else 0.0, bic)
        Par.forRows(h) { y0, y1 ->
            val Ur = FloatArray(w); val Vr = FloatArray(w)
            for (y in y0 until y1) {
                for (x in 0 until w) {
                    var su = 0.0; var sv = 0.0
                    for (q in 0 until ty.k) { val a = ty.wt[y * ty.k + q]; val i = ty.idx[y * ty.k + q] * w + x; su += a * Uh[i]; sv += a * Vh[i] }
                    Ur[x] = su.toFloat(); Vr[x] = sv.toFloat()
                }
                for (x in 0 until w) {
                    val yy = luma(y * w + x); val u = Ur[x].toDouble(); val v = Vr[x].toDouble(); val k = (y * w + x) * 4
                    d[k] = (yy + crR * v).toFloat(); d[k + 1] = (yy + cbG * u + crG * v).toFloat(); d[k + 2] = (yy + cbB * u).toFloat()
                }
            }
        }
        return out
    }
}

// ---------------------------------------------------------------- HDR → SDR (sources/hdr.ts)
object Hdr {
    const val SDR_WHITE = 203.0
    private const val M1 = 2610.0 / 16384; private const val M2 = 2523.0 / 4096 * 128; private const val C1 = 3424.0 / 4096
    private const val C2 = 2413.0 / 4096 * 32; private const val C3 = 2392.0 / 4096 * 32
    fun pqEotf(e: Double): Double { val p = max(e, 0.0).pow(1 / M2); return 10000 * (max(p - C1, 0.0) / (C2 - C3 * p)).pow(1 / M1) }
    fun pqInv(l: Double): Double { val y = (max(l, 0.0) / 10000).pow(M1); return ((C1 + C2 * y) / (1 + C3 * y)).pow(M2) }
    private const val HA = 0.17883277; private const val HB = 1 - 4 * HA; private val HC = 0.5 - HA * ln(4 * HA)
    fun hlgInvOetf(e0: Double): Double { val e = max(e0, 0.0); return if (e <= 0.5) e * e / 3 else (exp((e - HC) / HA) + HB) / 12 }
    fun hlgGamma(peak: Double) = 1.2 + 0.42 * log10(peak / 1000)

    fun eetf(l: Double, peak: Double, target: Double): Double {
        if (peak <= target) return min(max(l, 0.0), target)
        val sMax = pqInv(peak); val e1 = min(pqInv(l) / sMax, 1.0)
        val maxLum = pqInv(target) / sMax; val ks = max(0.0, 1.5 * maxLum - 0.5)
        var e2 = e1
        if (e1 > ks) { val t = (e1 - ks) / (1 - ks); val t2 = t * t; val t3 = t2 * t; e2 = (2 * t3 - 3 * t2 + 1) * ks + (t3 - 2 * t2 + t) * (1 - ks) + (-2 * t3 + 3 * t2) * maxLum }
        return min(pqEotf(e2 * sMax), target)
    }

    private class Tables(val dec: FloatArray, val ootf: FloatArray?, val tone: FloatArray, val enc: FloatArray, val ypk: Double)
    private val cache = HashMap<String, Tables>()
    private fun table(n: Int, fn: (Double) -> Double) = FloatArray(n + 1) { fn(it.toDouble() / n).toFloat() }
    private fun at(t: FloatArray, x: Double): Double {
        val n = t.size - 1
        if (!(x > 0)) return t[0].toDouble()
        if (x >= 1) return t[n].toDouble()
        val f = x * n; val i = f.toInt()
        return t[i] + (t[i + 1] - t[i]) * (f - i)
    }

    @Synchronized private fun tables(pq: Boolean, peak: Double): Tables = cache.getOrPut("$pq|$peak") {
        val ypk = peak / SDR_WHITE; val g = hlgGamma(peak)
        Tables(
            if (pq) table(16384) { pqEotf(it) / SDR_WHITE } else table(8192) { hlgInvOetf(it) },
            if (!pq) table(8192) { u -> val ys = u * u; val k = ypk * ys.pow(g - 1); val yd = k * ys * SDR_WHITE; if (yd <= 0) k else k * (if (yd >= peak) SDR_WHITE else eetf(yd, peak, SDR_WHITE)) / yd } else null,
            table(8192) { u -> val y = u * u * peak; if (y <= 0) 1.0 else eetf(y, peak, SDR_WHITE) / y },
            table(8192) { u -> (u * u).pow(1 / 2.4) },
            ypk,
        )
    }

    /** Convert a decoded HDR frame (R'G'B' signal values 0..255) in place to SDR BT.709 (0..255). */
    fun toSdr(f: Frame, pq: Boolean, bt2020: Boolean, peak0: Double) {
        val peak = max(100.0, min(10000.0, peak0))
        val T = tables(pq, peak)
        val kr = if (bt2020) 0.2627 else 0.2126; val kg = if (bt2020) 0.678 else 0.7152; val kb = if (bt2020) 0.0593 else 0.0722
        val d = f.d; val s = 1 / 255.0
        Par.forRows(f.h) { y0, y1 ->
            var i = y0 * f.w * 4
            val e = y1 * f.w * 4
            while (i < e) {
                var r = at(T.dec, d[i] * s); var g = at(T.dec, d[i + 1] * s); var b = at(T.dec, d[i + 2] * s)
                val y = kr * r + kg * g + kb * b
                if (T.ootf != null) { val k = at(T.ootf, sqrt(y)); r *= k; g *= k; b *= k }
                else if (y > 0) { val k = if (y >= T.ypk) 1 / y else at(T.tone, sqrt(y / T.ypk)); r *= k; g *= k; b *= k }
                if (bt2020) {
                    val R = 1.660491 * r - 0.587641 * g - 0.07285 * b; val G = -0.12455 * r + 1.1329 * g - 0.008349 * b; val B = -0.018151 * r - 0.100579 * g + 1.11873 * b
                    r = R; g = G; b = B
                }
                val Y = 0.2126 * r + 0.7152 * g + 0.0722 * b
                if (Y <= 0) { r = 0.0; g = 0.0; b = 0.0 } else if (Y >= 1) { r = 1.0; g = 1.0; b = 1.0 } else {
                    var lo = min(r, min(g, b)); var hi = max(r, max(g, b))
                    if (lo < 0) { val k = Y / (Y - lo); r = Y + (r - Y) * k; g = Y + (g - Y) * k; b = Y + (b - Y) * k; hi = Y + (hi - Y) * k; lo = 0.0 }
                    if (hi > 1) { val k = (1 - Y) / (hi - Y); r = Y + (r - Y) * k; g = Y + (g - Y) * k; b = Y + (b - Y) * k }
                }
                d[i] = (255 * at(T.enc, sqrt(max(r, 0.0)))).toFloat()
                d[i + 1] = (255 * at(T.enc, sqrt(max(g, 0.0)))).toFloat()
                d[i + 2] = (255 * at(T.enc, sqrt(max(b, 0.0)))).toFloat()
                i += 4
            }
        }
    }
}

fun fmtBytes(n: Long): String = when {
    n < 1024 -> "$n B"
    n < 1048576 -> "%.1f KB".format(n / 1024.0)
    n < 1073741824 -> "%.2f MB".format(n / 1048576.0)
    else -> "%.2f GB".format(n / 1073741824.0)
}
