package com.clearufo.forensics.engine.kernels

import com.clearufo.forensics.engine.Frame
import com.clearufo.forensics.engine.Par
import com.clearufo.forensics.engine.Pt
import com.clearufo.forensics.engine.jsRound
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

// Geometric transforms (port of kernels/geometry.ts): resampling, warping, homographies and template matching.

enum class Interp { NEAREST, BILINEAR, BICUBIC, LANCZOS; companion object { fun of(s: String?) = when (s) { "nearest" -> NEAREST; "bilinear" -> BILINEAR; "lanczos" -> LANCZOS; else -> BICUBIC } } }

private fun kernelOf(interp: Interp): Pair<(Double) -> Double, Double> = when (interp) {
    Interp.BILINEAR -> Pair({ x0: Double -> val x = abs(x0); if (x < 1) 1 - x else 0.0 }, 1.0)
    Interp.BICUBIC -> Pair({ x0: Double -> cubic(x0) }, 2.0)
    Interp.LANCZOS -> Pair({ x0: Double ->
        val x = abs(x0)
        if (x < 1e-8) 1.0 else if (x >= 3) 0.0 else { val px = PI * x; 3 * sin(px) * sin(px / 3) / (px * px) }
    }, 3.0)
    Interp.NEAREST -> Pair({ _: Double -> 1.0 }, 0.5)
}

fun cubic(x0: Double): Double {
    val a = -0.5
    val x = abs(x0)
    if (x < 1) return (a + 2) * x * x * x - (a + 3) * x * x + 1
    if (x < 2) return a * x * x * x - 5 * a * x * x + 8 * a * x - 4 * a
    return 0.0
}

private class Weights(val start: IntArray, val count: IntArray, val w: FloatArray, val maxTaps: Int)

private fun computeWeights(src: Int, dst: Int, interp: Interp): Weights {
    val scale = src.toDouble() / dst
    val (k, support) = kernelOf(interp)
    val fs = max(1.0, scale) // filter scale when downsampling (antialiasing)
    val sup = support * fs
    val maxTaps = ceil(sup * 2).toInt() + 2
    val start = IntArray(dst); val count = IntArray(dst); val w = FloatArray(dst * maxTaps)
    for (i in 0 until dst) {
        val center = (i + 0.5) * scale - 0.5
        val s = floor(center - sup).toInt() + 1; val e = floor(center + sup).toInt()
        var sum = 0.0; var c = 0
        val s0 = max(0, s); val e0 = min(src - 1, e)
        var j = s0
        while (j <= e0 && c < maxTaps) { val v = k((j - center) / fs); w[i * maxTaps + c] = v.toFloat(); sum += v; j++; c++ }
        if (c == 0) { w[i * maxTaps] = 1f; c = 1; sum = 1.0; start[i] = min(src - 1, max(0, jsRound(center))) } else start[i] = s0
        for (q in 0 until c) w[i * maxTaps + q] = (w[i * maxTaps + q] / (if (sum != 0.0) sum else 1.0)).toFloat()
        count[i] = c
    }
    return Weights(start, count, w, maxTaps)
}

fun resize(f: Frame, nw0: Int, nh0: Int, interp: Interp): Frame {
    val nw = max(1, nw0); val nh = max(1, nh0)
    if (nw == f.w && nh == f.h) return f.copy()
    if (interp == Interp.NEAREST) {
        val out = Frame.alloc(nw, nh, false)
        Par.forRows(nh) { y0, y1 ->
            for (y in y0 until y1) {
                val sy = min(f.h - 1, floor((y + 0.5) * f.h / nh).toInt())
                for (x in 0 until nw) {
                    val sx = min(f.w - 1, floor((x + 0.5) * f.w / nw).toInt())
                    val s = (sy * f.w + sx) * 4; val o = (y * nw + x) * 4
                    out.d[o] = f.d[s]; out.d[o + 1] = f.d[s + 1]; out.d[o + 2] = f.d[s + 2]; out.d[o + 3] = f.d[s + 3]
                }
            }
        }
        return out
    }
    val wx = computeWeights(f.w, nw, interp); val wy = computeWeights(f.h, nh, interp)
    val tmp = FloatArray(nw * f.h * 4)
    Par.forRows(f.h) { y0, y1 ->
        for (y in y0 until y1) {
            val row = y * f.w * 4
            for (x in 0 until nw) {
                var r = 0.0; var g = 0.0; var b = 0.0; var a = 0.0
                val st = wx.start[x]; val c = wx.count[x]; val base = x * wx.maxTaps
                for (j in 0 until c) {
                    val wt = wx.w[base + j].toDouble(); val s = row + (st + j) * 4
                    r += f.d[s] * wt; g += f.d[s + 1] * wt; b += f.d[s + 2] * wt; a += f.d[s + 3] * wt
                }
                val o = (y * nw + x) * 4
                tmp[o] = r.toFloat(); tmp[o + 1] = g.toFloat(); tmp[o + 2] = b.toFloat(); tmp[o + 3] = a.toFloat()
            }
        }
    }
    val out = Frame.alloc(nw, nh, false)
    Par.forRows(nh) { y0, y1 ->
        for (y in y0 until y1) {
            val st = wy.start[y]; val c = wy.count[y]; val base = y * wy.maxTaps
            for (x in 0 until nw) {
                var r = 0.0; var g = 0.0; var b = 0.0; var a = 0.0
                for (j in 0 until c) {
                    val wt = wy.w[base + j].toDouble(); val s = ((st + j) * nw + x) * 4
                    r += tmp[s] * wt; g += tmp[s + 1] * wt; b += tmp[s + 2] * wt; a += tmp[s + 3] * wt
                }
                val o = (y * nw + x) * 4
                out.d[o] = r.toFloat(); out.d[o + 1] = g.toFloat(); out.d[o + 2] = b.toFloat(); out.d[o + 3] = a.toFloat()
            }
        }
    }
    return out
}

/** Sample a frame at a sub-pixel position. Returns false when outside (and edge mode is off). */
/**
 * The part [x0, x0 + rw) × [y0, y0 + rh) of resize(f, nw, nh, interp), computed alone: the same weights and the same
 * arithmetic, so the values are identical to that region of the whole result (used to build large results in bands).
 */
fun resizeRegion(f: Frame, nw: Int, nh: Int, interp: Interp, x0: Int, y0: Int, rw: Int, rh: Int): Frame {
    require(interp != Interp.NEAREST && (nw != f.w || nh != f.h)) { "resizeRegion: use resize" }
    val wx = computeWeights(f.w, nw, interp); val wy = computeWeights(f.h, nh, interp)
    // source rows the output rows need
    var s0 = Int.MAX_VALUE; var s1 = -1
    for (y in y0 until y0 + rh) { s0 = min(s0, wy.start[y]); s1 = max(s1, wy.start[y] + wy.count[y] - 1) }
    val sr = s1 - s0 + 1
    val tmp = FloatArray(rw * sr * 4)
    Par.forRows(sr) { a, b ->
        for (yy in a until b) {
            val row = (yy + s0) * f.w * 4
            for (xx in 0 until rw) {
                val x = xx + x0
                var r = 0.0; var g = 0.0; var bl = 0.0; var al = 0.0
                val st = wx.start[x]; val c = wx.count[x]; val base = x * wx.maxTaps
                for (j in 0 until c) {
                    val wt = wx.w[base + j].toDouble(); val s = row + (st + j) * 4
                    r += f.d[s] * wt; g += f.d[s + 1] * wt; bl += f.d[s + 2] * wt; al += f.d[s + 3] * wt
                }
                val o = (yy * rw + xx) * 4
                tmp[o] = r.toFloat(); tmp[o + 1] = g.toFloat(); tmp[o + 2] = bl.toFloat(); tmp[o + 3] = al.toFloat()
            }
        }
    }
    val out = Frame.alloc(rw, rh, false)
    Par.forRows(rh) { a, b ->
        for (yy in a until b) {
            val y = yy + y0
            val st = wy.start[y] - s0; val c = wy.count[y]; val base = y * wy.maxTaps
            for (xx in 0 until rw) {
                var r = 0.0; var g = 0.0; var bl = 0.0; var al = 0.0
                for (j in 0 until c) {
                    val wt = wy.w[base + j].toDouble(); val s = ((st + j) * rw + xx) * 4
                    r += tmp[s] * wt; g += tmp[s + 1] * wt; bl += tmp[s + 2] * wt; al += tmp[s + 3] * wt
                }
                val o = (yy * rw + xx) * 4
                out.d[o] = r.toFloat(); out.d[o + 1] = g.toFloat(); out.d[o + 2] = bl.toFloat(); out.d[o + 3] = al.toFloat()
            }
        }
    }
    return out
}

fun sampleInto(f: Frame, x: Double, y: Double, interp: Interp, out: DoubleArray, edge: Boolean): Boolean {
    val w = f.w; val h = f.h; val d = f.d
    if (!edge && (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5)) return false
    fun cx(v: Int) = if (v < 0) 0 else if (v >= w) w - 1 else v
    fun cy(v: Int) = if (v < 0) 0 else if (v >= h) h - 1 else v
    when (interp) {
        Interp.NEAREST -> {
            val s = (cy(jsRound(y)) * w + cx(jsRound(x))) * 4
            out[0] = d[s].toDouble(); out[1] = d[s + 1].toDouble(); out[2] = d[s + 2].toDouble(); out[3] = d[s + 3].toDouble()
        }
        Interp.BILINEAR -> {
            val x0 = floor(x).toInt(); val y0 = floor(y).toInt(); val fx = x - x0; val fy = y - y0
            val a = (cy(y0) * w + cx(x0)) * 4; val b = (cy(y0) * w + cx(x0 + 1)) * 4; val c = (cy(y0 + 1) * w + cx(x0)) * 4; val e = (cy(y0 + 1) * w + cx(x0 + 1)) * 4
            for (k in 0 until 4) out[k] = (d[a + k] * (1 - fx) + d[b + k] * fx) * (1 - fy) + (d[c + k] * (1 - fx) + d[e + k] * fx) * fy
        }
        else -> {
            val x0 = floor(x).toInt(); val y0 = floor(y).toInt(); val fx = x - x0; val fy = y - y0
            out[0] = 0.0; out[1] = 0.0; out[2] = 0.0; out[3] = 0.0
            for (j in -1..2) {
                val wy = cubic(j - fy); val row = cy(y0 + j) * w
                for (i in -1..2) {
                    val wt = wy * cubic(i - fx); val s = (row + cx(x0 + i)) * 4
                    out[0] += d[s] * wt; out[1] += d[s + 1] * wt; out[2] += d[s + 2] * wt; out[3] += d[s + 3] * wt
                }
            }
        }
    }
    return true
}

/** Inverse warping: for each output pixel `map` writes the source position into `p`. Rows in parallel. */
fun warp(f: Frame, ow: Int, oh: Int, interp: Interp, bg: IntArray = intArrayOf(0, 0, 0), edge: Boolean = false, map: (Int, Int, DoubleArray) -> Unit): Frame {
    val out = Frame.alloc(ow, oh, true)
    Par.forRows(oh) { y0, y1 ->
        val p = DoubleArray(2); val s = DoubleArray(4)
        for (y in y0 until y1) for (x in 0 until ow) {
            map(x, y, p)
            val o = (y * ow + x) * 4
            if (sampleInto(f, p[0], p[1], interp, s, edge)) { out.d[o] = s[0].toFloat(); out.d[o + 1] = s[1].toFloat(); out.d[o + 2] = s[2].toFloat() }
            else { out.d[o] = bg[0].toFloat(); out.d[o + 1] = bg[1].toFloat(); out.d[o + 2] = bg[2].toFloat() }
        }
    }
    return out
}

fun translate(f: Frame, dx: Double, dy: Double, edge: Boolean): Frame {
    if (abs(dx) < 1e-6 && abs(dy) < 1e-6) return f
    return warp(f, f.w, f.h, Interp.BILINEAR, intArrayOf(0, 0, 0), edge) { x, y, p -> p[0] = x - dx; p[1] = y - dy }
}

/** Solve the 3x3 homography H mapping src[i] → dst[i] (4 correspondences). */
fun homography(src: List<Pt>, dst: List<Pt>): DoubleArray {
    val A = Array(8) { DoubleArray(9) }
    for (i in 0 until 4) {
        val x = src[i].x; val y = src[i].y; val u = dst[i].x; val v = dst[i].y
        A[2 * i] = doubleArrayOf(x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, u)
        A[2 * i + 1] = doubleArrayOf(0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, v)
    }
    for (c in 0 until 8) {
        var piv = c
        for (r in c + 1 until 8) if (abs(A[r][c]) > abs(A[piv][c])) piv = r
        val t = A[c]; A[c] = A[piv]; A[piv] = t
        if (abs(A[c][c]) < 1e-12) throw IllegalArgumentException("Degenerate point configuration")
        for (r in 0 until 8) {
            if (r == c) continue
            val k = A[r][c] / A[c][c]
            for (j in c until 9) A[r][j] -= k * A[c][j]
        }
    }
    return DoubleArray(9) { i -> if (i == 8) 1.0 else A[i][8] / A[i][i] }
}

fun applyH(H: DoubleArray, x: Double, y: Double): DoubleArray {
    val w = H[6] * x + H[7] * y + H[8]
    return doubleArrayOf((H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w)
}

class Match(val x: Double, val y: Double, val score: Double)

/**
 * Normalized cross-correlation search of `tpl` around (cx, cy) ± search; returns the best top-left position
 * (sub-pixel). Rows of the search window run in parallel; the first best position in scan order wins, exactly as a
 * single-thread scan.
 */
fun matchTemplate(img: FloatArray, iw: Int, ih: Int, tpl: FloatArray, tw: Int, th: Int, cx: Double, cy: Double, search: Double, cancel: () -> Boolean = { false }): Match {
    var tm = 0.0
    for (v in tpl) tm += v
    tm /= tpl.size
    val t = FloatArray(tpl.size)
    var tn = 0.0
    for (i in tpl.indices) { t[i] = (tpl[i] - tm).toFloat(); tn += t[i].toDouble() * t[i] }
    tn = sqrt(tn).let { if (it != 0.0) it else 1.0 }
    val x0 = max(0, jsRound(cx - search)); val x1 = min(iw - tw, jsRound(cx + search))
    val y0 = max(0, jsRound(cy - search)); val y1 = min(ih - th, jsRound(cy + search))
    if (x1 < x0 || y1 < y0) return Match(cx, cy, 0.0)
    val sw = x1 - x0 + 1; val sh = y1 - y0 + 1
    val scores = FloatArray(sw * sh)
    val n = tw * th
    Par.forRows(sh, grain = 1) { ra, rb ->
        if (cancel()) throw Cancelled()
        for (yy in ra until rb) {
            val y = y0 + yy
            for (x in x0..x1) {
                var s = 0.0; var s2 = 0.0; var cross = 0.0
                for (j in 0 until th) {
                    val row = (y + j) * iw + x; val trow = j * tw
                    for (i in 0 until tw) { val v = img[row + i].toDouble(); s += v; s2 += v * v; cross += v * t[trow + i] }
                }
                val varI = s2 - s * s / n
                scores[yy * sw + (x - x0)] = (if (varI > 1e-9) cross / (sqrt(varI) * tn) else 0.0).toFloat()
            }
        }
    }
    var best = -2.0; var bx = x0; var by = y0
    for (yy in 0 until sh) for (xx in 0 until sw) { val v = scores[yy * sw + xx].toDouble(); if (v > best) { best = v; bx = x0 + xx; by = y0 + yy } }
    fun at(x: Int, y: Int) = scores[min(sh - 1, max(0, y - y0)) * sw + min(sw - 1, max(0, x - x0))].toDouble()
    fun sub(m: Double, c: Double, p: Double): Double { val d = m - 2 * c + p; return if (abs(d) < 1e-9) 0.0 else max(-0.5, min(0.5, 0.5 * (m - p) / d)) }
    val sx = if (bx > x0 && bx < x1) sub(at(bx - 1, by), best, at(bx + 1, by)) else 0.0
    val sy = if (by > y0 && by < y1) sub(at(bx, by - 1), best, at(bx, by + 1)) else 0.0
    return Match(bx + sx, by + sy, best)
}

class Plane(val d: FloatArray, val w: Int, val h: Int)

/** Downscale a plane by an integer factor (box average). */
fun downPlane(p: FloatArray, w: Int, h: Int, k: Int): Plane {
    val nw = max(1, w / k); val nh = max(1, h / k)
    val out = FloatArray(nw * nh)
    for (y in 0 until nh) for (x in 0 until nw) {
        var s = 0.0
        for (j in 0 until k) for (i in 0 until k) s += p[(y * k + j) * w + x * k + i]
        out[y * nw + x] = (s / (k * k)).toFloat()
    }
    return Plane(out, nw, nh)
}
