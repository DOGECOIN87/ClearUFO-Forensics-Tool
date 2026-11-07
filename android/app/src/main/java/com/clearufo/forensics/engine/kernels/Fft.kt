package com.clearufo.forensics.engine.kernels

import com.clearufo.forensics.engine.Frame
import com.clearufo.forensics.engine.Par
import com.clearufo.forensics.engine.Pt
import com.clearufo.forensics.engine.luma
import com.clearufo.forensics.engine.merge
import com.clearufo.forensics.engine.split
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.ln1p
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

// FFT based processing (port of kernels/fft.ts): deconvolution (Wiener, Tikhonov, Richardson–Lucy), spectrum display
// and frequency domain filtering. Two real channels are packed into one complex transform (R + iG) since all filters
// used here have Hermitian transfer functions. Row and column transforms run on all cores; each 1-D transform is the
// same computation whatever the thread count.

private class Table(val cos: DoubleArray, val sin: DoubleArray, val nsin: DoubleArray, val rev: IntArray)
private val tables = ConcurrentHashMap<Int, Table>()

private fun table(n: Int): Table = tables.getOrPut(n) {
    val bits = Integer.numberOfTrailingZeros(n)
    val rev = IntArray(n)
    for (i in 0 until n) { var r = 0; for (b in 0 until bits) r = r or (((i shr b) and 1) shl (bits - 1 - b)); rev[i] = r }
    val c = DoubleArray(n / 2); val s = DoubleArray(n / 2); val ns = DoubleArray(n / 2)
    for (i in 0 until n / 2) { c[i] = cos(2 * PI * i / n); s[i] = sin(2 * PI * i / n); ns[i] = -s[i] }
    Table(c, s, ns, rev)
}

fun nextPow2(v: Int): Int { var p = 2; while (p < v) p = p shl 1; return p }

/** In-place radix-2 FFT of re/im[off, off + n) with stride 1. */
fun fft(re: DoubleArray, im: DoubleArray, off: Int, n: Int, inverse: Boolean) {
    val t = table(n)
    val c = t.cos; val sn = if (inverse) t.sin else t.nsin; val rev = t.rev
    for (i in 0 until n) {
        val j = rev[i]
        if (j > i) { var x = re[off + i]; re[off + i] = re[off + j]; re[off + j] = x; x = im[off + i]; im[off + i] = im[off + j]; im[off + j] = x }
    }
    var size = 2
    while (size <= n) {
        val half = size shr 1; val step = n / size
        var i = 0
        while (i < n) {
            var k = 0
            for (j in 0 until half) {
                val cc = c[k]; val ss = sn[k]
                val a = off + i + j; val b = a + half
                val tre = re[b] * cc - im[b] * ss; val tim = re[b] * ss + im[b] * cc
                re[b] = re[a] - tre; im[b] = im[a] - tim
                re[a] += tre; im[a] += tim
                k += step
            }
            i += size
        }
        size = size shl 1
    }
    if (inverse) for (i in 0 until n) { re[off + i] /= n; im[off + i] /= n }
}

fun fft2(re: DoubleArray, im: DoubleArray, W: Int, H: Int, inverse: Boolean) {
    Par.forRows(H) { y0, y1 -> for (y in y0 until y1) fft(re, im, y * W, W, inverse) }
    Par.forRows(W, grain = 8) { x0, x1 ->
        val cr = DoubleArray(H); val ci = DoubleArray(H)
        for (x in x0 until x1) {
            for (y in 0 until H) { cr[y] = re[y * W + x]; ci[y] = im[y * W + x] }
            fft(cr, ci, 0, H, inverse)
            for (y in 0 until H) { re[y * W + x] = cr[y]; im[y * W + x] = ci[y] }
        }
    }
}

private fun reflect(i0: Int, n: Int): Int { val p = 2 * n; val i = ((i0 % p) + p) % p; return if (i < n) i else p - 1 - i }

private fun padReflect(src: FloatArray, w: Int, h: Int, W: Int, H: Int, ox: Int, oy: Int): DoubleArray {
    val out = DoubleArray(W * H)
    for (y in 0 until H) { val sy = reflect(y - oy, h) * w; for (x in 0 until W) out[y * W + x] = src[sy + reflect(x - ox, w)].toDouble() }
    return out
}

private fun cropOut(src: DoubleArray, W: Int, w: Int, h: Int, ox: Int, oy: Int): FloatArray {
    val out = FloatArray(w * h)
    for (y in 0 until h) for (x in 0 until w) out[y * w + x] = src[(y + oy) * W + x + ox].toFloat()
    return out
}

private class Otf(val re: DoubleArray, val im: DoubleArray)

private fun otf(psf: Psf, W: Int, H: Int): Otf {
    val re = DoubleArray(W * H); val im = DoubleArray(W * H)
    val cx = psf.w shr 1; val cy = psf.h shr 1
    for (y in 0 until psf.h) for (x in 0 until psf.w) {
        val X = ((x - cx) % W + W) % W; val Y = ((y - cy) % H + H) % H
        re[Y * W + X] += psf.d[y * psf.w + x].toDouble()
    }
    fft2(re, im, W, H, false)
    return Otf(re, im)
}

/** Apply a complex frequency response to up to two real planes at once. */
private fun filterPair(a: FloatArray, b: FloatArray?, w: Int, h: Int, W: Int, H: Int, ox: Int, oy: Int, fre: DoubleArray, fim: DoubleArray): Pair<FloatArray, FloatArray?> {
    val zr = padReflect(a, w, h, W, H, ox, oy)
    val zi = if (b != null) padReflect(b, w, h, W, H, ox, oy) else DoubleArray(W * H)
    fft2(zr, zi, W, H, false)
    for (i in zr.indices) { val r = zr[i]; val m = zi[i]; zr[i] = r * fre[i] - m * fim[i]; zi[i] = r * fim[i] + m * fre[i] }
    fft2(zr, zi, W, H, true)
    return cropOut(zr, W, w, h, ox, oy) to (if (b != null) cropOut(zi, W, w, h, ox, oy) else null)
}

enum class DeconvMethod { WIENER, RL, TIKHONOV; companion object { fun of(s: String) = when (s) { "rl" -> RL; "tikhonov" -> TIKHONOV; else -> WIENER } } }

private class DeconvSetup(val w: Int, val h: Int, val pw: Int, val ph: Int, val ox: Int, val oy: Int, val T: Otf, val fre: DoubleArray?, val fim: DoubleArray?)

private fun deconvSetup(w: Int, h: Int, psf: Psf, method: DeconvMethod, K: Double): DeconvSetup {
    val pad = max(16, max(psf.w, psf.h) * 2)
    val W = nextPow2(w + 2 * pad); val H = nextPow2(h + 2 * pad)
    val ox = (W - w) shr 1; val oy = (H - h) shr 1
    val T = otf(psf, W, H)
    var fre: DoubleArray? = null; var fim: DoubleArray? = null
    if (method != DeconvMethod.RL) {
        fre = DoubleArray(W * H); fim = DoubleArray(W * H)
        for (y in 0 until H) for (x in 0 until W) {
            val i = y * W + x
            val hr = T.re[i]; val hi = T.im[i]
            var reg = K
            if (method == DeconvMethod.TIKHONOV) { val l = 4 - 2 * cos(2 * PI * x / W) - 2 * cos(2 * PI * y / H); reg = K * l * l / 4 + 1e-9 }
            val den = hr * hr + hi * hi + reg
            fre[i] = hr / den; fim[i] = -hi / den
        }
    }
    return DeconvSetup(w, h, W, H, ox, oy, T, fre, fim)
}

private fun deconvPair(S: DeconvSetup, p1: FloatArray, p2: FloatArray?, method: DeconvMethod, K: Double, iterations: Int, progress: ((Double) -> Unit)?, pBase: Double, pSpan: Double, cancel: () -> Boolean): Pair<FloatArray, FloatArray?> {
    val w = S.w; val h = S.h; val W = S.pw; val H = S.ph; val ox = S.ox; val oy = S.oy; val T = S.T
    if (method != DeconvMethod.RL) return filterPair(p1, p2, w, h, W, H, ox, oy, S.fre!!, S.fim!!)
    val n = W * H
    val g1 = padReflect(p1, w, h, W, H, ox, oy); val g2 = if (p2 != null) padReflect(p2, w, h, W, H, ox, oy) else DoubleArray(n)
    for (i in 0 until n) { g1[i] = max(g1[i], 0.5); g2[i] = max(g2[i], 0.5) }
    val u1 = g1.copyOf(); val u2 = g2.copyOf()
    val zr = DoubleArray(n); val zi = DoubleArray(n)
    val damp = min(0.5, K * 2) // damping toward the observation controls noise amplification (K acts as a regularizer)
    for (it in 0 until iterations) {
        if (cancel()) throw Cancelled()
        System.arraycopy(u1, 0, zr, 0, n); System.arraycopy(u2, 0, zi, 0, n)
        fft2(zr, zi, W, H, false)
        for (i in 0 until n) { val a0 = zr[i]; val b0 = zi[i]; zr[i] = a0 * T.re[i] - b0 * T.im[i]; zi[i] = a0 * T.im[i] + b0 * T.re[i] }
        fft2(zr, zi, W, H, true)
        for (i in 0 until n) { zr[i] = g1[i] / max(zr[i], 1e-3); zi[i] = g2[i] / max(zi[i], 1e-3) }
        fft2(zr, zi, W, H, false)
        for (i in 0 until n) { val a0 = zr[i]; val b0 = zi[i]; zr[i] = a0 * T.re[i] + b0 * T.im[i]; zi[i] = -a0 * T.im[i] + b0 * T.re[i] }
        fft2(zr, zi, W, H, true)
        for (i in 0 until n) { u1[i] = max(0.0, u1[i] * (zr[i] * (1 - damp) + damp)); u2[i] = max(0.0, u2[i] * (zi[i] * (1 - damp) + damp)) }
        progress?.invoke(pBase + pSpan * (it + 1) / iterations)
    }
    return cropOut(u1, W, w, h, ox, oy) to (if (p2 != null) cropOut(u2, W, w, h, ox, oy) else null)
}

fun deconvolve(f: Frame, psf: Psf, method: DeconvMethod, K: Double, iterations: Int, progress: ((Double) -> Unit)? = null, cancel: () -> Boolean = { false }): Frame {
    val S = deconvSetup(f.w, f.h, psf, method, K)
    val (r, g, b, a) = split(f)
    progress?.invoke(0.1)
    val (or, og) = deconvPair(S, r, g, method, K, iterations, progress, 0.0, 0.66, cancel)
    val (ob, _) = deconvPair(S, b, null, method, K, iterations, progress, 0.66, 0.34, cancel)
    return merge(f.w, f.h, or, og!!, ob, a)
}

/** Centered log-magnitude (or phase) spectrum resampled to the frame size. */
fun spectrum(plane: FloatArray, w: Int, h: Int, phase: Boolean, log: Boolean): FloatArray {
    val W = nextPow2(w); val H = nextPow2(h)
    val re = padReflect(plane, w, h, W, H, 0, 0); val im = DoubleArray(W * H)
    var mean = 0.0
    for (v in re) mean += v
    mean /= re.size
    for (i in re.indices) re[i] -= mean
    fft2(re, im, W, H, false)
    val mag = DoubleArray(W * H)
    var mx = 0.0
    for (y in 0 until H) for (x in 0 until W) {
        val sx = (x + W / 2) % W; val sy = (y + H / 2) % H
        val i = sy * W + sx
        var v = if (phase) atan2(im[i], re[i]) else hypot(re[i], im[i])
        if (!phase && log) v = ln1p(v)
        mag[y * W + x] = v
        if (!phase && v > mx) mx = v
    }
    val out = FloatArray(w * h)
    for (y in 0 until h) for (x in 0 until w) {
        val fx = (x + 0.5) * W / w - 0.5; val fy = (y + 0.5) * H / h - 0.5
        val x0 = max(0, min(W - 1, floor(fx).toInt())); val y0 = max(0, min(H - 1, floor(fy).toInt()))
        val x1 = min(W - 1, x0 + 1); val y1 = min(H - 1, y0 + 1); val ax = fx - x0; val ay = fy - y0
        val v = (mag[y0 * W + x0] * (1 - ax) + mag[y0 * W + x1] * ax) * (1 - ay) + (mag[y1 * W + x0] * (1 - ax) + mag[y1 * W + x1] * ax) * ay
        out[y * w + x] = (if (phase) (v + PI) / (2 * PI) * 255 else if (mx > 0) v / mx * 255 else 0.0).toFloat()
    }
    return out
}

fun spectrumOf(f: Frame, channel: String, phase: Boolean, log: Boolean): FloatArray {
    val p = when (channel) { "r" -> split(f)[0]; "g" -> split(f)[1]; "b" -> split(f)[2]; else -> luma(f) }
    return spectrum(p, f.w, f.h, phase, log)
}

/** Frequency domain filtering; notch positions are given in display (frame) coordinates of the centered spectrum. */
fun fourierFilter(f: Frame, filter: String, points: List<Pt>, radius: Double, symmetric: Boolean, cutoff: Double, smooth: Boolean): Frame {
    val w = f.w; val h = f.h
    val pad = 16
    val W = nextPow2(w + 2 * pad); val H = nextPow2(h + 2 * pad)
    val ox = (W - w) shr 1; val oy = (H - h) shr 1
    val fre = DoubleArray(W * H); val fim = DoubleArray(W * H)
    val nu = ArrayList<Double>(); val nv = ArrayList<Double>()
    if (filter == "notch") for (pt in points) {
        val u = (pt.x - w / 2.0) / w; val v = (pt.y - h / 2.0) / h
        nu.add(u); nv.add(v)
        if (symmetric) { nu.add(-u); nv.add(-v) }
    }
    val ru = (radius / w).let { if (it != 0.0) it else 1e-3 }; val rv = (radius / h).let { if (it != 0.0) it else 1e-3 }
    for (y in 0 until H) {
        val v = (if (y < H / 2) y else y - H).toDouble() / H
        for (x in 0 until W) {
            val u = (if (x < W / 2) x else x - W).toDouble() / W
            var m = 1.0
            if (filter == "notch") {
                for (q in nu.indices) {
                    val d2 = ((u - nu[q]) / ru).pow(2) + ((v - nv[q]) / rv).pow(2)
                    m *= if (smooth) 1 - exp(-d2 / 2) else if (d2 <= 1) 0.0 else 1.0
                }
            } else {
                val r = hypot(u, v); val c = max(1e-4, cutoff)
                val lp = if (smooth) 1 / (1 + (r / c).pow(4)) else if (r <= c) 1.0 else 0.0
                m = if (filter == "lowpass") lp else 1 - lp
                if (filter == "highpass" && x == 0 && y == 0) m = 1.0 // keep the mean brightness
            }
            fre[y * W + x] = m
        }
    }
    val (r, g, b, a) = split(f)
    val (or, og) = filterPair(r, g, w, h, W, H, ox, oy, fre, fim)
    val (ob, _) = filterPair(b, null, w, h, W, H, ox, oy, fre, fim)
    return merge(w, h, or, og!!, ob, a)
}

class Shift(val dx: Double, val dy: Double, val peak: Double)

/** Sub-pixel translation between two equally sized pow2 planes (phase correlation). b ≈ a shifted by (dx, dy). */
fun phaseCorrelate(a: DoubleArray, b: DoubleArray, W: Int, H: Int): Shift {
    val ar = a.copyOf(); val ai = DoubleArray(W * H)
    val br = b.copyOf(); val bi = DoubleArray(W * H)
    fft2(ar, ai, W, H, false); fft2(br, bi, W, H, false)
    for (i in ar.indices) {
        val re = br[i] * ar[i] + bi[i] * ai[i]; val im = bi[i] * ar[i] - br[i] * ai[i]
        val m = hypot(re, im).let { if (it != 0.0) it else 1e-12 }
        ar[i] = re / m; ai[i] = im / m
    }
    fft2(ar, ai, W, H, true)
    var best = Double.NEGATIVE_INFINITY; var bx = 0; var by = 0
    for (i in ar.indices) if (ar[i] > best) { best = ar[i]; bx = i % W; by = i / W }
    fun at(x: Int, y: Int) = ar[((y + H) % H) * W + ((x + W) % W)]
    fun sub(m1: Double, c: Double, p1: Double): Double { val d = m1 - 2 * c + p1; return if (abs(d) < 1e-12) 0.0 else 0.5 * (m1 - p1) / d }
    var dx = bx + sub(at(bx - 1, by), best, at(bx + 1, by))
    var dy = by + sub(at(bx, by - 1), best, at(bx, by + 1))
    if (dx > W / 2) dx -= W
    if (dy > H / 2) dy -= H
    return Shift(dx, dy, best)
}

fun hannWindowed(plane: FloatArray, w: Int, h: Int, x0: Int, y0: Int, W: Int, H: Int): DoubleArray {
    val out = DoubleArray(W * H)
    var mean = 0.0
    for (y in 0 until H) for (x in 0 until W) {
        val sx = min(w - 1, max(0, x0 + x)); val sy = min(h - 1, max(0, y0 + y))
        val v = plane[sy * w + sx].toDouble()
        out[y * W + x] = v; mean += v
    }
    mean /= (W * H)
    for (y in 0 until H) {
        val wy = 0.5 - 0.5 * cos(2 * PI * y / (H - 1))
        for (x in 0 until W) out[y * W + x] = (out[y * W + x] - mean) * wy * (0.5 - 0.5 * cos(2 * PI * x / (W - 1)))
    }
    return out
}

// ---------------------------------------------------------------- point spread functions (shared/psf.ts)
class Psf(val w: Int, val h: Int, val d: FloatArray)

private fun splat(d: FloatArray, w: Int, h: Int, x: Double, y: Double, v: Double) {
    val x0 = floor(x).toInt(); val y0 = floor(y).toInt(); val fx = x - x0; val fy = y - y0
    fun put(xx: Int, yy: Int, ww: Double) { if (xx >= 0 && yy >= 0 && xx < w && yy < h) d[yy * w + xx] = (d[yy * w + xx] + v * ww).toFloat() }
    put(x0, y0, (1 - fx) * (1 - fy)); put(x0 + 1, y0, fx * (1 - fy)); put(x0, y0 + 1, (1 - fx) * fy); put(x0 + 1, y0 + 1, fx * fy)
}

fun normalizePsf(p: Psf): Psf {
    var s = 0.0
    for (v in p.d) s += v
    if (s <= 0) { p.d.fill(0f); p.d[(p.h shr 1) * p.w + (p.w shr 1)] = 1f; return p }
    for (i in p.d.indices) p.d[i] = (p.d[i] / s).toFloat()
    return p
}

/** Linear motion blur of `length` pixels at `angle` degrees (counter-clockwise from the x axis). */
fun linePsf(length: Double, angle: Double): Psf {
    val L = max(1.0, length)
    val size = (ceil(L).toInt() + 3) or 1
    val d = FloatArray(size * size)
    val a = angle * PI / 180; val dx = cos(a); val dy = -sin(a)
    val c = (size - 1) / 2.0
    val steps = max(2, ceil(L * 10).toInt())
    for (i in 0..steps) { val t = -L / 2 + L * i / steps; splat(d, size, size, c + dx * t, c + dy * t, 1.0) }
    return normalizePsf(Psf(size, size, d))
}

/** Out of focus (uniform disk) blur. */
fun diskPsf(radius: Double): Psf {
    val r = max(0.5, radius)
    val size = (ceil(r).toInt() * 2 + 3) or 1
    val c = (size - 1) / 2.0
    val d = FloatArray(size * size)
    val S = 6
    for (y in 0 until size) for (x in 0 until size) {
        var cov = 0
        for (sy in 0 until S) for (sx in 0 until S) {
            val px = x - c + (sx + 0.5) / S - 0.5; val py = y - c + (sy + 0.5) / S - 0.5
            if (px * px + py * py <= r * r) cov++
        }
        d[y * size + x] = (cov.toDouble() / (S * S)).toFloat()
    }
    return normalizePsf(Psf(size, size, d))
}

fun gaussianPsf(sigma: Double): Psf {
    val s = max(0.2, sigma)
    val rad = ceil(s * 3.5).toInt()
    val size = rad * 2 + 1
    val d = FloatArray(size * size)
    for (y in 0 until size) for (x in 0 until size) { val dx = x - rad; val dy = y - rad; d[y * size + x] = exp(-(dx * dx + dy * dy) / (2 * s * s)).toFloat() }
    return normalizePsf(Psf(size, size, d))
}

/** Arbitrary (non linear) trajectory drawn by the examiner, with a given stroke thickness. */
fun pathPsf(points: List<Pt>, thickness: Double = 1.0): Psf {
    if (points.size < 2) return normalizePsf(Psf(1, 1, floatArrayOf(1f)))
    var minX = Double.POSITIVE_INFINITY; var minY = Double.POSITIVE_INFINITY; var maxX = Double.NEGATIVE_INFINITY; var maxY = Double.NEGATIVE_INFINITY
    for (p in points) { minX = min(minX, p.x); minY = min(minY, p.y); maxX = max(maxX, p.x); maxY = max(maxY, p.y) }
    val cx = (minX + maxX) / 2; val cy = (minY + maxY) / 2
    val half = ceil(max(maxX - minX, maxY - minY) / 2 + thickness / 2).toInt() + 2
    val size = half * 2 + 1
    val d = FloatArray(size * size)
    for (i in 0 until points.size - 1) {
        val a = points[i]; val b = points[i + 1]
        val len = hypot(b.x - a.x, b.y - a.y)
        val steps = max(1, ceil(len * 10).toInt())
        for (s in 0 until steps) { val t = s.toDouble() / steps; splat(d, size, size, half + a.x + (b.x - a.x) * t - cx, half + a.y + (b.y - a.y) * t - cy, len / steps) }
    }
    var psf = Psf(size, size, d)
    if (thickness > 1) {
        val disk = diskPsf((thickness - 1) / 2)
        val out = FloatArray(size * size)
        val r = disk.w shr 1
        for (y in 0 until size) for (x in 0 until size) {
            val v = d[y * size + x]
            if (v == 0f) continue
            for (ky in 0 until disk.h) for (kx in 0 until disk.w) {
                val yy = y + ky - r; val xx = x + kx - r
                if (yy >= 0 && xx >= 0 && yy < size && xx < size) out[yy * size + xx] += v * disk.d[ky * disk.w + kx]
            }
        }
        psf = Psf(size, size, out)
    }
    return normalizePsf(psf)
}

/** PSF for a deblurring filter configuration (used by both the engine and the UI preview). */
fun psfForFilter(type: String, p: com.clearufo.forensics.engine.Params): Psf? {
    return when (type) {
        "motion_deblurring" -> linePsf(p["length"].d(10.0), p["angle"].d(0.0))
        "optical_deblurring" -> diskPsf(p["radius"].d(3.0))
        "gaussian_deblurring" -> gaussianPsf(p["sigma"].d(1.5))
        "nonlinear_deblurring" -> (p["points"] as? List<*>)?.filterIsInstance<Pt>()?.takeIf { it.size >= 2 }?.let { pathPsf(it, p["thickness"].d(1.0)) }
        else -> null
    }
}

private fun Any?.d(def: Double) = (this as? Number)?.toDouble() ?: def

