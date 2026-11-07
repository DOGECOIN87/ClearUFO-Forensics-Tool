package com.clearufo.forensics.engine.kernels

import com.clearufo.forensics.engine.Frame
import com.clearufo.forensics.engine.Par
import com.clearufo.forensics.engine.Pt
import kotlin.math.abs
import kotlin.math.cbrt
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt
import kotlin.math.tan

// Color conversions, LUTs, histogram equalization (global and CLAHE) and statistics (port of kernels/color.ts).

/** Interpolated lookup on the nominal 0..255 range (values outside are clamped). */
class Lut(fn: (Double) -> Double, val n: Int = 4096) {
    val t = FloatArray(n + 1).also { for (i in 0..n) it[i] = fn(i.toDouble() / n * 255).toFloat() }
    private val sc = n / 255.0
    /** Lut.map of the 256 integer inputs (frames from 8-bit sources hold whole numbers). */
    private val k = DoubleArray(256).also { for (v in 0 until 256) it[v] = interp(v.toDouble()) }

    private fun interp(v0: Double): Double {
        val x = (if (v0 < 0) 0.0 else if (v0 > 255) 255.0 else v0) * sc
        val i = x.toInt()
        return if (i >= n) t[n].toDouble() else t[i] + (t[i + 1] - t[i]).toDouble() * (x - i)
    }

    fun map(v: Double): Double {
        val iv = v.toInt()
        return if (iv.toDouble() == v && iv in 0..255) k[iv] else interp(v)
    }
}

fun applyLuts(f: Frame, lr: Lut?, lg: Lut?, lb: Lut?): Frame {
    val d = f.d
    val out = FloatArray(d.size)
    Par.forRows(f.h) { y0, y1 ->
        var i = y0 * f.w * 4
        val e = y1 * f.w * 4
        while (i < e) {
            out[i] = lr?.map(d[i].toDouble())?.toFloat() ?: d[i]
            out[i + 1] = lg?.map(d[i + 1].toDouble())?.toFloat() ?: d[i + 1]
            out[i + 2] = lb?.map(d[i + 2].toDouble())?.toFloat() ?: d[i + 2]
            out[i + 3] = d[i + 3]
            i += 4
        }
    }
    return Frame(f.w, f.h, out)
}

/** Per-pixel map (r, g, b → 3 outputs), alpha kept, rows in parallel. */
inline fun mapPixels(f: Frame, crossinline fn: (Double, Double, Double, FloatArray, Int) -> Unit): Frame {
    val d = f.d
    val out = FloatArray(d.size)
    Par.forRows(f.h) { y0, y1 ->
        var i = y0 * f.w * 4
        val e = y1 * f.w * 4
        while (i < e) { fn(d[i].toDouble(), d[i + 1].toDouble(), d[i + 2].toDouble(), out, i); out[i + 3] = d[i + 3]; i += 4 }
    }
    return Frame(f.w, f.h, out)
}

// ---------------------------------------------------------------- conversions (inputs 0..255)
fun rgbToHsv(r0: Double, g0: Double, b0: Double): DoubleArray {
    val r = r0 / 255; val g = g0 / 255; val b = b0 / 255
    val mx = max(r, max(g, b)); val mn = min(r, min(g, b)); val d = mx - mn
    var h = 0.0
    if (d > 1e-9) {
        h = if (mx == r) ((g - b) / d) % 6 else if (mx == g) (b - r) / d + 2 else (r - g) / d + 4
        h *= 60
        if (h < 0) h += 360
    }
    return doubleArrayOf(h, if (mx > 0) d / mx else 0.0, mx)
}

fun hsvToRgb(h0: Double, s: Double, v: Double): DoubleArray {
    val h = ((h0 % 360) + 360) % 360
    val c = v * s; val x = c * (1 - abs((h / 60) % 2 - 1)); val m = v - c
    val (r, g, b) = when {
        h < 60 -> Triple(c, x, 0.0); h < 120 -> Triple(x, c, 0.0); h < 180 -> Triple(0.0, c, x)
        h < 240 -> Triple(0.0, x, c); h < 300 -> Triple(x, 0.0, c); else -> Triple(c, 0.0, x)
    }
    return doubleArrayOf((r + m) * 255, (g + m) * 255, (b + m) * 255)
}

fun rgbToHsl(r0: Double, g0: Double, b0: Double): DoubleArray {
    val r = r0 / 255; val g = g0 / 255; val b = b0 / 255
    val mx = max(r, max(g, b)); val mn = min(r, min(g, b)); val l = (mx + mn) / 2; val d = mx - mn
    var h = 0.0; var s = 0.0
    if (d > 1e-9) {
        s = d / (1 - abs(2 * l - 1))
        h = if (mx == r) ((g - b) / d) % 6 else if (mx == g) (b - r) / d + 2 else (r - g) / d + 4
        h *= 60
        if (h < 0) h += 360
    }
    return doubleArrayOf(h, s, l)
}

fun hslToRgb(h: Double, s: Double, l: Double): DoubleArray {
    val c = (1 - abs(2 * l - 1)) * s
    return hsvToRgb(h, if (l + c / 2 > 0) c / (l + c / 2) else 0.0, l + c / 2)
}

private fun srgbToLinear(c0: Double): Double { val c = c0 / 255; return if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4) }
private fun linearToSrgb(c: Double): Double = (if (c <= 0.0031308) c * 12.92 else 1.055 * c.pow(1 / 2.4) - 0.055) * 255

fun rgbToXyz(r: Double, g: Double, b: Double): DoubleArray {
    val R = srgbToLinear(r); val G = srgbToLinear(g); val B = srgbToLinear(b)
    return doubleArrayOf(0.4124564 * R + 0.3575761 * G + 0.1804375 * B, 0.2126729 * R + 0.7151522 * G + 0.072175 * B, 0.0193339 * R + 0.119192 * G + 0.9503041 * B)
}

fun xyzToRgb(x: Double, y: Double, z: Double) = doubleArrayOf(
    linearToSrgb(3.2404542 * x - 1.5371385 * y - 0.4985314 * z), linearToSrgb(-0.969266 * x + 1.8760108 * y + 0.041556 * z), linearToSrgb(0.0556434 * x - 0.2040259 * y + 1.0572252 * z))

fun rgbToLab(r: Double, g: Double, b: Double): DoubleArray {
    val xyz = rgbToXyz(r, g, b)
    fun f(t: Double) = if (t > 216.0 / 24389) cbrt(t) else (24389.0 / 27 * t + 16) / 116
    val fx = f(xyz[0] / 0.95047); val fy = f(xyz[1]); val fz = f(xyz[2] / 1.08883)
    return doubleArrayOf(116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))
}

fun ycbcr(r: Double, g: Double, b: Double, bt709: Boolean): DoubleArray {
    val kr = if (bt709) 0.2126 else 0.299; val kb = if (bt709) 0.0722 else 0.114
    val y = kr * r + (1 - kr - kb) * g + kb * b
    return doubleArrayOf(y, 128 + (b - y) / (2 * (1 - kb)), 128 + (r - y) / (2 * (1 - kr)))
}

fun ycbcrToRgb(y: Double, cb: Double, cr: Double, bt709: Boolean = false): DoubleArray {
    val kr = if (bt709) 0.2126 else 0.299; val kb = if (bt709) 0.0722 else 0.114
    val r = y + 2 * (1 - kr) * (cr - 128); val b = y + 2 * (1 - kb) * (cb - 128)
    return doubleArrayOf(r, (y - kr * r - kb * b) / (1 - kr - kb), b)
}

// ---------------------------------------------------------------- statistics
fun jsRoundD(v: Double) = floor(v + 0.5)

fun histogramPlane(p: FloatArray, bins: Int = 256): IntArray {
    val h = IntArray(bins)
    for (v in p) h[min(bins - 1, max(0, jsRoundD(v.toDouble()).toInt()))]++
    return h
}

fun percentileFromHist(h: IntArray, total: Int, q: Double): Int {
    val target = q * total
    var acc = 0.0
    for (i in h.indices) { acc += h[i]; if (acc >= target) return i }
    return h.size - 1
}

/** Equalization mapping from a histogram (CDF based). */
fun equalizeMap(h: IntArray, total: Int): FloatArray {
    val map = FloatArray(256)
    var acc = 0.0; var cdfMin = 0.0
    for (i in 0 until 256) if (h[i] != 0) { cdfMin = h[i].toDouble(); break }
    for (i in 0 until 256) { acc += h[i]; map[i] = (if (total > cdfMin) (acc - cdfMin) / (total - cdfMin) * 255 else i.toDouble()).toFloat() }
    return map
}

/** Contrast Limited Adaptive Histogram Equalization of a plane (0..255). */
fun clahe(p: FloatArray, w: Int, h: Int, tiles: Int, clip: Double): FloatArray {
    val tx = max(1, min(tiles, w)); val ty = max(1, min(tiles, h))
    val tw = w.toDouble() / tx; val th = h.toDouble() / ty
    val maps = arrayOfNulls<FloatArray>(tx * ty)
    Par.forEach(tx * ty) { idx ->
        val j = idx / tx; val i = idx % tx
        val x0 = floor(i * tw).toInt(); val x1 = floor((i + 1) * tw).toInt(); val y0 = floor(j * th).toInt(); val y1 = floor((j + 1) * th).toInt()
        val hist = DoubleArray(256)
        var n = 0
        for (y in y0 until y1) for (x in x0 until x1) { hist[min(255, max(0, jsRoundD(p[y * w + x].toDouble()).toInt()))]++; n++ }
        val limit = max(1.0, clip * n / 256)
        var excess = 0.0
        for (k in 0 until 256) if (hist[k] > limit) { excess += hist[k] - limit; hist[k] = limit }
        val add = excess / 256
        val map = FloatArray(256)
        var acc = 0.0
        for (k in 0 until 256) { acc += hist[k] + add; map[k] = (if (n != 0) acc / n * 255 else k.toDouble()).toFloat() }
        maps[idx] = map
    }
    val out = FloatArray(p.size)
    Par.forRows(h) { ya, yb ->
        for (y in ya until yb) {
            val gy = y / th - 0.5; val j0 = max(0, min(ty - 1, floor(gy).toInt())); val j1 = min(ty - 1, j0 + 1); val fy = max(0.0, min(1.0, gy - j0))
            for (x in 0 until w) {
                val gx = x / tw - 0.5; val i0 = max(0, min(tx - 1, floor(gx).toInt())); val i1 = min(tx - 1, i0 + 1); val fx = max(0.0, min(1.0, gx - i0))
                val v = min(255, max(0, jsRoundD(p[y * w + x].toDouble()).toInt()))
                val a = maps[j0 * tx + i0]!![v].toDouble(); val b = maps[j0 * tx + i1]!![v].toDouble()
                val c = maps[j1 * tx + i0]!![v].toDouble(); val d = maps[j1 * tx + i1]!![v].toDouble()
                out[y * w + x] = ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy).toFloat()
            }
        }
    }
    return out
}

// ---------------------------------------------------------------- tone LUTs (filters/luts.ts)
fun levelsLut(inBlack: Double, inWhite: Double, gamma: Double, outBlack: Double, outWhite: Double) = Lut({ v ->
    val span = max(1e-6, inWhite - inBlack)
    val t = min(1.0, max(0.0, (v - inBlack) / span))
    outBlack + t.pow(1 / max(0.01, gamma)) * (outWhite - outBlack)
})

/** Monotone cubic (Fritsch–Carlson) curve through control points. */
fun curveFunction(pts0: List<Pt>): (Double) -> Double {
    val sorted = pts0.sortedBy { it.x }
    val P = ArrayList<Pt>()
    for (p in sorted) if (P.isEmpty() || p.x > P.last().x + 1e-6) P.add(p)
    if (P.size < 2) return { it }
    val n = P.size
    val dx = DoubleArray(n - 1); val m = DoubleArray(n - 1); val t = DoubleArray(n)
    for (i in 0 until n - 1) { dx[i] = P[i + 1].x - P[i].x; m[i] = (P[i + 1].y - P[i].y) / dx[i] }
    t[0] = m[0]; t[n - 1] = m[n - 2]
    for (i in 1 until n - 1) t[i] = if (m[i - 1] * m[i] <= 0) 0.0 else (m[i - 1] + m[i]) / 2
    for (i in 0 until n - 1) {
        if (abs(m[i]) < 1e-12) { t[i] = 0.0; t[i + 1] = 0.0; continue }
        val a = t[i] / m[i]; val b = t[i + 1] / m[i]; val s = a * a + b * b
        if (s > 9) { val k = 3 / sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i] }
    }
    return { v ->
        if (v <= P[0].x) P[0].y
        else if (v >= P[n - 1].x) P[n - 1].y
        else {
            var i = 0
            while (i < n - 2 && v > P[i + 1].x) i++
            val h = dx[i]; val s = (v - P[i].x) / h; val s2 = s * s; val s3 = s2 * s
            (2 * s3 - 3 * s2 + 1) * P[i].y + (s3 - 2 * s2 + s) * h * t[i] + (-2 * s3 + 3 * s2) * P[i + 1].y + (s3 - s2) * h * t[i + 1]
        }
    }
}

fun brightnessContrastLut(brightness: Double, contrast: Double): Lut {
    val k = tan((contrast / 100 + 1) * Math.PI / 4)
    return Lut({ v -> (v - 127.5) * k + 127.5 + brightness })
}

fun exposureLut(exposure: Double, gamma: Double, offset: Double): Lut {
    val gain = 2.0.pow(exposure); val ig = 1 / max(0.01, gamma)
    return Lut({ v -> max(0.0, v / 255 * gain).pow(ig) * 255 + offset })
}
