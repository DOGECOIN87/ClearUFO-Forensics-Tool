package com.clearufo.forensics.engine.filters

import com.clearufo.forensics.engine.*
import com.clearufo.forensics.engine.kernels.*
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

// Filters combining several chains (link.ts) and annotation / redaction / measurement filters (presentation.ts).

private suspend fun at(s: Stream, i: Int) = s.getFrame(max(0, min(s.info.frameCount - 1, i)))
private fun fit(f: Frame, w: Int, h: Int) = if (f.w == w && f.h == h) f else resize(f, w, h, Interp.BILINEAR)

private fun letterbox(f: Frame, w: Int, h: Int): Frame {
    if (f.w == w && f.h == h) return f
    val s = min(w.toDouble() / f.w, h.toDouble() / f.h)
    val nw = max(1, jsRound(f.w * s)); val nh = max(1, jsRound(f.h * s))
    val out = Frame.alloc(w, h, true)
    putRows(out, resize(f, nw, nh, Interp.BILINEAR), (w - nw) shr 1, (h - nh) shr 1)
    return out
}

/**
 * Presentation times of a stream's frames (timestamps of the source, carried through frame selections; the nominal
 * frame rate where there are none). Linked chains are synchronized on these, so videos with different frame rates,
 * variable frame rates or trimmed ranges stay in step.
 */
class Timing(private val s: Stream) {
    val n = max(1, s.info.frameCount)
    private val fps = if (s.info.fps > 0) s.info.fps else 25.0
    private val t = DoubleArray(n) { i -> s.meta(i).pts ?: (i / fps) }
    private val monotonic = (1 until n).all { t[it] >= t[it - 1] }
    fun time(i: Int) = t[max(0, min(n - 1, i))]
    val start get() = t[0]
    val end get() = t[n - 1] + 1 / fps
    /** The frame on screen at time x: the last one presented at or before it (sample and hold). */
    fun frameAt(x: Double): Int {
        if (!monotonic) { var best = 0; var d = Double.MAX_VALUE; for (k in 0 until n) { val e = kotlin.math.abs(t[k] - x); if (e < d) { d = e; best = k } }; return best }
        var lo = 0; var hi = n - 1
        if (x < t[0] - 1e-6) return 0
        while (lo < hi) { val mid = (lo + hi + 1) ushr 1; if (t[mid] <= x + 1e-6) lo = mid else hi = mid - 1 }
        return lo
    }
}

/** Frame of `other` shown with frame i of the master chain: by time (default) or by frame number (legacy projects). */
private class Sync(master: Stream, private val other: Stream, private val byTime: Boolean, private val offsetFrames: Int) {
    private val tm = if (byTime) Timing(master) else null
    private val to = if (byTime) Timing(other) else null
    private val dt = offsetFrames / (if (master.info.fps > 0) master.info.fps else 25.0)
    fun map(i: Int): Int = if (tm == null) i + offsetFrames else to!!.frameAt(tm.time(i) + dt)
}

/** Fetches the two inputs of a link at the same time (their decoders and filters work in parallel). */
private suspend fun both(a: Stream, i: Int, b: Stream, j: Int): Pair<Frame, Frame> = coroutineScope {
    val fb = async { at(b, j) }
    a.getFrame(i) to fb.await()
}

private fun byTime(p: Params) = p.str("sync", "time") != "frame"

private val mixer: FilterImpl = { input, p, ctx ->
    val a = needInput(input)
    val second = p.str("second")
    if (second.isEmpty()) throw IllegalStateException("Select the second input chain in the Filter Settings")
    val b = ctx.chainStream(second)
    val w = a.info.width; val h = a.info.height; val mode = p.str("mode")
    val ow = if (mode == "sbs_h") w * 2 else w; val oh = if (mode == "sbs_v") h * 2 else h
    val bal = p.num("balance"); val g = p.num("gain"); val cs = max(1, p.int("checker"))
    val sync = Sync(a, b, byTime(p), p.int("offset"))
    object : Stream {
        override val info = a.info.copy(width = ow, height = oh)
        override fun meta(i: Int) = a.meta(i)
        override suspend fun getFrame(i: Int): Frame {
            val (fa, fb0) = both(a, i, b, sync.map(i))
            val fb = fit(fb0, w, h)
            val out = Frame.alloc(ow, oh, true)
            if (mode == "sbs_h" || mode == "sbs_v") { putRows(out, fa, 0, 0); if (mode == "sbs_h") putRows(out, fb, w, 0) else putRows(out, fb, 0, h); return out }
            Par.forRows(h) { y0, y1 -> for (y in y0 until y1) for (x in 0 until w) {
                val k = (y * w + x) * 4
                for (c in 0 until 3) {
                    val va = fa.d[k + c].toDouble(); val vb = fb.d[k + c].toDouble()
                    out.d[k + c] = (when (mode) {
                        "difference" -> 128 + (va - vb) * g / 2
                        "absdiff" -> abs(va - vb) * g
                        "wipe_h" -> if (x < bal * w) va else vb
                        "wipe_v" -> if (y < bal * h) va else vb
                        "checker" -> if (((x / cs + y / cs) and 1) == 0) va else vb
                        else -> va * (1 - bal) + vb * bal
                    }).toFloat()
                }
            } }
            return out
        }
    }
}

private val multiview: FilterImpl = { input, p, ctx ->
    val a = needInput(input)
    val others = ArrayList<Stream>(); val names = arrayListOf(ctx.chainName(ctx.chainId))
    for (id in p.strs("chains")) { if (id == ctx.chainId) continue; others.add(ctx.chainStream(id)); names.add(ctx.chainName(id)) }
    val all = listOf(a) + others
    val N = all.size
    val cols = if (p.int("columns") > 0) p.int("columns") else ceil(sqrt(N.toDouble())).toInt(); val rows = (N + cols - 1) / cols
    val W = a.info.width; val H = a.info.height; val B = max(0, p.int("border"))
    val ow = cols * W + (cols + 1) * B; val oh = rows * H + (rows + 1) * B
    val bc = parseColor(p.str("borderColor"))
    val timed = byTime(p)
    val syncs = all.map { Sync(a, it, timed, 0) }
    // by time the current chain is the clock; by frame number the longest chain sets the length
    val n = if (timed) a.info.frameCount else all.maxOf { it.info.frameCount }
    val labels = p.bool("labels")
    object : Stream {
        override val info = a.info.copy(width = ow, height = oh, frameCount = n)
        override fun meta(i: Int) = a.meta(min(a.info.frameCount - 1, i))
        override suspend fun getFrame(i: Int): Frame {
            val tiles = coroutineScope { all.indices.map { t -> async { letterbox(at(all[t], if (t == 0) i else syncs[t].map(i)), W, H) } }.map { it.await() } }
            val out = Frame.alloc(ow, oh, true)
            var k = 0; while (k < out.d.size) { out.d[k] = bc[0].toFloat(); out.d[k + 1] = bc[1].toFloat(); out.d[k + 2] = bc[2].toFloat(); k += 4 }
            for (t in 0 until N) putRows(out, tiles[t], B + (t % cols) * (W + B), B + (t / cols) * (H + B))
            if (!labels) return out
            return overlay(out) { c -> for (t in 0 until N) c.label(names[t], (B + (t % cols) * (W + B) + 8).toDouble(), (B + (t / cols) * (H + B) + 6).toDouble(), max(12, jsRound(H / 24.0)).toDouble(), colorInt("#ffffff"), colorInt("#000000", 0.6)) }
        }
    }
}

private val pip: FilterImpl = { input, p, ctx ->
    val a = needInput(input)
    val inset = p.str("inset")
    if (inset.isEmpty()) throw IllegalStateException("Select the inset chain in the Filter Settings")
    val b = ctx.chainStream(inset)
    val w = a.info.width; val h = a.info.height
    val iw = max(8, jsRound(w * p.num("scale") / 100)); val ih = max(8, jsRound(iw.toDouble() * b.info.height / max(1, b.info.width)))
    val x0 = jsRound(p.num("x") / 100 * w); val y0 = jsRound(p.num("y") / 100 * h)
    val B = p.int("border"); val bc = parseColor(p.str("borderColor"))
    val sync = Sync(a, b, byTime(p), p.int("offset"))
    object : Stream {
        override val info = a.info
        override fun meta(i: Int) = a.meta(i)
        override suspend fun getFrame(i: Int): Frame {
            val (fa, fb) = both(a, i, b, sync.map(i))
            val out = fa.copy()
            val ins = resize(fb, iw, ih, Interp.BILINEAR)
            for (y in -B until ih + B) for (x in -B until iw + B) {
                val X = x0 + x; val Y = y0 + y
                if (X < 0 || Y < 0 || X >= w || Y >= h) continue
                val o = (Y * w + X) * 4
                if (x < 0 || y < 0 || x >= iw || y >= ih) { out.d[o] = bc[0].toFloat(); out.d[o + 1] = bc[1].toFloat(); out.d[o + 2] = bc[2].toFloat(); continue }
                val s = (y * iw + x) * 4
                out.d[o] = ins.d[s]; out.d[o + 1] = ins.d[s + 1]; out.d[o + 2] = ins.d[s + 2]
            }
            return out
        }
    }
}

private val timeline: FilterImpl = { input, p, ctx ->
    val a = needInput(input)
    val parts = arrayListOf(a)
    for (id in p.strs("chains")) if (id != ctx.chainId) parts.add(ctx.chainStream(id))
    val fps = if (a.info.fps > 0) a.info.fps else 25.0
    val timed = byTime(p)
    val timings = parts.map { Timing(it) }
    // by time, every appended chain is resampled to this chain's frame rate, so it plays at its real speed
    val counts = parts.mapIndexed { k, s -> if (!timed || k == 0) s.info.frameCount else max(1, Math.round((timings[k].end - timings[k].start) * fps).toInt()) }
    val starts = IntArray(parts.size); var total = 0
    counts.forEachIndexed { k, c -> starts[k] = total; total += c }
    fun locate(i: Int): Pair<Int, Int> {
        var k = parts.size - 1; while (k > 0 && i < starts[k]) k--
        val j = i - starts[k]
        return k to (if (!timed || k == 0) j else timings[k].frameAt(timings[k].start + j / fps))
    }
    val w = a.info.width; val h = a.info.height
    object : Stream {
        override val info = a.info.copy(frameCount = total)
        override fun meta(i: Int): FrameMeta { val (k, j) = locate(i); return parts[k].meta(j).copy(pts = i / fps) }
        override suspend fun getFrame(i: Int): Frame { val (k, j) = locate(i); return letterbox(parts[k].getFrame(j), w, h) }
    }
}

private val replaceChannel: FilterImpl = { input, p, ctx ->
    val a = needInput(input)
    val src = p.str("source")
    if (src.isEmpty()) throw IllegalStateException("Select the source chain in the Filter Settings")
    val b = ctx.chainStream(src)
    val ti = when (p.str("target")) { "g" -> 1; "b" -> 2; else -> 0 }
    val sc = p.str("sourceChannel")
    val sync = Sync(a, b, byTime(p), 0)
    object : Stream {
        override val info = a.info
        override fun meta(i: Int) = a.meta(i)
        override suspend fun getFrame(i: Int): Frame {
            val (fa, fb0) = both(a, i, b, sync.map(i))
            val fb = fit(fb0, fa.w, fa.h)
            val out = fa.d.copyOf()
            var k = 0; while (k < out.size) { out[k + ti] = channelValue(sc, fb.d[k].toDouble(), fb.d[k + 1].toDouble(), fb.d[k + 2].toDouble()).toFloat(); k += 4 }
            return Frame(fa.w, fa.h, out)
        }
    }
}

val linkFilters: Map<String, FilterImpl> = mapOf("video_mixer" to mixer, "multiview" to multiview, "picture_in_picture" to pip, "timeline" to timeline, "replace_channel" to replaceChannel)

// ================================================================ presentation
private fun corner(pos: String, W: Int, H: Int, w: Double, h: Double, m: Double): Pair<Double, Double> = when (pos) {
    "tl" -> m to m; "tr" -> W - w - m to m; "bl" -> m to H - h - m; else -> W - w - m to H - h - m
}

fun fmtTime(t0: Double): String {
    var t = if (t0.isFinite()) t0 else 0.0
    val neg = t < 0; t = abs(t)
    val hh = floor(t / 3600).toInt(); val mm = floor((t % 3600) / 60).toInt(); val ss = floor(t % 60).toInt(); val ms = Math.round((t - floor(t)) * 1000).toInt() % 1000
    return "${if (neg) "-" else ""}%02d:%02d:%02d.%03d".format(hh, mm, ss, ms)
}

private val addText: FilterImpl = { input, p, _ ->
    mapStream(input) { f, _ -> overlay(f) { c ->
        val pos = p.pt("position") ?: Pt(20.0, 20.0)
        c.label(p.str("text"), pos.x, pos.y, p.num("size"), colorInt(p.str("color")), if (p.bool("background")) colorInt(p.str("bgColor"), p.num("bgOpacity")) else null, p.str("font"), p.bool("bold"))
    } }
}

private val addShape: FilterImpl = { input, p, _ ->
    val s = needInput(input)
    mapStream(s) { f, i ->
        val from = clampFrameIndex(p.num("from"), s.info.frameCount); val to = clampFrameIndex(p.num("to"), s.info.frameCount, true)
        if (i < from || i > to) f else overlay(f) { c ->
            val th = p.num("thickness"); val shape = p.str("shape")
            c.lineWidth(th); c.strokeColor(p.str("borderColor")); c.fillColor(p.str("borderColor"))
            if (shape == "rectangle" || shape == "ellipse") {
                val r = p.rect("rect") ?: return@overlay
                if (p.bool("fill")) c.fillColor(p.str("fillColor"), p.num("fillOpacity"))
                if (shape == "rectangle") c.rect(r.x, r.y, r.w, r.h, p.bool("fill"), th > 0)
                else c.ellipse(r.x + r.w / 2, r.y + r.h / 2, abs(r.w / 2), abs(r.h / 2), p.bool("fill"), th > 0)
            } else {
                val l = p.line("line") ?: return@overlay
                c.line(l.first.x, l.first.y, l.second.x, l.second.y)
                val hs = max(8.0, th * 4)
                if (shape == "arrow" || shape == "double_arrow") c.arrowHead(l.first.x, l.first.y, l.second.x, l.second.y, hs)
                if (shape == "double_arrow") c.arrowHead(l.second.x, l.second.y, l.first.x, l.first.y, hs)
            }
        }
    }
}

private fun regionMask(w: Int, h: Int, r: RectP, ellipse: Boolean, feather: Double = 0.0): FloatArray {
    val m = FloatArray(w * h)
    val cx = r.x + r.w / 2; val cy = r.y + r.h / 2; val rx = abs(r.w / 2); val ry = abs(r.h / 2)
    Par.forRows(h) { y0, y1 -> for (y in y0 until y1) for (x in 0 until w) {
        val dist = if (ellipse) { val nx = (x + 0.5 - cx) / (if (rx != 0.0) rx else 1.0); val ny = (y + 0.5 - cy) / (if (ry != 0.0) ry else 1.0); (sqrt(nx * nx + ny * ny) - 1) * min(rx, ry) }
        else max(abs(x + 0.5 - cx) - rx, abs(y + 0.5 - cy) - ry)
        m[y * w + x] = (if (feather > 0) min(1.0, max(0.0, 0.5 - dist / feather)) else if (dist <= 0) 1.0 else 0.0).toFloat()
    } }
    return m
}

private val hideSelection: FilterImpl = { input, p, _ ->
    mapStream(input) { f, _ ->
        val r = p.rect("rect")
        if (r == null || r.w < 1 || r.h < 1) f else {
            val hidden: Frame = when (p.str("mode")) {
                "fill" -> { val c = parseColor(p.str("color")); Frame.solid(f.w, f.h, c[0].toFloat(), c[1].toFloat(), c[2].toFloat()) }
                "blur" -> gaussianBlur(f, max(1.0, p.num("strength") / 2))
                else -> {
                    val hd = Frame.alloc(f.w, f.h, true); val B = max(2, p.int("strength"))
                    var by = 0
                    while (by < f.h) { var bx = 0; while (bx < f.w) {
                        var rr = 0.0; var gg = 0.0; var bb = 0.0; var c = 0
                        for (y in by until min(f.h, by + B)) for (x in bx until min(f.w, bx + B)) { val k = (y * f.w + x) * 4; rr += f.d[k]; gg += f.d[k + 1]; bb += f.d[k + 2]; c++ }
                        for (y in by until min(f.h, by + B)) for (x in bx until min(f.w, bx + B)) { val k = (y * f.w + x) * 4; hd.d[k] = (rr / c).toFloat(); hd.d[k + 1] = (gg / c).toFloat(); hd.d[k + 2] = (bb / c).toFloat() }
                        bx += B } ; by += B }
                    hd
                }
            }
            val m = regionMask(f.w, f.h, r, p.str("shape") == "ellipse")
            val out = f.d.copyOf()
            for (i in m.indices) if (m[i] > 0) { val k = i * 4; for (c in 0 until 3) out[k + c] = (f.d[k + c] * (1 - m[i]) + hidden.d[k + c] * m[i]) }
            Frame(f.w, f.h, out)
        }
    }
}

private val spotlight: FilterImpl = { input, p, _ ->
    mapStream(input) { f, _ ->
        val r = p.rect("rect")
        if (r == null || r.w < 1 || r.h < 1) f else {
            val ell = p.str("shape") == "ellipse"
            val m = regionMask(f.w, f.h, r, ell, p.num("feather"))
            val out = f.d.copyOf(); val dim = p.num("dim")
            for (i in m.indices) { val k = i * 4; val g = 1 - dim * (1 - m[i]); out[k] = (out[k] * g).toFloat(); out[k + 1] = (out[k + 1] * g).toFloat(); out[k + 2] = (out[k + 2] * g).toFloat() }
            val res = Frame(f.w, f.h, out)
            if (!p.bool("border")) res else overlay(res) { c -> c.strokeColor(p.str("borderColor")); c.lineWidth(2.0); if (ell) c.ellipse(r.x + r.w / 2, r.y + r.h / 2, abs(r.w / 2), abs(r.h / 2), false, true) else c.rect(r.x, r.y, r.w, r.h, false, true) }
        }
    }
}

private val magnify: FilterImpl = { input, p, _ ->
    mapStream(input) { f, _ ->
        val r = p.rect("rect")
        if (r == null || r.w < 2 || r.h < 2) f else {
            val src = cropFrame(f, r.x, r.y, r.w, r.h)
            var iw = jsRound(r.w * p.num("zoom")); var ih = jsRound(r.h * p.num("zoom"))
            val s = min(1.0, min(f.w * 0.6 / iw, f.h * 0.6 / ih))
            iw = max(4, jsRound(iw * s)); ih = max(4, jsRound(ih * s))
            val inset = resize(src, iw, ih, Interp.of(p.str("interp")))
            val border = p.int("border")
            val (x0d, y0d) = corner(p.str("position"), f.w, f.h, iw.toDouble(), ih.toDouble(), 10.0 + border)
            val x0 = x0d.toInt(); val y0 = y0d.toInt()
            val out = f.d.copyOf()
            for (y in 0 until ih) for (x in 0 until iw) {
                val X = x0 + x; val Y = y0 + y
                if (X < 0 || Y < 0 || X >= f.w || Y >= f.h) continue
                val o = (Y * f.w + X) * 4; val q = (y * iw + x) * 4
                out[o] = inset.d[q]; out[o + 1] = inset.d[q + 1]; out[o + 2] = inset.d[q + 2]
            }
            overlay(Frame(f.w, f.h, out)) { c ->
                if (border == 0) return@overlay
                c.strokeColor(p.str("borderColor")); c.lineWidth(border.toDouble())
                c.rect(x0 - border / 2.0, y0 - border / 2.0, iw + border.toDouble(), ih + border.toDouble(), false, true)
                c.lineWidth(max(1.0, border / 2.0)); c.rect(r.x, r.y, r.w, r.h, false, true)
                c.dash(4f, 4f); c.line(r.x + r.w / 2, r.y + r.h / 2, x0 + iw / 2.0, y0 + ih / 2.0); c.noDash()
            }
        }
    }
}

private val addTimestamp: FilterImpl = { input, p, _ ->
    val s = needInput(input)
    val start: Long? = try { LocalDateTime.parse(p.str("start").trim().replace(" ", "T")).toInstant(ZoneOffset.UTC).toEpochMilli() } catch (_: Exception) { try { Instant.parse(p.str("start").trim().replace(" ", "T")).toEpochMilli() } catch (_: Exception) { null } }
    val fmt = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS").withZone(ZoneOffset.UTC)
    mapStream(s) { f, i ->
        val pts = s.meta(i).pts ?: (i / s.info.fps)
        val text = when (p.str("format")) {
            "frame" -> "Frame $i"
            "time" -> fmtTime(pts)
            "datetime" -> if (start != null) fmt.format(Instant.ofEpochMilli(start + Math.round(pts * 1000))) else fmtTime(pts)
            else -> "Frame $i   ${fmtTime(pts)}"
        }
        overlay(f) { c ->
            c.font("mono", p.num("size"), true)
            val tw = c.measure(text)
            val (x, y) = corner(p.str("position"), f.w, f.h, tw, p.num("size") * 1.2, 10.0)
            c.label(text, x, y, p.num("size"), colorInt(p.str("color")), if (p.bool("background")) colorInt("#000000", 0.65) else null, "mono", true)
        }
    }
}

private val addLogo: FilterImpl = { input, p, ctx ->
    val s = needInput(input)
    val img = p.str("image")
    if (img.isEmpty()) s else {
        val logo = ctx.source(img).getFrame(0)
        val W = s.info.width; val H = s.info.height
        val lw = max(4, jsRound(W * p.num("scale") / 100)); val lh = max(4, jsRound(lw.toDouble() * logo.h / logo.w))
        val L = resize(logo, lw, lh, Interp.BICUBIC)
        val (x0d, y0d) = corner(p.str("position"), W, H, lw.toDouble(), lh.toDouble(), p.num("margin"))
        val x0 = x0d.toInt(); val y0 = y0d.toInt(); val op = p.num("opacity")
        mapStream(s) { f, _ ->
            val out = f.d.copyOf()
            for (y in 0 until lh) for (x in 0 until lw) {
                val X = x0 + x; val Y = y0 + y
                if (X < 0 || Y < 0 || X >= f.w || Y >= f.h) continue
                val o = (Y * f.w + X) * 4; val q = (y * lw + x) * 4; val a = L.d[q + 3] / 255.0 * op
                for (c in 0 until 3) out[o + c] = (out[o + c] + (L.d[q + c] - out[o + c]) * a).toFloat()
            }
            Frame(f.w, f.h, out)
        }
    }
}

private val addGrid: FilterImpl = { input, p, _ ->
    mapStream(input) { f, _ -> overlay(f) { c ->
        val sp = max(4, p.int("spacing")); val op = p.num("opacity")
        c.strokeColor(p.str("color"), op); c.lineWidth(p.num("thickness"))
        var x = 0; while (x <= f.w) { c.line(x + 0.5, 0.0, x + 0.5, f.h.toDouble()); x += sp }
        var y = 0; while (y <= f.h) { c.line(0.0, y + 0.5, f.w.toDouble(), y + 0.5); y += sp }
        if (p.bool("labels")) {
            val col = colorInt(p.str("color"), min(1.0, op + 0.3))
            x = 0; while (x <= f.w) { c.label(x.toString(), x + 2.0, 0.0, 10.0, col, null, "mono", false); x += sp }
            y = sp; while (y <= f.h) { c.label(y.toString(), 2.0, y - 12.0, 10.0, col, null, "mono", false); y += sp }
        }
    } }
}

// ---------------------------------------------------------------- measurement
private fun len(l: Pair<Pt, Pt>) = hypot(l.second.x - l.first.x, l.second.y - l.first.y)

private fun drawSegment(c: Draw, l: Pair<Pt, Pt>, color: String, text: String, size: Double, dashed: Boolean = false) {
    c.strokeColor(color); c.fillColor(color); c.lineWidth(max(1.5, size / 8))
    if (dashed) c.dash(6f, 4f) else c.noDash()
    c.line(l.first.x, l.first.y, l.second.x, l.second.y)
    c.noDash()
    for (q in listOf(l.first, l.second)) c.circle(q.x, q.y, max(2.5, size / 6), true)
    if (text.isNotEmpty()) c.label(text, (l.first.x + l.second.x) / 2 + 8, (l.first.y + l.second.y) / 2 + 6, size, colorInt(color), colorInt("#000000", 0.65))
}

private val measure1d: FilterImpl = { input, p, _ ->
    mapStream(input) { f, _ -> overlay(f) { c ->
        val ref = p.line("refLine"); val unit = p.str("unit"); val size = p.num("size")
        if (ref != null) drawSegment(c, ref, "#ffffff", "Reference: %.3f %s".format(p.num("refLength"), unit), size * 0.85, true)
        p.line("line")?.let { l ->
            val scale = if (ref != null && len(ref) > 0) p.num("refLength") / len(ref) else 0.0
            drawSegment(c, l, p.str("color"), if (scale != 0.0) "%.3f %s".format(len(l) * scale, unit) else "%.1f px".format(len(l)), size)
        }
    } }
}

private val measure2d: FilterImpl = { input, p, _ ->
    mapStream(input) { f, _ -> overlay(f) { c ->
        val q = p.pts("refPoints"); val size = p.num("size"); val unit = p.str("unit"); val l = p.line("line")
        if (q.size >= 2) { c.strokeColor("#ffffff"); c.lineWidth(1.5); c.dash(6f, 4f); c.poly(q.map { it.x to it.y }, q.size == 4); c.noDash() }
        if (q.size == 4 && l != null) {
            try {
                val H = homography(q, listOf(Pt(0.0, 0.0), Pt(p.num("refWidth"), 0.0), Pt(p.num("refWidth"), p.num("refHeight")), Pt(0.0, p.num("refHeight"))))
                val a = applyH(H, l.first.x, l.first.y); val b = applyH(H, l.second.x, l.second.y)
                drawSegment(c, l, p.str("color"), "%.3f %s".format(hypot(b[0] - a[0], b[1] - a[1]), unit), size)
            } catch (_: Exception) { drawSegment(c, l, p.str("color"), "invalid reference", size) }
        } else if (l != null) drawSegment(c, l, p.str("color"), "%.1f px".format(len(l)), size)
    } }
}

val presentationFilters: Map<String, FilterImpl> = mapOf(
    "add_text" to addText, "add_shape" to addShape, "hide_selection" to hideSelection, "spotlight" to spotlight, "magnify" to magnify,
    "add_timestamp" to addTimestamp, "add_logo" to addLogo, "add_grid" to addGrid, "measure_1d" to measure1d, "measure_2d" to measure2d,
)

