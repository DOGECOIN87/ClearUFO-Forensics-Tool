package com.clearufo.forensics.engine.filters

import com.clearufo.forensics.engine.*
import com.clearufo.forensics.engine.kernels.*
import com.clearufo.forensics.media.DecodeOptions
import com.clearufo.forensics.media.SourceProvider
import com.clearufo.forensics.media.SyntheticSource
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

// Frame-wise filter implementations (port of engine/filters/basic.ts).

interface BuildCtx {
    val chainId: String
    val filterId: String
    val key: String
    fun source(id: String): SourceProvider
    suspend fun chainStream(id: String): Stream
    fun chainName(id: String): String
    suspend fun originalStream(): Stream
    fun sourceOfChain(): SourceProvider?
    fun progress(label: String, v: Double)
    fun isStale(): Boolean
}

typealias FilterImpl = suspend (Stream?, Params, BuildCtx) -> Stream

// ---------------------------------------------------------------- loaders
private val fileLoader: FilterImpl = { _, p, ctx ->
    val id = p.str("source")
    if (id.isEmpty()) throw IllegalStateException("No file selected. Use Browse to choose a file.")
    val src = ctx.source(id)
    val opts = DecodeOptions(p.str("engine", "webcodecs"), p.str("colorRange", "auto"), p.str("matrix", "auto"), p.str("chroma", "nearest").ifEmpty { "nearest" },
        p.str("siting", "auto"), p.str("hdr", "none").ifEmpty { "none" }, p.num("hdrPeak", 1000.0))
    val par = src.info.par?.let { if (it.second != 0) it.first.toDouble() / it.second else 1.0 } ?: 1.0
    val fps = if (p.num("fps") > 0 && src.info.kind == "sequence") p.num("fps") else src.info.fps
    object : Stream {
        override val info = StreamInfo(src.info.width, src.info.height, src.info.frameCount, fps, par)
        override suspend fun getFrame(i: Int) = src.getFrame(i, opts)
        override fun meta(i: Int) = if (src.info.kind == "sequence") src.meta(i).copy(pts = i / fps) else src.meta(i)
    }
}

private val testPattern: FilterImpl = { _, p, ctx ->
    val s = SyntheticSource(ctx.key, p)
    object : Stream {
        override val info = StreamInfo(s.info.width, s.info.height, s.info.frameCount, s.info.fps, 1.0)
        override suspend fun getFrame(i: Int) = s.getFrame(i)
        override fun meta(i: Int) = s.meta(i)
    }
}

// ---------------------------------------------------------------- channels
private val grayscale: FilterImpl = { input, p, _ ->
    val m = p.str("method")
    val wr = if (m == "bt709") 0.2126 else 0.299; val wg = if (m == "bt709") 0.7152 else 0.587; val wb = if (m == "bt709") 0.0722 else 0.114
    mapStream(input) { f, _ -> mapPixels(f) { r, g, b, o, i ->
        val v = when (m) { "average" -> (r + g + b) / 3; "lightness" -> (max(r, max(g, b)) + min(r, min(g, b))) / 2; "max" -> max(r, max(g, b)); "min" -> min(r, min(g, b)); else -> wr * r + wg * g + wb * b }
        o[i] = v.toFloat(); o[i + 1] = v.toFloat(); o[i + 2] = v.toFloat()
    } }
}

private val colorConversion: FilterImpl = { input, p, _ ->
    val space = p.str("space")
    mapStream(input) { f, _ -> mapPixels(f) { r, g, b, o, i ->
        val c = when (space) {
            "ycbcr709" -> ycbcr(r, g, b, true)
            "hsv" -> rgbToHsv(r, g, b).let { doubleArrayOf(it[0] / 360 * 255, it[1] * 255, it[2] * 255) }
            "hsl" -> rgbToHsl(r, g, b).let { doubleArrayOf(it[0] / 360 * 255, it[1] * 255, it[2] * 255) }
            "lab" -> rgbToLab(r, g, b).let { doubleArrayOf(it[0] * 2.55, it[1] + 128, it[2] + 128) }
            "cmy" -> doubleArrayOf(255 - r, 255 - g, 255 - b)
            "xyz" -> rgbToXyz(r, g, b).let { doubleArrayOf(it[0] * 255, it[1] * 255, it[2] * 255) }
            else -> ycbcr(r, g, b, false)
        }
        o[i] = c[0].toFloat(); o[i + 1] = c[1].toFloat(); o[i + 2] = c[2].toFloat()
    } }
}

private fun switchPick(s: String, r: Double, g: Double, b: Double) = when (s) { "r" -> r; "g" -> g; "b" -> b; "full" -> 255.0; else -> 0.0 }
private val colorSwitch: FilterImpl = { input, p, _ ->
    val pr = p.str("r"); val pg = p.str("g"); val pb = p.str("b")
    mapStream(input) { f, _ -> mapPixels(f) { r, g, b, o, i -> o[i] = switchPick(pr, r, g, b).toFloat(); o[i + 1] = switchPick(pg, r, g, b).toFloat(); o[i + 2] = switchPick(pb, r, g, b).toFloat() } }
}

fun channelValue(ch: String, r: Double, g: Double, b: Double): Double = when (ch) {
    "r" -> r; "g" -> g; "b" -> b
    "y" -> 0.299 * r + 0.587 * g + 0.114 * b
    "cb" -> ycbcr(r, g, b, false)[1]; "cr" -> ycbcr(r, g, b, false)[2]
    "h" -> rgbToHsv(r, g, b)[0] / 360 * 255; "s" -> rgbToHsv(r, g, b)[1] * 255; "v" -> rgbToHsv(r, g, b)[2] * 255
    "l" -> rgbToLab(r, g, b)[0] * 2.55; "a" -> rgbToLab(r, g, b)[1] + 128; "bb" -> rgbToLab(r, g, b)[2] + 128
    "c", "m", "ye", "k" -> {
        val k = 1 - max(r, max(g, b)) / 255
        if (ch == "k") k * 255 else {
            val den = (1 - k).let { if (it != 0.0) it else 1.0 }
            (when (ch) { "c" -> (1 - r / 255 - k) / den; "m" -> (1 - g / 255 - k) / den; else -> (1 - b / 255 - k) / den }) * 255
        }
    }
    else -> r
}

private val extractChannel: FilterImpl = { input, p, _ ->
    val ch = p.str("channel"); val stretch = p.bool("stretch")
    mapStream(input) { f, _ ->
        val n = f.w * f.h; val plane = FloatArray(n)
        Par.forRows(f.h) { y0, y1 -> for (i in y0 * f.w until y1 * f.w) { val k = i * 4; plane[i] = channelValue(ch, f.d[k].toDouble(), f.d[k + 1].toDouble(), f.d[k + 2].toDouble()).toFloat() } }
        if (stretch) {
            var mn = Double.POSITIVE_INFINITY; var mx = Double.NEGATIVE_INFINITY
            for (v in plane) { if (v < mn) mn = v.toDouble(); if (v > mx) mx = v.toDouble() }
            val s = if (mx > mn) 255 / (mx - mn) else 1.0
            for (i in 0 until n) plane[i] = ((plane[i] - mn) * s).toFloat()
        }
        grayFrame(f.w, f.h, plane)
    }
}

private val enableChannels: FilterImpl = { input, p, _ ->
    val er = p.bool("r"); val eg = p.bool("g"); val eb = p.bool("b")
    mapStream(input) { f, _ -> mapPixels(f) { r, g, b, o, i -> o[i] = if (er) r.toFloat() else 0f; o[i + 1] = if (eg) g.toFloat() else 0f; o[i + 2] = if (eb) b.toFloat() else 0f } }
}

// ---------------------------------------------------------------- adjust
private fun perChannel(p: Params, lut: Lut): Array<Lut?> { val c = p.str("channel"); return arrayOf(if (c == "all" || c == "r") lut else null, if (c == "all" || c == "g") lut else null, if (c == "all" || c == "b") lut else null) }

private val levels: FilterImpl = { input, p, _ ->
    val l = perChannel(p, levelsLut(p.num("inBlack"), p.num("inWhite"), p.num("gamma"), p.num("outBlack"), p.num("outWhite")))
    mapStream(input) { f, _ -> applyLuts(f, l[0], l[1], l[2]) }
}
private val curves: FilterImpl = { input, p, _ ->
    val l = perChannel(p, Lut(curveFunction(p.pts("curve"))))
    mapStream(input) { f, _ -> applyLuts(f, l[0], l[1], l[2]) }
}
private val brightnessContrast: FilterImpl = { input, p, _ ->
    val l = brightnessContrastLut(p.num("brightness"), p.num("contrast")); mapStream(input) { f, _ -> applyLuts(f, l, l, l) }
}
private val exposure: FilterImpl = { input, p, _ ->
    val l = exposureLut(p.num("exposure"), p.num("gamma"), p.num("offset")); mapStream(input) { f, _ -> applyLuts(f, l, l, l) }
}

private val autoContrast: FilterImpl = { input, p, _ ->
    mapStream(input) { f, _ ->
        val planes = split(f); val n = f.w * f.h
        fun range(pl: FloatArray): Pair<Int, Int> { val h = histogramPlane(pl); return percentileFromHist(h, n, p.num("clipLow") / 100) to percentileFromHist(h, n, 1 - p.num("clipHigh") / 100) }
        val luts = if (p.bool("linked")) { val (lo, hi) = range(luma(f)); val l = Lut({ v -> (v - lo) / max(1, hi - lo) * 255 }); arrayOf(l, l, l) }
        else Array(3) { c -> val (lo, hi) = range(planes[c]); Lut({ v -> (v - lo) / max(1, hi - lo) * 255 }) }
        applyLuts(f, luts[0], luts[1], luts[2])
    }
}

private val histEq: FilterImpl = { input, p, _ ->
    mapStream(input) { f, _ ->
        val w = f.w; val h = f.h; val n = w * h; val amt = p.num("amount")
        fun eq(pl: FloatArray): FloatArray {
            if (p.str("mode") == "clahe") return clahe(pl, w, h, p.int("tiles"), p.num("clip"))
            val map = equalizeMap(histogramPlane(pl), n)
            return FloatArray(n) { map[min(255, max(0, jsRoundD(pl[it].toDouble()).toInt()))] }
        }
        if (p.str("target") == "rgb") {
            val out = mapRGB(f, ::eq)
            if (amt < 1) for (i in out.d.indices) if (i and 3 != 3) out.d[i] = (f.d[i] + (out.d[i] - f.d[i]) * amt).toFloat()
            out
        } else {
            val Y = luma(f); val Y2 = eq(Y)
            mapPixels(f) { r, g, b, o, i ->
                val k = i shr 2
                val c = ycbcr(r, g, b, false)
                val yy = Y[k] + (Y2[k] - Y[k]) * amt
                val rgb = ycbcrToRgb(yy, c[1], c[2])
                o[i] = rgb[0].toFloat(); o[i + 1] = rgb[1].toFloat(); o[i + 2] = rgb[2].toFloat()
            }
        }
    }
}

private val whiteBalance: FilterImpl = { input, p, _ ->
    mapStream(input) { f, _ ->
        var gains = doubleArrayOf(1.0, 1.0, 1.0)
        val d = f.d; val n = f.w * f.h
        when (p.str("mode")) {
            "manual" -> gains = doubleArrayOf(p.num("r"), p.num("g"), p.num("b"))
            "grayworld" -> {
                var r = 0.0; var g = 0.0; var b = 0.0
                var i = 0; while (i < d.size) { r += d[i]; g += d[i + 1]; b += d[i + 2]; i += 4 }
                val m = (r + g + b) / 3
                gains = doubleArrayOf(m / max(1e-6, r), m / max(1e-6, g), m / max(1e-6, b))
            }
            "whitepatch" -> {
                val pl = split(f)
                fun hi(x: FloatArray) = max(1, percentileFromHist(histogramPlane(x), n, 0.995)).toDouble()
                gains = doubleArrayOf(255 / hi(pl[0]), 255 / hi(pl[1]), 255 / hi(pl[2]))
            }
            "point" -> p.pt("point")?.let { pt ->
                val rad = p.int("radius")
                var r = 0.0; var g = 0.0; var b = 0.0; var c = 0
                for (y in jsRound(pt.y) - rad..jsRound(pt.y) + rad) for (x in jsRound(pt.x) - rad..jsRound(pt.x) + rad) {
                    if (x < 0 || y < 0 || x >= f.w || y >= f.h) continue
                    val k = (y * f.w + x) * 4; r += d[k]; g += d[k + 1]; b += d[k + 2]; c++
                }
                if (c > 0) { val m = (r + g + b) / 3; gains = doubleArrayOf(m / max(1e-6, r), m / max(1e-6, g), m / max(1e-6, b)) }
            }
        }
        mapPixels(f) { r, g, b, o, i -> o[i] = (r * gains[0]).toFloat(); o[i + 1] = (g * gains[1]).toFloat(); o[i + 2] = (b * gains[2]).toFloat() }
    }
}

private val hueSat: FilterImpl = { input, p, _ ->
    val hue = p.num("hue"); val sat = p.num("saturation"); val light = p.num("lightness")
    mapStream(input) { f, _ -> mapPixels(f) { r, g, b, o, i ->
        val hsl = rgbToHsl(clamp255(r), clamp255(g), clamp255(b))
        val h = hsl[0] + hue
        val s = min(1.0, max(0.0, hsl[1] * (1 + sat / 100)))
        val l = if (light >= 0) hsl[2] + (1 - hsl[2]) * (light / 100) else hsl[2] * (1 + light / 100)
        val c = hslToRgb(h, s, l)
        o[i] = c[0].toFloat(); o[i + 1] = c[1].toFloat(); o[i + 2] = c[2].toFloat()
    } }
}

private val negative: FilterImpl = { input, _, _ -> mapStream(input) { f, _ -> mapPixels(f) { r, g, b, o, i -> o[i] = (255 - r).toFloat(); o[i + 1] = (255 - g).toFloat(); o[i + 2] = (255 - b).toFloat() } } }

private val threshold: FilterImpl = { input, p, _ ->
    val rgb = p.str("mode") == "rgb"; val level = p.num("level")
    mapStream(input) { f, _ -> mapPixels(f) { r, g, b, o, i ->
        if (rgb) { o[i] = if (r >= level) 255f else 0f; o[i + 1] = if (g >= level) 255f else 0f; o[i + 2] = if (b >= level) 255f else 0f }
        else { val v = if (0.299 * r + 0.587 * g + 0.114 * b >= level) 255f else 0f; o[i] = v; o[i + 1] = v; o[i + 2] = v }
    } }
}

// ---------------------------------------------------------------- extract
private val fourier: FilterImpl = { input, p, _ -> mapStream(input) { f, _ -> grayFrame(f.w, f.h, spectrumOf(f, p.str("channel"), p.str("mode") == "phase", p.bool("log"))) } }

private val fourierFilt: FilterImpl = { input, p, _ ->
    mapStream(input) { f, _ ->
        if (p.str("view") == "spectrum") {
            val spec = grayFrame(f.w, f.h, spectrumOf(f, "y", false, true))
            val pts = if (p.str("filter") == "notch") p.pts("points") else emptyList()
            overlay(spec) { c ->
                c.lineWidth(1.5)
                for (pt in pts) {
                    val marks = if (p.bool("symmetric")) listOf(pt, Pt(f.w - pt.x, f.h - pt.y)) else listOf(pt)
                    marks.forEachIndexed { k, m -> c.strokeColor(if (k > 0) "#ffaa00" else "#ff3030", if (k > 0) 0.8 else 1.0); c.circle(m.x, m.y, p.num("radius"), false) }
                }
                if (p.str("filter") != "notch") { c.strokeColor("#ffd400"); c.ellipse(f.w / 2.0, f.h / 2.0, p.num("cutoff") * f.w, p.num("cutoff") * f.h, false, true) }
            }
        } else fourierFilter(f, p.str("filter"), p.pts("points"), p.num("radius"), p.bool("symmetric"), p.num("cutoff"), p.bool("smooth"))
    }
}

private val KERNELS = mapOf(
    "sobel" to (doubleArrayOf(-1.0, 0.0, 1.0, -2.0, 0.0, 2.0, -1.0, 0.0, 1.0) to doubleArrayOf(-1.0, -2.0, -1.0, 0.0, 0.0, 0.0, 1.0, 2.0, 1.0)),
    "prewitt" to (doubleArrayOf(-1.0, 0.0, 1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 1.0) to doubleArrayOf(-1.0, -1.0, -1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0)),
    "scharr" to (doubleArrayOf(-3.0, 0.0, 3.0, -10.0, 0.0, 10.0, -3.0, 0.0, 3.0) to doubleArrayOf(-3.0, -10.0, -3.0, 0.0, 0.0, 0.0, 3.0, 10.0, 3.0)),
)

private val gradient: FilterImpl = { input, p, _ ->
    mapStream(input) { f, _ ->
        val w = f.w; val h = f.h; val Y = luma(f); val n = w * h; val gain = p.num("gain"); val out = p.str("output"); val op = p.str("operator")
        if (op == "laplacian") {
            val L = conv3x3(Y, w, h, doubleArrayOf(0.0, 1.0, 0.0, 1.0, -4.0, 1.0, 0.0, 1.0, 0.0))
            grayFrame(w, h, FloatArray(n) { (if (out == "magnitude") abs(L[it]) * gain else 128 + L[it] * gain).toFloat() })
        } else {
            val (kx, ky) = KERNELS[op] ?: KERNELS.getValue("sobel")
            val norm = if (op == "scharr") 1.0 / 16 else if (op == "prewitt") 1.0 / 3 else 1.0 / 4
            val gx = conv3x3(Y, w, h, kx); val gy = conv3x3(Y, w, h, ky)
            if (out == "direction") {
                val o = Frame.alloc(w, h, true)
                for (i in 0 until n) {
                    val mag = min(1.0, hypot(gx[i].toDouble(), gy[i].toDouble()) * norm * gain / 128)
                    val ang = (atan2(gy[i].toDouble(), gx[i].toDouble()) * 180 / PI + 360) % 360
                    val c = hslToRgb(ang, 1.0, mag * 0.5)
                    o.d[i * 4] = c[0].toFloat(); o.d[i * 4 + 1] = c[1].toFloat(); o.d[i * 4 + 2] = c[2].toFloat()
                }
                o
            } else grayFrame(w, h, FloatArray(n) {
                (when (out) { "x" -> 128 + gx[it] * norm * gain; "y" -> 128 + gy[it] * norm * gain; else -> hypot(gx[it].toDouble(), gy[it].toDouble()) * norm * gain }).toFloat()
            })
        }
    }
}

private val bitPlane: FilterImpl = { input, p, _ ->
    val ch = p.str("channel"); val bit = p.int("bit")
    mapStream(input) { f, _ -> mapPixels(f) { r, g, b, o, i ->
        val v = jsRoundD(clamp255(channelValue(ch, r, g, b))).toInt()
        val x = (((v shr bit) and 1) * 255).toFloat(); o[i] = x; o[i + 1] = x; o[i + 2] = x
    } }
}

// ---------------------------------------------------------------- sharpen / denoise
private val unsharp: FilterImpl = { input, p, _ ->
    mapStream(input) { f, _ ->
        val bl = gaussianBlur(f, p.num("radius")); val out = f.copy()
        val amount = p.num("amount"); val thr = p.num("threshold")
        for (i in out.d.indices) { if (i and 3 == 3) continue; val diff = f.d[i] - bl.d[i]; if (abs(diff) >= thr) out.d[i] = (f.d[i] + amount * diff).toFloat() }
        out
    }
}

private val laplacianSharp: FilterImpl = { input, p, _ ->
    val diag = p.bool("diagonals")
    val k = if (diag) doubleArrayOf(1.0, 1.0, 1.0, 1.0, -8.0, 1.0, 1.0, 1.0, 1.0) else doubleArrayOf(0.0, 1.0, 0.0, 1.0, -4.0, 1.0, 0.0, 1.0, 0.0)
    val s = if (diag) p.num("amount") / 2 else p.num("amount")
    mapStream(input) { f, _ -> mapRGB(f) { pl -> val L = conv3x3(pl, f.w, f.h, k); FloatArray(pl.size) { (pl[it] - s * L[it]).toFloat() } } }
}

private val highPass: FilterImpl = { input, p, _ ->
    mapStream(input) { f, _ ->
        val bl = gaussianBlur(f, p.num("radius")).d; val amount = p.num("amount")
        mapPixels(f) { r, g, b, o, i -> o[i] = (r + amount * (r - bl[i])).toFloat(); o[i + 1] = (g + amount * (g - bl[i + 1])).toFloat(); o[i + 2] = (b + amount * (b - bl[i + 2])).toFloat() }
    }
}

// ---------------------------------------------------------------- deblurring
private val deblur: FilterImpl = { input, p, ctx ->
    val src = needInput(input)
    val psf = psfForFilter(p.str("__type"), p)
    if (psf == null) src else mapStream(src) { f, _ ->
        deconvolve(f, psf, DeconvMethod.of(p.str("method")), p.num("noise"), max(1, p.int("iterations", 25)), { ctx.progress("Deblurring", it) }, ctx::isStale)
    }
}

// ---------------------------------------------------------------- verify
private fun fitInto(f: Frame, w: Int, h: Int): Frame {
    val s = min(w.toDouble() / f.w, h.toDouble() / f.h)
    val nw = max(1, jsRound(f.w * s)); val nh = max(1, jsRound(f.h * s))
    val r = resize(f, nw, nh, Interp.BICUBIC)
    val out = Frame.alloc(w, h, true)
    putRows(out, r, (w - nw) shr 1, (h - nh) shr 1)
    return out
}

private val compareOriginal: FilterImpl = { input, p, ctx ->
    val src = needInput(input)
    val orig = ctx.originalStream()
    val w = src.info.width; val h = src.info.height
    val lt = max(0, p.int("lineThickness"))
    val lc = parseColor(p.str("lineColor"))
    val mode = p.str("mode")
    val ow = if (mode == "sbs_h") w * 2 + lt else w; val oh = if (mode == "sbs_v") h * 2 + lt else h
    val balance = p.num("balance"); val gain = p.num("gain")
    object : Stream {
        override val info = src.info.copy(width = ow, height = oh)
        override fun meta(i: Int) = src.meta(i)
        override suspend fun getFrame(i: Int): Frame {
            val proc = src.getFrame(i)
            val o0 = orig.getFrame(min(orig.info.frameCount - 1, src.meta(i).src ?: i))
            val of = if (mode == "sbs_h" || mode == "sbs_v") fitInto(o0, w, h) else if (o0.w == w && o0.h == h) o0 else resize(o0, w, h, Interp.BICUBIC)
            val out = Frame.alloc(ow, oh, true)
            fun fillLine(x0: Int, y0: Int, lw: Int, lh: Int) { for (y in y0 until y0 + lh) for (x in x0 until x0 + lw) { if (x < 0 || y < 0 || x >= ow || y >= oh) continue; val k = (y * ow + x) * 4; out.d[k] = lc[0].toFloat(); out.d[k + 1] = lc[1].toFloat(); out.d[k + 2] = lc[2].toFloat() } }
            val first = if (p.bool("originalFirst")) of else proc; val second = if (p.bool("originalFirst")) proc else of
            when (mode) {
                "sbs_h" -> { putRows(out, first, 0, 0); putRows(out, second, w + lt, 0); fillLine(w, 0, lt, h) }
                "sbs_v" -> { putRows(out, first, 0, 0); putRows(out, second, 0, h + lt); fillLine(0, h, w, lt) }
                "blend" -> for (k in out.d.indices) out.d[k] = if (k and 3 == 3) 255f else (of.d[k] * (1 - balance) + proc.d[k] * balance).toFloat()
                "difference" -> for (k in out.d.indices) out.d[k] = if (k and 3 == 3) 255f else (abs(proc.d[k] - of.d[k]) * gain).toFloat()
                "wipe_h", "wipe_v" -> {
                    val sp = if (mode == "wipe_h") jsRound(balance * w) else jsRound(balance * h)
                    for (y in 0 until h) for (x in 0 until w) { val k = (y * w + x) * 4; val s = if ((if (mode == "wipe_h") x else y) < sp) first else second; out.d[k] = s.d[k]; out.d[k + 1] = s.d[k + 1]; out.d[k + 2] = s.d[k + 2] }
                    if (lt > 0) { if (mode == "wipe_h") fillLine(sp - (lt shr 1), 0, lt, h) else fillLine(0, sp - (lt shr 1), w, lt) }
                }
            }
            return out
        }
    }
}

private val ela: FilterImpl = { input, p, _ ->
    mapStream(input) { f, _ ->
        val q = jpegRoundTrip(f, p.int("quality"), p.str("chroma") != "444").d; val scale = p.num("scale")
        mapPixels(f) { r, g, b, o, i ->
            o[i] = (abs(min(255.0, max(0.0, jsRoundD(r))) - q[i]) * scale).toFloat()
            o[i + 1] = (abs(min(255.0, max(0.0, jsRoundD(g))) - q[i + 1]) * scale).toFloat()
            o[i + 2] = (abs(min(255.0, max(0.0, jsRoundD(b))) - q[i + 2]) * scale).toFloat()
        }
    }
}

// ---------------------------------------------------------------- edit
private val crop: FilterImpl = { input, p, _ ->
    val src = needInput(input)
    val r = p.rect("rect")
    if (r == null || r.w < 1 || r.h < 1) src else {
        val x = max(0, min(src.info.width - 1, jsRound(r.x))); val y = max(0, min(src.info.height - 1, jsRound(r.y)))
        val w = max(1, min(src.info.width - x, jsRound(r.w))); val h = max(1, min(src.info.height - y, jsRound(r.h)))
        mapStream(src, src.info.copy(width = w, height = h)) { f, _ -> cropFrame(f, x.toDouble(), y.toDouble(), w.toDouble(), h.toDouble()) }
    }
}

private val resizeF: FilterImpl = { input, p, _ ->
    val src = needInput(input)
    var nw: Int; var nh: Int
    if (p.str("mode") == "size") { nw = p.int("width"); nh = if (p.bool("keepAspect")) jsRound(p.num("width") * src.info.height / src.info.width) else p.int("height") }
    else { nw = jsRound(src.info.width * p.num("scale") / 100); nh = jsRound(src.info.height * p.num("scale") / 100) }
    nw = max(1, min(16384, nw)); nh = max(1, min(16384, nh))
    val interp = Interp.of(p.str("interp"))
    mapStream(src, src.info.copy(width = nw, height = nh)) { f, _ -> resize(f, nw, nh, interp) }
}

/** Exact rotation by a multiple of 90° (pixels moved, nothing interpolated): out(x, y) = in(map(x, y)). */
private fun quarterTurn(f: Frame, turns: Int): Frame {
    val w = f.w; val h = f.h
    val ow = if (turns % 2 != 0) h else w; val oh = if (turns % 2 != 0) w else h
    val out = Frame.alloc(ow, oh, false)
    Par.forRows(oh) { y0, y1 -> for (y in y0 until y1) for (x in 0 until ow) {
        val sx: Int; val sy: Int
        when (turns) { 1 -> { sx = y; sy = h - 1 - x }; 3 -> { sx = w - 1 - y; sy = x }; else -> { sx = w - 1 - x; sy = h - 1 - y } }
        System.arraycopy(f.d, (sy * w + sx) * 4, out.d, (y * ow + x) * 4, 4)
    } }
    return out
}

private val rotate: FilterImpl = { input, p, _ ->
    val src = needInput(input)
    val deg = ((p.num("angle") % 360) + 360) % 360
    val turns = if (deg % 90.0 == 0.0) (deg / 90).toInt() else -1
    // multiples of 90° (e.g. the rotation metadata of phone videos): lossless, and the canvas is exactly w×h or h×w
    if (turns == 0) src
    else if (turns == 2 || (turns > 0 && p.bool("expand"))) {
        val sw = if (turns % 2 != 0) src.info.height else src.info.width; val sh = if (turns % 2 != 0) src.info.width else src.info.height
        mapStream(src, src.info.copy(width = sw, height = sh)) { f, _ -> quarterTurn(f, turns) }
    } else rotateWarp(src, p)
}

private fun rotateWarp(src: Stream, p: Params): Stream {
    val a = p.num("angle") * PI / 180; val c = cos(a); val s = sin(a)
    val w = src.info.width; val h = src.info.height
    val ow = if (p.bool("expand")) ceil(abs(w * c) + abs(h * s)).toInt() else w; val oh = if (p.bool("expand")) ceil(abs(w * s) + abs(h * c)).toInt() else h
    val bg = parseColor(p.str("background")); val interp = Interp.of(p.str("interp"))
    return mapStream(src, src.info.copy(width = ow, height = oh)) { f, _ ->
        warp(f, ow, oh, interp, bg) { x, y, q -> val dx = x - ow / 2.0 + 0.5; val dy = y - oh / 2.0 + 0.5; q[0] = c * dx + s * dy + w / 2.0 - 0.5; q[1] = -s * dx + c * dy + h / 2.0 - 0.5 }
    }
}

private val flip: FilterImpl = { input, p, _ ->
    val hz = p.bool("horizontal"); val vt = p.bool("vertical")
    mapStream(input) { f, _ ->
        val out = Frame.alloc(f.w, f.h, false)
        Par.forRows(f.h) { y0, y1 -> for (y in y0 until y1) for (x in 0 until f.w) {
            val sx = if (hz) f.w - 1 - x else x; val sy = if (vt) f.h - 1 - y else y
            val s = (sy * f.w + sx) * 4; val o = (y * f.w + x) * 4
            out.d[o] = f.d[s]; out.d[o + 1] = f.d[s + 1]; out.d[o + 2] = f.d[s + 2]; out.d[o + 3] = f.d[s + 3]
        } }
        out
    }
}

private val perspective: FilterImpl = { input, p, _ ->
    val src = needInput(input)
    val pts = p.pts("points")
    if (pts.size < 4) src else {
        fun d(a: Pt, b: Pt) = hypot(a.x - b.x, a.y - b.y)
        val ow = if (p.int("outWidth") > 0) p.int("outWidth") else max(2, jsRound((d(pts[0], pts[1]) + d(pts[3], pts[2])) / 2))
        val oh = if (p.int("outHeight") > 0) p.int("outHeight") else max(2, jsRound((d(pts[0], pts[3]) + d(pts[1], pts[2])) / 2))
        val H = homography(listOf(Pt(0.0, 0.0), Pt(ow - 1.0, 0.0), Pt(ow - 1.0, oh - 1.0), Pt(0.0, oh - 1.0)), pts.take(4))
        val interp = Interp.of(p.str("interp"))
        mapStream(src, src.info.copy(width = ow, height = oh)) { f, _ ->
            warp(f, ow, oh, interp) { x, y, q -> val wq = H[6] * x + H[7] * y + H[8]; q[0] = (H[0] * x + H[1] * y + H[2]) / wq; q[1] = (H[3] * x + H[4] * y + H[5]) / wq }
        }
    }
}

private val lens: FilterImpl = { input, p, _ ->
    val k1 = p.num("k1"); val k2 = p.num("k2"); val zoom = p.num("zoom"); val interp = Interp.of(p.str("interp"))
    mapStream(input) { f, _ ->
        val cx = p.num("cx") * f.w; val cy = p.num("cy") * f.h; val R = hypot(f.w / 2.0, f.h / 2.0)
        warp(f, f.w, f.h, interp) { x, y, q ->
            val nx = (x - cx) / R / zoom; val ny = (y - cy) / R / zoom; val r2 = nx * nx + ny * ny
            val k = 1 + k1 * r2 + k2 * r2 * r2
            q[0] = cx + nx * k * R; q[1] = cy + ny * k * R
        }
    }
}

private val aspect: FilterImpl = { input, p, _ ->
    val src = needInput(input)
    val par = when (p.str("mode")) { "custom" -> p.num("par"); "pal" -> 12.0 / 11; "ntsc" -> 10.0 / 11; "half" -> 2.0; else -> src.info.par.let { if (it > 0) it else 1.0 } }
    val w = src.info.width; val h = src.info.height
    val nw = if (p.str("direction") == "width") max(1, jsRound(w * par)) else w
    val nh = if (p.str("direction") == "height") max(1, jsRound(h / par)) else h
    if (nw == w && nh == h) src else { val interp = Interp.of(p.str("interp")); mapStream(src, src.info.copy(width = nw, height = nh, par = 1.0)) { f, _ -> resize(f, nw, nh, interp) } }
}

// ---------------------------------------------------------------- deinterlacing (frame-wise)
fun deinterlaceFrame(f: Frame, keepTop: Boolean, method: String): Frame {
    val w = f.w; val h = f.h; val out = f.copy(); val d = f.d; val o = out.d; val row = w * 4
    val keep = if (keepTop) 0 else 1
    for (y in 0 until h) {
        if (y and 1 == keep) continue
        val up = if (y - 1 >= 0) y - 1 else y + 1; val dn = if (y + 1 < h) y + 1 else y - 1
        if (up < 0 || up >= h || dn < 0 || dn >= h) continue
        for (x in 0 until row) {
            if (x and 3 == 3) continue
            o[y * row + x] = when (method) {
                "duplicate" -> d[up * row + x]
                "blend" -> ((d[y * row + x] * 2.0 + d[up * row + x] + d[dn * row + x]) / 4).toFloat()
                else -> ((d[up * row + x].toDouble() + d[dn * row + x]) / 2).toFloat()
            }
        }
    }
    if (method == "blend") for (y in 0 until h) {
        if (y and 1 != keep) continue
        val up = max(0, y - 1); val dn = min(h - 1, y + 1)
        for (x in 0 until row) if (x and 3 != 3) o[y * row + x] = ((d[y * row + x] * 2.0 + d[up * row + x] + d[dn * row + x]) / 4).toFloat()
    }
    return out
}

private val lineDoubling: FilterImpl = { input, p, _ -> mapStream(input) { f, _ -> deinterlaceFrame(f, p.str("field") == "top", "duplicate") } }

private val fieldShift: FilterImpl = { input, p, _ ->
    val keep = if (p.str("field") == "top") 0 else 1; val dx = p.int("dx"); val dy = p.int("dy")
    mapStream(input) { f, _ ->
        val w = f.w; val h = f.h; val out = f.copy()
        var y = keep
        while (y < h) {
            val sy = y - 2 * dy
            for (x in 0 until w) {
                val sx = x - dx; val o = (y * w + x) * 4
                if (sx < 0 || sx >= w || sy < 0 || sy >= h) { out.d[o] = 0f; out.d[o + 1] = 0f; out.d[o + 2] = 0f; continue }
                val s = (sy * w + sx) * 4
                out.d[o] = f.d[s]; out.d[o + 1] = f.d[s + 1]; out.d[o + 2] = f.d[s + 2]
            }
            y += 2
        }
        out
    }
}

val basicFilters: Map<String, FilterImpl> = mapOf(
    "image_loader" to fileLoader, "video_loader" to fileLoader, "sequence_loader" to fileLoader, "test_pattern" to testPattern,
    "grayscale" to grayscale, "color_conversion" to colorConversion, "color_switch" to colorSwitch, "extract_channel" to extractChannel, "enable_channels" to enableChannels,
    "levels" to levels, "curves" to curves, "brightness_contrast" to brightnessContrast, "exposure" to exposure, "auto_contrast" to autoContrast, "histogram_equalization" to histEq,
    "white_balance" to whiteBalance, "hue_saturation" to hueSat, "negative" to negative, "threshold" to threshold,
    "fourier" to fourier, "fourier_filter" to fourierFilt, "gradient" to gradient, "bit_plane" to bitPlane,
    "unsharp_mask" to unsharp, "laplacian_sharpening" to laplacianSharp, "high_pass_sharpening" to highPass,
    "averaging_filter" to { input, p, _ -> mapStream(input) { f, _ -> boxBlur(f, p.int("radius")) } },
    "gaussian_filter" to { input, p, _ -> mapStream(input) { f, _ -> gaussianBlur(f, p.num("sigma")) } },
    "median_filter" to { input, p, _ -> mapStream(input) { f, _ -> medianFilter(f, p.int("radius")) } },
    "bilateral_filter" to { input, p, ctx -> mapStream(input) { f, _ -> bilateral(f, p.num("sigmaS"), p.num("sigmaR"), ctx::isStale) } },
    "nl_means" to { input, p, ctx -> mapStream(input) { f, _ -> nlMeans(f, p.num("h"), p.int("patch"), p.int("search"), ctx::isStale) } },
    "wiener_filter" to { input, p, _ -> mapStream(input) { f, _ -> wienerAdaptive(f, p.int("radius"), p.num("noise")) } },
    "deblocking" to { input, p, _ -> mapStream(input) { f, _ -> deblock(f, p.int("block"), p.num("strength"), p.num("threshold")) } },
    "motion_deblurring" to deblur, "optical_deblurring" to deblur, "gaussian_deblurring" to deblur, "nonlinear_deblurring" to deblur,
    "compare_original" to compareOriginal, "ela" to ela,
    "crop" to crop, "resize" to resizeF, "rotate" to rotate, "flip" to flip, "correct_perspective" to perspective, "lens_distortion" to lens, "aspect_ratio" to aspect,
    "line_doubling" to lineDoubling, "field_shift" to fieldShift,
)
