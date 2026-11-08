package com.clearufo.forensics.engine.filters

import com.clearufo.forensics.engine.*
import com.clearufo.forensics.engine.kernels.*
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sqrt

// Filters that change the number/order of frames or combine several frames (port of engine/filters/temporal.ts).

private fun thumb(f: Frame, roi: RectP?, size: Int = 64): FloatArray {
    val Y = luma(f)
    val x0 = if (roi != null) max(0, jsRound(roi.x)) else 0; val y0 = if (roi != null) max(0, jsRound(roi.y)) else 0
    val w = if (roi != null) max(1, min(f.w - x0, jsRound(roi.w))) else f.w; val h = if (roi != null) max(1, min(f.h - y0, jsRound(roi.h))) else f.h
    val tw = min(size, w); val th = min(size, h)
    val out = FloatArray(tw * th)
    for (y in 0 until th) for (x in 0 until tw) {
        var s = 0.0; var n = 0
        val sx0 = x0 + x * w / tw; val sx1 = x0 + max((x + 1) * w / tw, x * w / tw + 1)
        val sy0 = y0 + y * h / th; val sy1 = y0 + max((y + 1) * h / th, y * h / th + 1)
        for (yy in sy0 until min(f.h, sy1)) for (xx in sx0 until min(f.w, sx1)) { s += Y[yy * f.w + xx]; n++ }
        out[y * tw + x] = (s / max(1, n)).toFloat()
    }
    return out
}

private fun mad(a: FloatArray, b: FloatArray): Double { var s = 0.0; for (i in a.indices) s += abs(a[i] - b[i]); return s / a.size }

private suspend fun scan(input: Stream, ctx: BuildCtx, label: String, fn: (Frame, Int) -> Unit) {
    val n = input.info.frameCount
    for (i in 0 until n) {
        if (ctx.isStale()) throw Cancelled()
        fn(input.getFrame(i), i)
        if (i % 5 == 0) ctx.progress(label, i.toDouble() / n)
    }
    ctx.progress(label, 1.0)
}

fun parseFrameList(s: String, n: Int): IntArray {
    val out = ArrayList<Int>()
    for (part in s.split(Regex("[,;\\s]+"))) {
        if (part.isEmpty()) continue
        val m = Regex("^(\\d+)\\s*-\\s*(\\d+)$").find(part)
        if (m != null) { val a = m.groupValues[1].toInt(); val b = m.groupValues[2].toInt(); for (i in min(a, b)..max(a, b)) { if (out.size >= 1_000_000) break; if (i < n) out.add(i) } }
        else part.toIntOrNull()?.let { if (it < n) out.add(it) }
    }
    return out.toIntArray()
}

// ---------------------------------------------------------------- select frames
private val single: FilterImpl = { input, p, _ -> val s = needInput(input); remapStream(s, intArrayOf(clampFrameIndex(p.num("frame"), s.info.frameCount))) }

private val range: FilterImpl = { input, p, _ ->
    val s = needInput(input); val n = s.info.frameCount
    val a = clampFrameIndex(p.num("start"), n); val b = clampFrameIndex(p.num("end"), n, true)
    val idx = ArrayList<Int>(); var i = min(a, b); val step = max(1, p.int("step"))
    while (i <= max(a, b)) { idx.add(i); i += step }
    remapStream(s, idx.toIntArray())
}

private val sparse: FilterImpl = { input, p, _ ->
    val s = needInput(input); val idx = parseFrameList(p.str("frames"), s.info.frameCount)
    if (idx.isEmpty()) throw IllegalStateException("No valid frames in the list")
    remapStream(s, idx)
}

private val removeDuplicates: FilterImpl = { input, p, ctx ->
    val s = needInput(input); val keep = ArrayList<Int>(); var last: FloatArray? = null; val roi = p.rect("roi"); val thr = p.num("threshold")
    scan(s, ctx, "Removing duplicates") { f, i -> val t = thumb(f, roi); if (last == null || mad(t, last!!) > thr) { keep.add(i); last = t } }
    remapStream(s, keep.toIntArray())
}

private val frameType: FilterImpl = { input, p, ctx ->
    val s = needInput(input)
    val src = ctx.sourceOfChain()
    if (src != null && !src.info.frameTypesReady) src.analyze { ctx.progress("Analyzing frame types", it) }
    val keep = ArrayList<Int>()
    for (i in 0 until s.info.frameCount) {
        val t = s.meta(i).type
        if ((t == 'I' && p.bool("keepI")) || (t == 'P' && p.bool("keepP")) || (t == 'B' && p.bool("keepB")) || (t == '?' && p.bool("keepI"))) keep.add(i)
    }
    if (keep.isEmpty()) throw IllegalStateException("No frames of the selected types")
    remapStream(s, keep.toIntArray())
}

private val demux: FilterImpl = { input, p, ctx ->
    val s = needInput(input); val roi = p.rect("roi")
    val ref = thumb(s.getFrame(clampFrameIndex(p.num("reference"), s.info.frameCount)), roi)
    val keep = ArrayList<Int>(); val thr = p.num("threshold")
    scan(s, ctx, "Demultiplexing") { f, i ->
        val t = thumb(f, roi)
        var ma = 0.0; var mb = 0.0
        for (k in t.indices) { ma += t[k]; mb += ref[k] }
        ma /= t.size; mb /= t.size
        var num = 0.0; var da = 0.0; var db = 0.0
        for (k in t.indices) { val x = t[k] - ma; val y = ref[k] - mb; num += x * y; da += x * x; db += y * y }
        val sim = if (da > 0 && db > 0) num / sqrt(da * db) * 100 else 100 - mad(t, ref)
        if (sim >= thr) keep.add(i)
    }
    if (keep.isEmpty()) throw IllegalStateException("No frames are similar to the reference frame: lower the threshold")
    remapStream(s, keep.toIntArray())
}

private val motion: FilterImpl = { input, p, ctx ->
    val s = needInput(input); val keep = ArrayList<Int>(); var prev: FloatArray? = null; val roi = p.rect("roi"); val thr = p.num("threshold"); val area = p.num("minArea"); val mode = p.str("mode")
    scan(s, ctx, "Detecting motion") { f, i ->
        val t = thumb(f, roi, 96)
        var moving = false
        prev?.let { pr -> var c = 0; for (k in t.indices) if (abs(t[k] - pr[k]) > thr) c++; moving = c.toDouble() / t.size * 100 >= area }
        if ((mode == "motion") == moving || (i == 0 && mode == "still")) keep.add(i)
        prev = t
    }
    if (keep.isEmpty()) throw IllegalStateException(if (mode == "motion") "No motion detected in the region" else "No still frames found")
    remapStream(s, keep.toIntArray())
}

// ---------------------------------------------------------------- deinterlacing (temporal / geometry changing)
private val deinterlace: FilterImpl = { input, p, _ ->
    val s = needInput(input); val method = p.str("method"); val top = p.str("field") == "top"
    if (method != "bob") mapStream(s) { f, _ -> deinterlaceFrame(f, top, method) }
    else object : Stream {
        override val info = s.info.copy(frameCount = s.info.frameCount * 2, fps = s.info.fps * 2)
        override fun meta(i: Int) = s.meta(i shr 1).let { it.copy(pts = (it.pts ?: ((i shr 1) / s.info.fps)) + (i and 1) / (s.info.fps * 2)) }
        override suspend fun getFrame(i: Int) = deinterlaceFrame(s.getFrame(i shr 1), if (i and 1 == 0) top else !top, "linear")
    }
}

private fun fieldOf(f: Frame, bottom: Boolean): Frame {
    val h2 = (f.h + (if (bottom) 0 else 1)) / 2
    val out = Frame.alloc(f.w, max(1, h2), false)
    for (y in 0 until h2) { val sy = y * 2 + (if (bottom) 1 else 0); if (sy < f.h) System.arraycopy(f.d, sy * f.w * 4, out.d, y * f.w * 4, f.w * 4) }
    return out
}

private val fieldSeparation: FilterImpl = { input, p, _ ->
    val s = needInput(input)
    if (p.str("mode") == "sequence") {
        val h2 = (s.info.height + 1) / 2
        object : Stream {
            override val info = s.info.copy(frameCount = s.info.frameCount * 2, fps = s.info.fps * 2, height = h2)
            override fun meta(i: Int) = s.meta(i shr 1)
            override suspend fun getFrame(i: Int): Frame { val f = fieldOf(s.getFrame(i shr 1), i and 1 == 1); return if (f.h == h2) f else resize(f, f.w, h2, Interp.NEAREST) }
        }
    } else mapStream(s) { f, _ ->
        val top = fieldOf(f, false); val bot = fieldOf(f, true); val out = Frame.alloc(f.w, f.h, true)
        System.arraycopy(top.d, 0, out.d, 0, top.d.size)
        System.arraycopy(bot.d, 0, out.d, top.d.size, min(bot.d.size, out.d.size - top.d.size))
        out
    }
}

private val interleave: FilterImpl = { input, p, _ ->
    val s = needInput(input); val n = max(1, s.info.frameCount / 2); val topFirst = p.str("first") == "top"
    object : Stream {
        override val info = s.info.copy(frameCount = n, fps = s.info.fps / 2)
        override fun meta(i: Int) = s.meta(i * 2)
        override suspend fun getFrame(i: Int): Frame {
            val a = s.getFrame(i * 2); val b = s.getFrame(min(s.info.frameCount - 1, i * 2 + 1))
            val out = Frame.alloc(a.w, a.h, true)
            val first = if (topFirst) a else b; val second = if (topFirst) b else a
            for (y in 0 until a.h) System.arraycopy((if (y and 1 == 0) first else second).d, y * a.w * 4, out.d, y * a.w * 4, a.w * 4)
            return out
        }
    }
}

// ---------------------------------------------------------------- extract (temporal)
private val frameDifference: FilterImpl = { input, p, _ ->
    val s = needInput(input); val off = max(1, p.int("offset")); val gain = p.num("gain"); val signed = p.str("mode") == "signed"
    mapStream(s) { f, i ->
        val prev = s.getFrame(max(0, i - off)); val out = Frame.alloc(f.w, f.h, true)
        for (k in f.d.indices) { if (k and 3 == 3) continue; val d = (f.d[k] - prev.d[k]) * gain; out.d[k] = (if (signed) 128 + d / 2 else abs(d)).toFloat() }
        out
    }
}

// ---------------------------------------------------------------- stabilization
private val localStab: FilterImpl = { input, p, ctx ->
    val s = needInput(input); val roi = p.rect("roi")
    if (roi == null || roi.w < 4 || roi.h < 4) s else {
        val ref = clampFrameIndex(p.num("reference"), s.info.frameCount)
        val rf = s.getFrame(ref); val RY = luma(rf)
        val rx = max(0, jsRound(roi.x)); val ry = max(0, jsRound(roi.y))
        val rw = min(rf.w - rx, jsRound(roi.w)); val rh = min(rf.h - ry, jsRound(roi.h))
        val k = max(1, max(rw, rh) / 64)
        val tplFull = FloatArray(rw * rh)
        for (y in 0 until rh) for (x in 0 until rw) tplFull[y * rw + x] = RY[(ry + y) * rf.w + rx + x]
        val tplSmall = if (k > 1) downPlane(tplFull, rw, rh, k) else null
        val cache = HashMap<Int, Pair<Double, Double>>()
        val search = p.num("search"); val sub = p.bool("subpixel"); val edge = p.str("fill") == "edge"
        mapStream(s) { f, i ->
            if (i == ref) f else {
                val off = synchronized(cache) { cache[i] } ?: run {
                    val Y = luma(f)
                    val r = if (tplSmall != null) {
                        val sm = downPlane(Y, f.w, f.h, k)
                        val m = matchTemplate(sm.d, sm.w, sm.h, tplSmall.d, tplSmall.w, tplSmall.h, rx.toDouble() / k, ry.toDouble() / k, ceil(search / k) + 1, ctx::isStale)
                        matchTemplate(Y, f.w, f.h, tplFull, rw, rh, m.x * k, m.y * k, (k + 1).toDouble(), ctx::isStale)
                    } else matchTemplate(Y, f.w, f.h, tplFull, rw, rh, rx.toDouble(), ry.toDouble(), search, ctx::isStale)
                    val o = if (sub) (r.x - rx) to (r.y - ry) else jsRound(r.x - rx).toDouble() to jsRound(r.y - ry).toDouble()
                    synchronized(cache) { cache[i] = o }; o
                }
                translate(f, -off.first, -off.second, edge)
            }
        }
    }
}

private val globalStab: FilterImpl = { input, p, _ ->
    val s = needInput(input); val ref = clampFrameIndex(p.num("reference"), s.info.frameCount)
    val w = s.info.width; val h = s.info.height
    val S = min(512, nextPow2(max(w, h)) / 2)
    val k = max(1, ceil(max(w, h).toDouble() / S).toInt())
    fun prep(f: Frame): Triple<DoubleArray, Int, Int> { val d = downPlane(luma(f), f.w, f.h, k); val W = nextPow2(d.w); val H = nextPow2(d.h); return Triple(hannWindowed(d.d, d.w, d.h, 0, 0, W, H), W, H) }
    val R = prep(s.getFrame(ref))
    val cache = HashMap<Int, Pair<Double, Double>>()
    val sub = p.bool("subpixel"); val edge = p.str("fill") == "edge"
    mapStream(s) { f, i ->
        if (i == ref) f else {
            val off = synchronized(cache) { cache[i] } ?: run {
                val P = prep(f); val r = phaseCorrelate(R.first, P.first, R.second, R.third)
                var o = r.dx * k to r.dy * k
                if (!sub) o = jsRound(o.first).toDouble() to jsRound(o.second).toDouble()
                synchronized(cache) { cache[i] = o }; o
            }
            translate(f, -off.first, -off.second, edge)
        }
    }
}

// ---------------------------------------------------------------- integrate
private suspend fun combine(s: Stream, indices: IntArray, method: String, sigma: Double, ctx: BuildCtx, label: String): Frame {
    val first = s.getFrame(indices[0])
    val n = first.d.size
    if (method == "mean") {
        val acc = DoubleArray(n)
        for (k in indices.indices) {
            if (ctx.isStale()) throw Cancelled()
            val f = if (k == 0) first else s.getFrame(indices[k])
            if (f.d.size != n) continue
            for (i in 0 until n) acc[i] += f.d[i]
            if (indices.size > 8) ctx.progress(label, k.toDouble() / indices.size)
        }
        return Frame(first.w, first.h, FloatArray(n) { (acc[it] / indices.size).toFloat() })
    }
    // median / sigma clipped: 8-bit samples (bounded memory), as the browser version
    val m = min(indices.size, 99)
    val stack = ByteArray(n.toLong().times(m).coerceAtMost(Int.MAX_VALUE.toLong()).toInt())
    for (k in 0 until m) {
        if (ctx.isStale()) throw Cancelled()
        val f = if (k == 0) first else s.getFrame(indices[k])
        if (f.d.size != n) continue
        for (i in 0 until n) { val v = f.d[i]; stack[i * m + k] = (if (v < 0) 0 else if (v > 255) 255 else jsRound(v.toDouble())).toByte() }
        if (m > 8) ctx.progress(label, k.toDouble() / m)
    }
    val out = FloatArray(n)
    Par.forRows(first.h) { y0, y1 ->
        val buf = IntArray(m)
        for (i in y0 * first.w * 4 until y1 * first.w * 4) {
            if (i and 3 == 3) { out[i] = 255f; continue }
            for (k in 0 until m) buf[k] = stack[i * m + k].toInt() and 255
            buf.sort()
            if (method == "median") { out[i] = (if (m and 1 == 1) buf[m shr 1].toDouble() else (buf[m / 2 - 1] + buf[m / 2]) / 2.0).toFloat(); continue }
            var mean = 0.0; for (k in 0 until m) mean += buf[k]; mean /= m
            var v = 0.0; for (k in 0 until m) v += (buf[k] - mean).pow(2)
            val sd = sqrt(v / m).let { if (it != 0.0) it else 1.0 }
            var s2 = 0.0; var c = 0
            for (k in 0 until m) if (abs(buf[k] - mean) <= sigma * sd) { s2 += buf[k]; c++ }
            out[i] = (if (c > 0) s2 / c else mean).toFloat()
        }
    }
    return Frame(first.w, first.h, out)
}

private val averaging: FilterImpl = { input, p, ctx ->
    val s = needInput(input); val n = s.info.frameCount
    if (p.str("mode") == "all") {
        val f = combine(s, IntArray(n) { it }, p.str("method"), p.num("sigma"), ctx, "Averaging frames")
        constantStream(f, s.info, s.meta(0).copy(type = 'I'))
    } else {
        val win = max(2, p.int("window"))
        mapStream(s) { _, i ->
            val a = max(0, i - (win - 1) / 2); val b = min(n - 1, a + win - 1)
            combine(s, IntArray(b - a + 1) { a + it }, p.str("method"), p.num("sigma"), ctx, "Averaging frames")
        }
    }
}

// ---------------------------------------------------------------- temporal smoothing (Brailean et al. 1995)
fun smoothingWindow(i: Int, n: Int, size: Int): Pair<Int, Int> { val before = (size - 1) / 2; return max(0, i - before) to min(n - 1, i - before + size - 1) }
fun smoothingWeight(method: String, k: Int, size: Int): Double { if (method != "gaussian") return 1.0; val sigma = size / 4.0; return exp(-(k * k) / (2 * sigma * sigma)).toFloat().toDouble() }

private fun median3(a: Float, b: Float, c: Float) = if (a < b) (if (b < c) b else if (a < c) c else a) else (if (a < c) a else if (b < c) c else b)

/** Devillard's 7-exchange median-of-5 network (as the web version). */
private fun median5(a0: Float, b0: Float, c0: Float, d0: Float, e0: Float): Float {
    var a = a0; var b = b0; var c = c0; var d = d0; var e = e0; var t: Float
    if (a > b) { t = a; a = b; b = t }
    if (d > e) { t = d; d = e; e = t }
    if (a > d) d = a
    if (b > e) b = e
    if (b > c) { t = b; b = c; c = t }
    if (c > d) c = d
    return if (b > c) b else c
}

/** Median of buf[0 until k) (mean of the two middle values when k is even); may reorder buf. */
fun medianInPlace(buf: DoubleArray, k: Int): Double {
    if (k == 1) return buf[0]
    val mid = k shr 1
    if (k <= 16) {
        for (i in 1 until k) { val v = buf[i]; var j = i - 1; while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j-- }; buf[j + 1] = v }
        return if (k and 1 == 1) buf[mid] else (buf[mid - 1] + buf[mid]) / 2
    }
    // Wirth's selection: afterwards buf[mid] is the mid-th smallest, everything before it is <= and after it >=
    var l = 0; var m = k - 1
    while (l < m) {
        val x = buf[mid]; var i = l; var j = m
        do {
            while (buf[i] < x) i++
            while (x < buf[j]) j--
            if (i <= j) { val t = buf[i]; buf[i] = buf[j]; buf[j] = t; i++; j-- }
        } while (i <= j)
        if (j < mid) l = i
        if (mid < i) m = j
    }
    if (k and 1 == 1) return buf[mid]
    var lo = buf[0]
    for (i in 1 until mid) if (buf[i] > lo) lo = buf[i]
    return (lo + buf[mid]) / 2
}

/**
 * Row y of the motion statistic before the vertical pass: largest absolute R/G/B difference of b to a per pixel,
 * then the horizontal 1-2-1 sum (edges replicated, double precision, stored as float as the web version's
 * Float32Array), into ring[o until o + w). dy holds one row of differences.
 */
private fun diffRow(a: FloatArray, b: FloatArray, w: Int, y: Int, ring: FloatArray, o: Int, dy: FloatArray) {
    var q = y * w * 4
    for (x in 0 until w) {
        val dr = abs(b[q] - a[q]); val dg = abs(b[q + 1] - a[q + 1]); val db = abs(b[q + 2] - a[q + 2])
        val m = if (dr > dg) dr else dg
        dy[x] = if (m > db) m else db
        q += 4
    }
    if (w == 1) { ring[o] = (dy[0].toDouble() + 2.0 * dy[0] + dy[0]).toFloat(); return }
    ring[o] = (dy[0].toDouble() + 2.0 * dy[0] + dy[1]).toFloat()
    for (x in 1 until w - 1) ring[o + x] = (dy[x - 1].toDouble() + 2.0 * dy[x] + dy[x + 1]).toFloat()
    ring[o + w - 1] = (dy[w - 2].toDouble() + 2.0 * dy[w - 1] + dy[w - 1]).toFloat()
}

/** Ring offsets of rows y - 1, y and y + 1 (edges replicated). */
private fun ringRows(y: Int, h: Int, w: Int) = Triple(((if (y > 0) y - 1 else 0) % 3) * w, (y % 3) * w, ((if (y < h - 1) y + 1 else y) % 3) * w)

/** The rows of the ring a band starting at row y0 needs before its first row. */
private fun primeRing(a: FloatArray, b: FloatArray, w: Int, y0: Int, ring: FloatArray, dy: FloatArray) {
    if (y0 > 0) diffRow(a, b, w, y0 - 1, ring, ((y0 - 1) % 3) * w, dy)
    diffRow(a, b, w, y0, ring, (y0 % 3) * w, dy)
}

/** Largest window (bytes of frames) kept in memory at once; bigger windows of Mean and Gaussian are streamed. The web
 * version keeps up to 512 MB; on the phone it is a fifth of the app's heap. */
@Volatile var smoothingHoldBytes: Long = min(512L shl 20, Runtime.getRuntime().maxMemory() / 5)

/**
 * One output frame (port of smoothFrame in temporal.ts): co-located pixels of the frames in a moving window around
 * frame i, double precision sums in time order; motion protection leaves out the pixels of a neighbor whose largest
 * R/G/B difference to the current frame (1-2-1 weighted 3x3 mean) exceeds the threshold. Windows too large to keep
 * (Mean and Gaussian only) are streamed one input frame at a time, with the same result. Rows run in parallel; each
 * row's arithmetic is the same as the web version's.
 */
suspend fun smoothFrame(get: suspend (Int) -> Frame, i: Int, n: Int, size: Int, method: String, protect: Boolean, threshold: Double, showMask: Boolean, isStale: () -> Boolean): Frame {
    val cur = get(i)
    val (a, b) = smoothingWindow(i, n, size)
    if (a == b) return cur
    val w = cur.w; val h = cur.h; val cd = cur.d; val np = w * h
    val lim = 16 * threshold
    val keep = b - a + 1 <= 31 && (method == "median" || (b - a + 1).toLong() * np * 16 <= smoothingHoldBytes)
    if (!keep) return smoothStreamed(get, cur, i, a, b, size, method, protect, lim, showMask, isStale)
    val frames = ArrayList<FloatArray>(); val wts = ArrayList<Double>()
    var total = 0.0; var ct = 0
    for (j in a..b) {
        if (isStale()) throw Cancelled()
        val f = if (j == i) cur else get(j)
        if (f.w != w || f.h != h) continue
        if (j == i) ct = frames.size
        val wk = smoothingWeight(method, j - i, size)
        frames.add(f.d); wts.add(wk); total += wk
    }
    val m = frames.size
    val W = DoubleArray(m) { wts[it] }
    val median = method == "median"
    val out = FloatArray(np * 4)
    // One sweep over the rows of a band: the motion test of row y + 1 against every neighbor, then row y of the
    // output. Bit t of rowBits[x]: frame t takes part at pixel x of the current row.
    Par.forRows(h) { y0, y1 ->
        val dy = FloatArray(w); val rowBits = IntArray(w) { 1 shl ct }
        val rings = if (protect) Array(m) { t -> if (t == ct) null else FloatArray(3 * w) } else null
        if (rings != null) for (t in 0 until m) { val r = rings[t] ?: continue; primeRing(cd, frames[t], w, y0, r, dy) }
        val sel = IntArray(m); val buf = DoubleArray(m)
        for (y in y0 until y1) {
            if ((y and 63) == 63 && isStale()) throw Cancelled()
            if (rings != null) {
                java.util.Arrays.fill(rowBits, 1 shl ct)
                val (o0, o1, o2) = ringRows(y, h, w)
                for (t in 0 until m) {
                    val ring = rings[t] ?: continue
                    if (y + 1 < h) diffRow(cd, frames[t], w, y + 1, ring, ((y + 1) % 3) * w, dy)
                    val bit = 1 shl t
                    for (x in 0 until w) if (ring[o0 + x].toDouble() + 2.0 * ring[o1 + x] + ring[o2 + x] <= lim) rowBits[x] = rowBits[x] or bit
                }
            }
            var q = y * w * 4
            if (!median) {
                for (x in 0 until w) {
                    var s0 = 0.0; var s1 = 0.0; var s2 = 0.0; var ws = total
                    if (rings != null) {
                        ws = 0.0
                        var bt = rowBits[x]; var t = 0
                        while (bt != 0) {
                            if (bt and 1 != 0) { val d = frames[t]; val wk = W[t]; s0 += wk * d[q]; s1 += wk * d[q + 1]; s2 += wk * d[q + 2]; ws += wk }
                            t++; bt = bt ushr 1
                        }
                    } else {
                        for (t in 0 until m) { val d = frames[t]; val wk = W[t]; s0 += wk * d[q]; s1 += wk * d[q + 1]; s2 += wk * d[q + 2] }
                    }
                    out[q] = (s0 / ws).toFloat(); out[q + 1] = (s1 / ws).toFloat(); out[q + 2] = (s2 / ws).toFloat(); out[q + 3] = cd[q + 3]
                    if (showMask && rings != null) maskPixel(out, q, ws / total)
                    q += 4
                }
                continue
            }
            for (x in 0 until w) {
                var k = 0
                if (rings != null) { var bt = rowBits[x]; var t = 0; while (bt != 0) { if (bt and 1 != 0) sel[k++] = t; t++; bt = bt ushr 1 } }
                else while (k < m) { sel[k] = k; k++ }
                when (k) {
                    5 -> { val d0 = frames[sel[0]]; val d1 = frames[sel[1]]; val d2 = frames[sel[2]]; val d3 = frames[sel[3]]; val d4 = frames[sel[4]]
                        for (c in q until q + 3) out[c] = median5(d0[c], d1[c], d2[c], d3[c], d4[c]) }
                    3 -> { val d0 = frames[sel[0]]; val d1 = frames[sel[1]]; val d2 = frames[sel[2]]
                        for (c in q until q + 3) out[c] = median3(d0[c], d1[c], d2[c]) }
                    else -> for (c in 0 until 3) {
                        for (t in 0 until k) buf[t] = frames[sel[t]][q + c].toDouble()
                        out[q + c] = medianInPlace(buf, k).toFloat()
                    }
                }
                out[q + 3] = cd[q + 3]
                if (showMask && rings != null) maskPixel(out, q, k.toDouble() / m)
                q += 4
            }
        }
    }
    return Frame(w, h, out)
}

/** Streamed Mean/Gaussian: one input frame at a time, double sums over the whole image (time order per pixel). */
private suspend fun smoothStreamed(get: suspend (Int) -> Frame, cur: Frame, i: Int, a: Int, b: Int, size: Int, method: String, protect: Boolean, lim: Double, showMask: Boolean, isStale: () -> Boolean): Frame {
    val w = cur.w; val h = cur.h; val cd = cur.d; val np = w * h
    val acc = DoubleArray(np * 3); val kept = if (protect) DoubleArray(np) else null; val still = if (protect) BooleanArray(np) else null
    var total = 0.0
    for (j in a..b) {
        if (isStale()) throw Cancelled()
        val d = (if (j == i) cur else get(j)).let { if (it.w != w || it.h != h) null else it.d } ?: continue
        val wk = smoothingWeight(method, j - i, size)
        total += wk
        val mk = if (still != null && j != i) still else null
        Par.forRows(h) { y0, y1 ->
            if (mk != null) {
                val dy = FloatArray(w); val ring = FloatArray(3 * w)
                primeRing(cd, d, w, y0, ring, dy)
                for (y in y0 until y1) {
                    if ((y and 63) == 63 && isStale()) throw Cancelled()
                    if (y + 1 < h) diffRow(cd, d, w, y + 1, ring, ((y + 1) % 3) * w, dy)
                    val (o0, o1, o2) = ringRows(y, h, w); val r = y * w
                    for (x in 0 until w) mk[r + x] = ring[o0 + x].toDouble() + 2.0 * ring[o1 + x] + ring[o2 + x] <= lim
                }
            }
            for (p in y0 * w until y1 * w) {
                if (mk != null && !mk[p]) continue
                val q = p * 4; val t = p * 3
                acc[t] += wk * d[q]; acc[t + 1] += wk * d[q + 1]; acc[t + 2] += wk * d[q + 2]
                if (kept != null) kept[p] += wk
            }
        }
    }
    val out = FloatArray(np * 4)
    Par.forRows(h) { y0, y1 ->
        for (p in y0 * w until y1 * w) {
            val q = p * 4; val t = p * 3
            val ws = kept?.get(p) ?: total
            out[q] = (acc[t] / ws).toFloat(); out[q + 1] = (acc[t + 1] / ws).toFloat(); out[q + 2] = (acc[t + 2] / ws).toFloat(); out[q + 3] = cd[q + 3]
            if (showMask && kept != null) maskPixel(out, q, kept[p] / total)
        }
    }
    return Frame(w, h, out)
}

private fun maskPixel(out: FloatArray, q: Int, keptFraction: Double) {
    val s = 0.6 * (1 - keptFraction); val g = 0.299 * out[q] + 0.587 * out[q + 1] + 0.114 * out[q + 2]
    out[q] = (g + (255 - g) * s).toFloat(); out[q + 1] = (g * (1 - s)).toFloat(); out[q + 2] = (g * (1 - s)).toFloat()
}

private val temporalSmoothing: FilterImpl = { input, p, ctx ->
    val s = needInput(input)
    val method = when (p.str("method")) { "median" -> "median"; "gaussian" -> "gaussian"; else -> "mean" }
    val protect = p["protect"] != false
    val size = max(2, min(31, p.num("size", 5.0).roundToInt()))
    val thr = max(0.0, p.num("threshold")); val show = protect && p.bool("showMask")
    mapStream(s) { cur, i -> smoothFrame({ j -> if (j == i) cur else s.getFrame(j) }, i, s.info.frameCount, size, method, protect, thr, show, ctx::isStale) }
}

/**
 * Super Resolution (port of superRes in temporal.ts): every frame is registered to the first one by phase correlation
 * on the registration region, its pixels are splatted onto an S× finer grid (Gaussian or bilinear weights, double
 * precision sums), and the result is blended with the bicubic enlargement of the first frame where few samples fell.
 * On the phone the result is built in horizontal bands so its sums fit in memory (each band reads the frames again;
 * every output pixel still receives its samples in the same order), rows run on all cores, and the Gaussian weight of
 * a sample is the product of its row and column factors. "Registration region only" builds just that part of the
 * result (identical to the same part of the whole-frame result).
 */
/** Memory for the sums of one band of the Super Resolution result (0: an eighth of the heap). Tests set it lower. */
@Volatile var superResBandBytes: Long = 0

private val superRes: FilterImpl = { input, p, ctx ->
    val s = needInput(input)
    val n = min(s.info.frameCount, max(2, p.int("maxFrames")))
    val S = max(2, min(4, p.int("scale")))
    val ref = s.getFrame(0)
    val w = ref.w; val h = ref.h
    val roi0 = p.rect("roi")
    val hasRoi = roi0 != null && roi0.w >= 16 && roi0.h >= 16
    val roi = if (hasRoi) roi0!! else RectP(0.0, 0.0, w.toDouble(), h.toDouble())
    fun pow2floor(v: Double) = 2.0.pow(floor(ln(max(2.0, v)) / ln(2.0))).toInt()
    val RW = max(32, min(256, pow2floor(roi.w))); val RH = max(32, min(256, pow2floor(roi.h)))
    val cx = jsRound(roi.x + roi.w / 2 - RW / 2.0); val cy = jsRound(roi.y + roi.h / 2 - RH / 2.0)
    val refWin = hannWindowed(luma(ref), w, h, cx, cy, RW, RH)
    val W2 = w * S; val H2 = h * S
    // the part of the S× result to build: the registration region, or the whole frame
    val crop = hasRoi && p.str("output", "frame") == "region"
    val ix0 = if (crop) max(0, min(w - 1, floor(roi.x).toInt())) else 0
    val iy0 = if (crop) max(0, min(h - 1, floor(roi.y).toInt())) else 0
    val ix1 = if (crop) max(ix0 + 1, min(w, ceil(roi.x + roi.w).toInt())) else w
    val iy1 = if (crop) max(iy0 + 1, min(h, ceil(roi.y + roi.h).toInt())) else h
    val ox0 = ix0 * S; val oy0 = iy0 * S; val ow = (ix1 - ix0) * S; val oh = (iy1 - iy0) * S
    val heap = Runtime.getRuntime().maxMemory()
    val outBytes = ow.toLong() * oh * 16
    if (outBytes > heap * 0.4) throw IllegalStateException("a ${ow}×${oh} result (${outBytes shr 20} MB) does not fit in the memory of this device. " +
        (if (crop) "Draw a smaller registration region or lower the Scale Factor." else "Draw a Registration Region on the object and set Output to “Registration region only”, or lower the Scale Factor."))
    // bands of output rows whose sums (3 color sums and the weight sum, double precision) fit in an eighth of the heap
    val budget = superResBandBytes.takeIf { it > 0 } ?: max(8L shl 20, heap / 8)
    val bandRows = max(1, min(oh.toLong(), budget / (ow.toLong() * 32)).toInt())
    val passes = (oh + bandRows - 1) / bandRows
    val gauss = p.str("kernel") != "bilinear"
    val sig = 0.6 * S; val rad = ceil(sig * 2).toInt(); val den = 2 * sig * sig
    val shifts = arrayOfNulls<Shift>(n); val skip = BooleanArray(n)
    val out = Frame.alloc(ow, oh, true)
    for (pass in 0 until passes) {
        val r0 = oy0 + pass * bandRows; val r1 = min(oy0 + oh, r0 + bandRows) // rows of the S× result
        val rows = r1 - r0
        val acc = DoubleArray(ow * rows * 3); val wsum = DoubleArray(ow * rows)
        for (k in 0 until n) {
            if (ctx.isStale()) throw Cancelled()
            if (skip[k]) continue
            val f = if (k == 0) ref else s.getFrame(k)
            if (f.w != w || f.h != h) { skip[k] = true; continue }
            val sh = shifts[k] ?: (if (k == 0) Shift(0.0, 0.0, 1.0) else phaseCorrelate(refWin, hannWindowed(luma(f), w, h, cx, cy, RW, RH), RW, RH)).also { shifts[k] = it }
            val d = f.d
            Par.forRows(rows) { a, b ->
                val ga = r0 + a; val gb = r0 + b // this task owns result rows [ga, gb): no other task writes them
                val ex = DoubleArray(2 * rad + 2); val ey = DoubleArray(2 * rad + 2)
                for (y in 0 until h) {
                    val Y = (y - sh.dy + 0.5) * S - 0.5
                    if (gauss) {
                        val yc = jsRound(Y)
                        val lo = max(max(yc - rad, ga), 0); val hi = min(min(yc + rad, gb - 1), H2 - 1)
                        if (lo > hi) continue
                        for (ty in lo..hi) ey[ty - lo] = exp(-((ty - Y) * (ty - Y)) / den)
                        for (x in 0 until w) {
                            val X = (x - sh.dx + 0.5) * S - 0.5
                            val xc = jsRound(X)
                            val xl = max(max(xc - rad, ox0), 0); val xh = min(min(xc + rad, ox0 + ow - 1), W2 - 1)
                            if (xl > xh) continue
                            for (tx in xl..xh) ex[tx - xl] = exp(-((tx - X) * (tx - X)) / den)
                            val o = (y * w + x) * 4
                            val vr = d[o].toDouble(); val vg = d[o + 1].toDouble(); val vb = d[o + 2].toDouble()
                            for (ty in lo..hi) {
                                val wy = ey[ty - lo]; val rq = (ty - r0) * ow - ox0
                                for (tx in xl..xh) {
                                    val wt = ex[tx - xl] * wy; val q = rq + tx
                                    acc[q * 3] += vr * wt; acc[q * 3 + 1] += vg * wt; acc[q * 3 + 2] += vb * wt; wsum[q] += wt
                                }
                            }
                        }
                    } else {
                        val yf = floor(Y).toInt(); val fy = Y - yf
                        if (yf + 1 < ga || yf >= gb) continue
                        for (x in 0 until w) {
                            val X = (x - sh.dx + 0.5) * S - 0.5
                            val xf = floor(X).toInt(); val fx = X - xf
                            val o = (y * w + x) * 4
                            for (t in 0 until 4) {
                                val tx = xf + (t and 1); val ty = yf + (t shr 1)
                                val wt = when (t) { 0 -> (1 - fx) * (1 - fy); 1 -> fx * (1 - fy); 2 -> (1 - fx) * fy; else -> fx * fy }
                                if (tx < 0 || ty < 0 || tx >= W2 || ty >= H2 || wt <= 0) continue
                                if (ty < ga || ty >= gb || tx < ox0 || tx >= ox0 + ow) continue
                                val q = (ty - r0) * ow + tx - ox0
                                acc[q * 3] += d[o] * wt; acc[q * 3 + 1] += d[o + 1] * wt; acc[q * 3 + 2] += d[o + 2] * wt; wsum[q] += wt
                            }
                        }
                    }
                }
            }
            ctx.progress("Super resolution", (pass * n + k + 1).toDouble() / (passes * n))
        }
        // blend with the bicubic enlargement of the first frame (this band of it)
        val base = resizeRegion(ref, W2, H2, Interp.BICUBIC, ox0, r0, ow, rows)
        Par.forRows(rows) { a, b ->
            for (row in a until b) for (xx in 0 until ow) {
                val q = row * ow + xx; val bq = q * 4; val o = ((row + r0 - oy0) * ow + xx) * 4
                val ws = wsum[q]; val blend = min(1.0, ws / 0.5)
                for (c in 0 until 3) out.d[o + c] = (if (ws > 1e-6) acc[q * 3 + c] / ws * blend + base.d[bq + c] * (1 - blend) else base.d[bq + c].toDouble()).toFloat()
            }
        }
    }
    constantStream(out, s.info.copy(width = ow, height = oh), s.meta(0).copy(type = 'I'))
}

// ---------------------------------------------------------------- frame rate / order
private val changeFps: FilterImpl = { input, p, _ ->
    val s = needInput(input); val fps = p.num("fps", 25.0)
    object : Stream {
        override val info = s.info.copy(fps = fps)
        override suspend fun getFrame(i: Int) = s.getFrame(i)
        override fun meta(i: Int) = s.meta(i).copy(pts = i / fps)
    }
}

private val convertFps: FilterImpl = { input, p, _ ->
    val s = needInput(input); val n = s.info.frameCount; val fps0 = s.info.fps; val fps = p.num("fps", 25.0)
    val m = max(1, jsRound(n * fps / fps0)); val blend = p.str("method") == "blend"
    object : Stream {
        override val info = s.info.copy(frameCount = m, fps = fps)
        override fun meta(i: Int) = s.meta(min(n - 1, jsRound(i * fps0 / fps))).copy(pts = i / fps)
        override suspend fun getFrame(i: Int): Frame {
            val t = i * fps0 / fps
            if (!blend) return s.getFrame(min(n - 1, jsRound(t)))
            val a = min(n - 1, floor(t).toInt()); val b = min(n - 1, a + 1); val fr = t - a
            if (fr < 1e-3 || a == b) return s.getFrame(a)
            val fa = s.getFrame(a); val fb = s.getFrame(b)
            return Frame(fa.w, fa.h, FloatArray(fa.d.size) { (fa.d[it] * (1 - fr) + fb.d[it] * fr).toFloat() })
        }
    }
}

private val reverse: FilterImpl = { input, _, _ -> val s = needInput(input); val n = s.info.frameCount; remapStream(s, IntArray(n) { n - 1 - it }) }

private val freeze: FilterImpl = { input, p, _ ->
    val s = needInput(input); val n = s.info.frameCount
    val at = clampFrameIndex(p.num("frame"), n); val dur = max(1, p.int("duration"))
    val idx = ArrayList<Int>()
    for (i in 0..at) idx.add(i)
    repeat(dur - 1) { idx.add(at) }
    for (i in at + 1 until n) idx.add(i)
    remapStream(s, idx.toIntArray())
}

val temporalFilters: Map<String, FilterImpl> = mapOf(
    "single_selector" to single, "range_selector" to range, "sparse_selector" to sparse, "remove_duplicates" to removeDuplicates, "iframes_selector" to frameType,
    "demultiplexer" to demux, "motion_detection" to motion, "deinterlace" to deinterlace, "field_separation" to fieldSeparation, "interleave" to interleave,
    "frame_difference" to frameDifference, "local_stabilization" to localStab, "global_stabilization" to globalStab,
    "frame_averaging" to averaging, "temporal_smoothing" to temporalSmoothing, "super_resolution" to superRes,
    "change_frame_rate" to changeFps, "convert_frame_rate" to convertFps, "reverse" to reverse, "freeze_frame" to freeze,
)
