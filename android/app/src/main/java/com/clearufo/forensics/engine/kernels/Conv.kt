package com.clearufo.forensics.engine.kernels

import com.clearufo.forensics.engine.Frame
import com.clearufo.forensics.engine.Par
import com.clearufo.forensics.engine.clampi
import com.clearufo.forensics.engine.luma
import com.clearufo.forensics.engine.mapRGB
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

// Spatial filtering kernels on planar float data (edge pixels replicated), port of kernels/conv.ts.
// Every output row is computed by the same expression whatever the row banding, so the multi-core results are
// identical to a single-thread run.

class Cancelled : Exception("Cancelled")

fun boxBlurPlane(src: FloatArray, w: Int, h: Int, r: Int): FloatArray {
    if (r < 1) return src.copyOf()
    val tmp = FloatArray(src.size); val dst = FloatArray(src.size)
    val inv = 1.0 / (2 * r + 1)
    Par.forRows(h) { y0, y1 ->
        for (y in y0 until y1) {
            val row = y * w
            var acc = 0.0
            for (k in -r..r) acc += src[row + clampi(k, 0, w - 1)]
            for (x in 0 until w) {
                tmp[row + x] = (acc * inv).toFloat()
                acc += src[row + min(x + r + 1, w - 1)] - src[row + max(x - r, 0)].toDouble()
            }
        }
    }
    Par.forRows(w) { x0, x1 ->
        for (x in x0 until x1) {
            var acc = 0.0
            for (k in -r..r) acc += tmp[clampi(k, 0, h - 1) * w + x]
            for (y in 0 until h) {
                dst[y * w + x] = (acc * inv).toFloat()
                acc += tmp[min(y + r + 1, h - 1) * w + x] - tmp[max(y - r, 0) * w + x].toDouble()
            }
        }
    }
    return dst
}

fun gaussKernel(sigma: Double): FloatArray {
    val r = max(1, ceil(sigma * 3).toInt())
    val k = FloatArray(2 * r + 1)
    var s = 0.0
    for (i in -r..r) { val v = exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v.toFloat(); s += v }
    for (i in k.indices) k[i] = (k[i] / s).toFloat()
    return k
}

fun convolveSep(src: FloatArray, w: Int, h: Int, kx: FloatArray, ky: FloatArray): FloatArray {
    val rx = kx.size shr 1; val ry = ky.size shr 1
    val tmp = FloatArray(w * h); val dst = FloatArray(w * h)
    Par.forRows(h) { y0, y1 ->
        for (y in y0 until y1) {
            val row = y * w
            for (x in 0 until w) {
                var a = 0.0
                if (x >= rx && x < w - rx) { val base = row + x - rx; for (k in kx.indices) a += src[base + k].toDouble() * kx[k] }
                else for (k in kx.indices) a += src[row + clampi(x + k - rx, 0, w - 1)].toDouble() * kx[k]
                tmp[row + x] = a.toFloat()
            }
        }
    }
    Par.forRows(h) { y0, y1 ->
        for (y in y0 until y1) {
            val orow = y * w
            for (x in 0 until w) {
                var a = 0.0
                if (y >= ry && y < h - ry) { var idx = (y - ry) * w + x; for (k in ky.indices) { a += tmp[idx].toDouble() * ky[k]; idx += w } }
                else for (k in ky.indices) a += tmp[clampi(y + k - ry, 0, h - 1) * w + x].toDouble() * ky[k]
                dst[orow + x] = a.toFloat()
            }
        }
    }
    return dst
}

/** Gaussian blur; large sigmas use three box passes (≈ Gaussian, O(1) per pixel). */
fun blurPlane(src: FloatArray, w: Int, h: Int, sigma: Double): FloatArray {
    if (sigma <= 0.05) return src.copyOf()
    if (sigma <= 3) { val k = gaussKernel(sigma); return convolveSep(src, w, h, k, k) }
    val n = 3
    val wIdeal = sqrt(12 * sigma * sigma / n + 1)
    var wl = floor(wIdeal).toInt()
    if (wl % 2 == 0) wl--
    val wu = wl + 2
    val m = Math.floor((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4) + 0.5).toInt()
    var out = src
    for (i in 0 until n) out = boxBlurPlane(out, w, h, ((if (i < m) wl else wu) - 1) / 2)
    return out
}

fun gaussianBlur(f: Frame, sigma: Double) = mapRGB(f) { blurPlane(it, f.w, f.h, sigma) }
fun boxBlur(f: Frame, r: Int) = mapRGB(f) { boxBlurPlane(it, f.w, f.h, r) }

fun conv3x3(src: FloatArray, w: Int, h: Int, k: DoubleArray): FloatArray {
    val dst = FloatArray(src.size)
    Par.forRows(h) { ya, yb ->
        for (y in ya until yb) {
            val y0 = max(0, y - 1); val y2 = min(h - 1, y + 1)
            for (x in 0 until w) {
                val x0 = max(0, x - 1); val x2 = min(w - 1, x + 1)
                dst[y * w + x] = (k[0] * src[y0 * w + x0] + k[1] * src[y0 * w + x] + k[2] * src[y0 * w + x2] +
                    k[3] * src[y * w + x0] + k[4] * src[y * w + x] + k[5] * src[y * w + x2] +
                    k[6] * src[y2 * w + x0] + k[7] * src[y2 * w + x] + k[8] * src[y2 * w + x2]).toFloat()
            }
        }
    }
    return dst
}

// ---------------------------------------------------------------- median
private fun median3Rows(src: FloatArray, w: Int, h: Int, y0: Int, y1: Int, dst: FloatArray) {
    for (y in y0 until y1) {
        val r0 = max(0, y - 1) * w; val r1 = y * w; val r2 = min(h - 1, y + 1) * w
        for (x in 0 until w) {
            val xl = if (x > 0) x - 1 else 0; val xr = if (x < w - 1) x + 1 else w - 1
            var p0 = src[r0 + xl]; var p1 = src[r0 + x]; var p2 = src[r0 + xr]
            var p3 = src[r1 + xl]; var p4 = src[r1 + x]; var p5 = src[r1 + xr]
            var p6 = src[r2 + xl]; var p7 = src[r2 + x]; var p8 = src[r2 + xr]
            var t: Float
            // 19 compare-exchange median-of-9 network (Paeth / Devillard)
            if (p1 > p2) { t = p1; p1 = p2; p2 = t }; if (p4 > p5) { t = p4; p4 = p5; p5 = t }; if (p7 > p8) { t = p7; p7 = p8; p8 = t }
            if (p0 > p1) { t = p0; p0 = p1; p1 = t }; if (p3 > p4) { t = p3; p3 = p4; p4 = t }; if (p6 > p7) { t = p6; p6 = p7; p7 = t }
            if (p1 > p2) { t = p1; p1 = p2; p2 = t }; if (p4 > p5) { t = p4; p4 = p5; p5 = t }; if (p7 > p8) { t = p7; p7 = p8; p8 = t }
            if (p0 > p3) { t = p0; p0 = p3; p3 = t }; if (p5 > p8) { t = p5; p5 = p8; p8 = t }; if (p4 > p7) { t = p4; p4 = p7; p7 = t }
            if (p3 > p6) { t = p3; p3 = p6; p6 = t }; if (p1 > p4) { t = p1; p1 = p4; p4 = t }; if (p2 > p5) { t = p2; p2 = p5; p5 = t }
            if (p4 > p7) { t = p4; p4 = p7; p7 = t }; if (p4 > p2) { t = p4; p4 = p2; p2 = t }; if (p6 > p4) { t = p6; p6 = p4; p4 = t }
            if (p4 > p2) { p4 = p2 }
            dst[y * w + x] = p4
        }
    }
}

/** Huang's sliding histogram median (values quantized to 0..255); radius 1 uses the exact 3x3 network. */
fun medianPlane(src: FloatArray, w: Int, h: Int, r: Int): FloatArray {
    val dst = FloatArray(w * h)
    if (r <= 1) { Par.forRows(h) { a, b -> median3Rows(src, w, h, a, b, dst) }; return dst }
    val q = ByteArray(src.size)
    for (i in src.indices) q[i] = clampi(jsRoundD(src[i].toDouble()).toInt(), 0, 255).toByte()
    val half = ((2 * r + 1) * (2 * r + 1)) shr 1
    Par.forRows(h) { ya, yb ->
        val hist = IntArray(256)
        for (y in ya until yb) {
            hist.fill(0)
            for (dy in -r..r) { val row = clampi(y + dy, 0, h - 1) * w; for (dx in -r..r) hist[q[row + clampi(dx, 0, w - 1)].toInt() and 255]++ }
            var med = 0; var acc = 0
            while (med < 256) { if (acc + hist[med] > half) break; acc += hist[med]; med++ }
            var below = acc
            for (x in 0 until w) {
                dst[y * w + x] = med.toFloat()
                if (x == w - 1) break
                val xo = clampi(x - r, 0, w - 1); val xi = clampi(x + r + 1, 0, w - 1)
                for (dy in -r..r) {
                    val row = clampi(y + dy, 0, h - 1) * w
                    val vo = q[row + xo].toInt() and 255; val vi = q[row + xi].toInt() and 255
                    hist[vo]--; if (vo < med) below--
                    hist[vi]++; if (vi < med) below++
                }
                while (below > half) { med--; below -= hist[med] }
                while (below + hist[med] <= half) { below += hist[med]; med++ }
            }
        }
    }
    return dst
}

fun medianFilter(f: Frame, r: Int) = mapRGB(f) { medianPlane(it, f.w, f.h, r) }

// ---------------------------------------------------------------- bilateral (luma guided range weights)
fun bilateral(f: Frame, sigmaS: Double, sigmaR: Double, cancel: () -> Boolean = { false }): Frame {
    val w = f.w; val h = f.h; val d = f.d
    val r = max(1, ceil(sigmaS * 2).toInt())
    val Y = luma(f)
    val sw = FloatArray((2 * r + 1) * (2 * r + 1))
    for (dy in -r..r) for (dx in -r..r) sw[(dy + r) * (2 * r + 1) + dx + r] = exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS)).toFloat()
    val rw = FloatArray(512)
    for (i in 0 until 512) rw[i] = exp(-(i.toDouble() * i) / (2 * sigmaR * sigmaR)).toFloat()
    val out = FloatArray(d.size)
    Par.forRows(h) { y0, y1 ->
        for (y in y0 until y1) {
            if (cancel()) throw Cancelled()
            for (x in 0 until w) {
                val c = y * w + x
                val yc = Y[c]
                var ws = 0.0; var ar = 0.0; var ag = 0.0; var ab = 0.0
                for (dy in -r..r) {
                    val yy = clampi(y + dy, 0, h - 1)
                    for (dx in -r..r) {
                        val idx = yy * w + clampi(x + dx, 0, w - 1)
                        val wt = sw[(dy + r) * (2 * r + 1) + dx + r].toDouble() * rw[min(511, abs(Y[idx] - yc).toInt())]
                        val k = idx * 4
                        ws += wt; ar += d[k] * wt; ag += d[k + 1] * wt; ab += d[k + 2] * wt
                    }
                }
                val o = c * 4
                out[o] = (ar / ws).toFloat(); out[o + 1] = (ag / ws).toFloat(); out[o + 2] = (ab / ws).toFloat(); out[o + 3] = d[o + 3]
            }
        }
    }
    return Frame(w, h, out)
}

// ---------------------------------------------------------------- non-local means (integral image formulation)
fun nlMeans(f: Frame, hParam: Double, patch: Int, search: Int, cancel: () -> Boolean = { false }): Frame {
    val w = f.w; val h = f.h; val d = f.d
    val Y = luma(f)
    val n = w * h
    val area = (2 * patch + 1) * (2 * patch + 1)
    val h2 = hParam * hParam
    val out = FloatArray(n * 4)
    // Fixed 32-row bands (independent of the core count, so every device computes the same numbers); each band
    // accumulates the integral image of squared differences from the first row its patches need.
    val BAND = 32
    val bands = (h + BAND - 1) / BAND
    Par.forEach(bands) { b ->
        val y0 = b * BAND; val y1 = min(h, y0 + BAND)
        val r0 = max(0, y0 - patch); val rows = min(h, y1 + patch) - r0
        val m = (y1 - y0) * w
        val accR = DoubleArray(m); val accG = DoubleArray(m); val accB = DoubleArray(m); val wsum = DoubleArray(m); val wmax = DoubleArray(m)
        val diff = DoubleArray((w + 1) * (rows + 1))
        for (dy in -search..search) for (dx in -search..search) {
            if (dx == 0 && dy == 0) continue
            if (cancel()) throw Cancelled()
            for (yr in 0 until rows) {
                val y = r0 + yr
                var rowSum = 0.0
                val yy = clampi(y + dy, 0, h - 1)
                for (x in 0 until w) {
                    val t = Y[y * w + x].toDouble() - Y[yy * w + clampi(x + dx, 0, w - 1)]
                    rowSum += t * t
                    diff[(yr + 1) * (w + 1) + x + 1] = diff[yr * (w + 1) + x + 1] + rowSum
                }
            }
            for (y in y0 until y1) {
                val ya = max(0, y - patch) - r0; val yb = min(h - 1, y + patch) + 1 - r0
                val yy = clampi(y + dy, 0, h - 1)
                for (x in 0 until w) {
                    val x0 = max(0, x - patch); val x1 = min(w - 1, x + patch) + 1
                    val cnt = (yb - ya) * (x1 - x0)
                    val ssd = (diff[yb * (w + 1) + x1] - diff[ya * (w + 1) + x1] - diff[yb * (w + 1) + x0] + diff[ya * (w + 1) + x0]) / (if (cnt != 0) cnt else area)
                    val wt = exp(-ssd / h2)
                    val i = (y - y0) * w + x
                    val k = (yy * w + clampi(x + dx, 0, w - 1)) * 4
                    accR[i] += wt * d[k]; accG[i] += wt * d[k + 1]; accB[i] += wt * d[k + 2]
                    wsum[i] += wt
                    if (wt > wmax[i]) wmax[i] = wt
                }
            }
        }
        for (i in 0 until m) {
            val wc = if (wmax[i] != 0.0) wmax[i] else 1.0
            val k = (y0 * w + i) * 4; val ws = wsum[i] + wc
            out[k] = ((accR[i] + wc * d[k]) / ws).toFloat(); out[k + 1] = ((accG[i] + wc * d[k + 1]) / ws).toFloat(); out[k + 2] = ((accB[i] + wc * d[k + 2]) / ws).toFloat(); out[k + 3] = d[k + 3]
        }
    }
    return Frame(w, h, out)
}

// ---------------------------------------------------------------- adaptive Wiener (Lim)
fun wienerPlane(p: FloatArray, w: Int, h: Int, r: Int, noise: Double): FloatArray {
    val sq = FloatArray(p.size)
    for (i in p.indices) sq[i] = p[i] * p[i]
    val mu = boxBlurPlane(p, w, h, r); val mu2 = boxBlurPlane(sq, w, h, r)
    val vari = FloatArray(p.size)
    var mean = 0.0
    for (i in p.indices) { vari[i] = max(0.0, mu2[i].toDouble() - mu[i].toDouble() * mu[i]).toFloat(); mean += vari[i] }
    val nv = if (noise > 0) noise else mean / p.size
    val out = FloatArray(p.size)
    val nvg = if (nv != 0.0) nv else 1e-6
    for (i in p.indices) out[i] = (mu[i] + max(0.0, vari[i] - nv) / max(vari[i].toDouble(), nvg) * (p[i] - mu[i])).toFloat()
    return out
}

fun wienerAdaptive(f: Frame, r: Int, noise: Double) = mapRGB(f) { wienerPlane(it, f.w, f.h, r, noise) }

// ---------------------------------------------------------------- deblocking
fun deblock(f: Frame, B: Int, strength: Double, thr: Double): Frame {
    val w = f.w; val h = f.h
    val beta = thr / 2; val tc = thr / 2 * strength
    fun filt(p: FloatArray, base: Int, stride: Int, len: Int, at: Int) {
        if (at < 2 || at > len - 2) return
        val i1 = base + (at - 2) * stride; val i0 = base + (at - 1) * stride; val j0 = base + at * stride; val j1 = base + (at + 1) * stride
        val p1 = p[i1].toDouble(); val p0 = p[i0].toDouble(); val q0 = p[j0].toDouble(); val q1 = p[j1].toDouble()
        if (abs(p0 - q0) >= thr || abs(p1 - p0) >= beta || abs(q1 - q0) >= beta) return
        var delta = ((q0 - p0) * 4 + (p1 - q1)) / 8
        delta = max(-tc, min(tc, delta)) * strength + delta * (1 - strength) * 0.25
        p[i0] = (p0 + delta).toFloat(); p[j0] = (q0 - delta).toFloat()
        p[i1] = (p1 + delta * 0.5 * strength).toFloat(); p[j1] = (q1 - delta * 0.5 * strength).toFloat()
    }
    return mapRGB(f) { src ->
        val p = src.copyOf()
        for (y in 0 until h) { var x = B; while (x < w) { filt(p, y * w, 1, w, x); x += B } }
        for (x in 0 until w) { var y = B; while (y < h) { filt(p, x, w, h, y); y += B } }
        p
    }
}

