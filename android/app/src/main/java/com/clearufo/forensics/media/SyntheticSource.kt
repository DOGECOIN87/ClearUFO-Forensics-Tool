package com.clearufo.forensics.media

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import com.clearufo.forensics.engine.Frame
import com.clearufo.forensics.engine.FrameMeta
import com.clearufo.forensics.engine.Par
import com.clearufo.forensics.engine.Params
import com.clearufo.forensics.engine.int
import com.clearufo.forensics.engine.kernels.Interp
import com.clearufo.forensics.engine.kernels.linePsf
import com.clearufo.forensics.engine.kernels.resize
import com.clearufo.forensics.engine.num
import com.clearufo.forensics.engine.str
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

// Synthetic, deterministic test material (port of sources/synthetic.ts): degraded license plate (motion blur, noise,
// camera shake), color bars, resolution chart, zone plate, distorted grid and periodic noise. Text uses a built-in
// stroke font so the output does not depend on the fonts of the device.

private val G: Map<Char, List<List<Pair<Double, Double>>>> = run {
    fun p(vararg v: Double) = v.toList().chunked(2) { it[0] to it[1] }
    mapOf(
        '0' to listOf(p(1.0, 0.0, 3.0, 0.0, 4.0, 1.0, 4.0, 5.0, 3.0, 6.0, 1.0, 6.0, 0.0, 5.0, 0.0, 1.0, 1.0, 0.0)),
        '1' to listOf(p(1.0, 1.0, 2.0, 0.0, 2.0, 6.0), p(1.0, 6.0, 3.0, 6.0)),
        '2' to listOf(p(0.0, 1.0, 1.0, 0.0, 3.0, 0.0, 4.0, 1.0, 4.0, 2.0, 0.0, 6.0, 4.0, 6.0)),
        '3' to listOf(p(0.0, 0.0, 4.0, 0.0, 2.0, 2.5, 3.0, 2.5, 4.0, 3.5, 4.0, 5.0, 3.0, 6.0, 1.0, 6.0, 0.0, 5.0)),
        '4' to listOf(p(3.0, 6.0, 3.0, 0.0, 0.0, 4.0, 4.0, 4.0)),
        '5' to listOf(p(4.0, 0.0, 0.0, 0.0, 0.0, 2.5, 3.0, 2.5, 4.0, 3.5, 4.0, 5.0, 3.0, 6.0, 0.0, 6.0)),
        '6' to listOf(p(3.5, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 5.0, 1.0, 6.0, 3.0, 6.0, 4.0, 5.0, 4.0, 3.5, 3.0, 2.5, 0.0, 2.5)),
        '7' to listOf(p(0.0, 0.0, 4.0, 0.0, 1.5, 6.0)),
        '8' to listOf(p(1.0, 0.0, 3.0, 0.0, 4.0, 1.0, 4.0, 2.0, 3.0, 3.0, 1.0, 3.0, 0.0, 4.0, 0.0, 5.0, 1.0, 6.0, 3.0, 6.0, 4.0, 5.0, 4.0, 4.0, 3.0, 3.0, 1.0, 3.0, 0.0, 2.0, 0.0, 1.0, 1.0, 0.0)),
        '9' to listOf(p(4.0, 3.5, 1.0, 3.5, 0.0, 2.5, 0.0, 1.0, 1.0, 0.0, 3.0, 0.0, 4.0, 1.0, 4.0, 5.0, 3.0, 6.0, 0.5, 6.0)),
        'A' to listOf(p(0.0, 6.0, 2.0, 0.0, 4.0, 6.0), p(0.7, 4.0, 3.3, 4.0)),
        'B' to listOf(p(0.0, 0.0, 0.0, 6.0, 3.0, 6.0, 4.0, 5.0, 4.0, 4.0, 3.0, 3.0, 0.0, 3.0), p(0.0, 0.0, 3.0, 0.0, 4.0, 1.0, 4.0, 2.0, 3.0, 3.0)),
        'C' to listOf(p(4.0, 1.0, 3.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 5.0, 1.0, 6.0, 3.0, 6.0, 4.0, 5.0)),
        'D' to listOf(p(0.0, 0.0, 0.0, 6.0, 2.5, 6.0, 4.0, 4.5, 4.0, 1.5, 2.5, 0.0, 0.0, 0.0)),
        'E' to listOf(p(4.0, 0.0, 0.0, 0.0, 0.0, 6.0, 4.0, 6.0), p(0.0, 3.0, 3.0, 3.0)),
        'F' to listOf(p(4.0, 0.0, 0.0, 0.0, 0.0, 6.0), p(0.0, 3.0, 3.0, 3.0)),
        'G' to listOf(p(4.0, 1.0, 3.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 5.0, 1.0, 6.0, 3.0, 6.0, 4.0, 5.0, 4.0, 3.5, 2.5, 3.5)),
        'H' to listOf(p(0.0, 0.0, 0.0, 6.0), p(4.0, 0.0, 4.0, 6.0), p(0.0, 3.0, 4.0, 3.0)),
        'J' to listOf(p(4.0, 0.0, 4.0, 5.0, 3.0, 6.0, 1.0, 6.0, 0.0, 5.0)),
        'K' to listOf(p(0.0, 0.0, 0.0, 6.0), p(4.0, 0.0, 0.0, 3.5), p(1.3, 2.6, 4.0, 6.0)),
        'L' to listOf(p(0.0, 0.0, 0.0, 6.0, 4.0, 6.0)),
        'M' to listOf(p(0.0, 6.0, 0.0, 0.0, 2.0, 3.0, 4.0, 0.0, 4.0, 6.0)),
        'N' to listOf(p(0.0, 6.0, 0.0, 0.0, 4.0, 6.0, 4.0, 0.0)),
        'P' to listOf(p(0.0, 6.0, 0.0, 0.0, 3.0, 0.0, 4.0, 1.0, 4.0, 2.5, 3.0, 3.5, 0.0, 3.5)),
        'R' to listOf(p(0.0, 6.0, 0.0, 0.0, 3.0, 0.0, 4.0, 1.0, 4.0, 2.5, 3.0, 3.5, 0.0, 3.5), p(2.0, 3.5, 4.0, 6.0)),
        'S' to listOf(p(4.0, 1.0, 3.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 2.0, 1.0, 3.0, 3.0, 3.0, 4.0, 4.0, 4.0, 5.0, 3.0, 6.0, 1.0, 6.0, 0.0, 5.0)),
        'T' to listOf(p(0.0, 0.0, 4.0, 0.0), p(2.0, 0.0, 2.0, 6.0)),
        'U' to listOf(p(0.0, 0.0, 0.0, 5.0, 1.0, 6.0, 3.0, 6.0, 4.0, 5.0, 4.0, 0.0)),
        'V' to listOf(p(0.0, 0.0, 2.0, 6.0, 4.0, 0.0)),
        'W' to listOf(p(0.0, 0.0, 1.0, 6.0, 2.0, 2.5, 3.0, 6.0, 4.0, 0.0)),
        'X' to listOf(p(0.0, 0.0, 4.0, 6.0), p(4.0, 0.0, 0.0, 6.0)),
        'Y' to listOf(p(0.0, 0.0, 2.0, 3.0, 4.0, 0.0), p(2.0, 3.0, 2.0, 6.0)),
        'Z' to listOf(p(0.0, 0.0, 4.0, 0.0, 0.0, 6.0, 4.0, 6.0)),
        '-' to listOf(p(0.5, 3.0, 3.5, 3.0)),
        '.' to listOf(p(2.0, 5.8, 2.0, 6.0)),
        ':' to listOf(p(2.0, 1.8, 2.0, 2.0), p(2.0, 4.8, 2.0, 5.0)),
    )
}

fun strokeText(c: Canvas, paint: Paint, text: String, x: Double, y: Double, h: Double, weight: Double = 0.16, xs: Double = 0.72): Double {
    val s = h / 6
    val p = Paint(paint).apply { style = Paint.Style.STROKE; strokeWidth = max(1.0, h * weight).toFloat(); strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    var cx = x
    for (ch in text.uppercase()) {
        G[ch]?.forEach { poly ->
            val path = Path()
            poly.forEachIndexed { i, (px, py) -> val X = (cx + px * s * xs).toFloat(); val Y = (y + py * s).toFloat(); if (i == 0) path.moveTo(X, Y) else path.lineTo(X, Y) }
            c.drawPath(path, p)
        }
        cx += s * (4 * xs + 1.25)
    }
    return cx - x
}

fun strokeTextWidth(text: String, h: Double, xs: Double = 0.72) = text.length * (h / 6) * (4 * xs + 1.25) - (h / 6) * 1.25

/** Small deterministic PRNG (mulberry32), identical to the browser version. */
fun rng(seed: Int): () -> Double {
    var a = seed
    return {
        a += 0x6d2b79f5
        var t = (a xor (a ushr 15)) * (1 or a)
        t = (t + ((t xor (t ushr 7)) * (61 or t))) xor t
        ((t xor (t ushr 14)).toLong() and 0xffffffffL) / 4294967296.0
    }
}

private fun plateText(seed: Int): String {
    val r = rng(seed * 7919 + 13)
    val L = "ABCDEFGHJKLMNPRSTUVWXYZ"; val D = "0123456789"
    fun pick(s: String) = s[floor(r() * s.length).toInt()]
    return "${pick(L)}${pick(L)}${pick(L)}-${pick(D)}${pick(D)}${pick(D)}${pick(D)}"
}

private fun rgb(c: String): Int = android.graphics.Color.parseColor(c)

private fun drawScene(pattern: String, W: Int, H: Int, seed: Int): Frame {
    val S = 2
    val bmp = Bitmap.createBitmap(W * S, H * S, Bitmap.Config.ARGB_8888)
    val c = Canvas(bmp)
    c.scale(S.toFloat(), S.toFloat())
    val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    fun rect(col: Int, x: Double, y: Double, w: Double, h: Double) { fill.color = col; c.drawRect(x.toFloat(), y.toFloat(), (x + w).toFloat(), (y + h).toFloat(), fill) }
    val r = rng(seed)
    when (pattern) {
        "bars" -> {
            listOf("#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0").forEachIndexed { i, col -> rect(rgb(col), i * W / 7.0, 0.0, W / 7.0 + 1, H * 0.67) }
            listOf("#0000c0", "#131313", "#c000c0", "#131313", "#00c0c0", "#131313", "#c0c0c0").forEachIndexed { i, col -> rect(rgb(col), i * W / 7.0, H * 0.67, W / 7.0 + 1, H * 0.08) }
            for (x in 0 until W) { val v = (x.toDouble() / (W - 1) * 255).roundToInt(); rect(android.graphics.Color.rgb(v, v, v), x.toDouble(), H * 0.75, 1.0, H * 0.25) }
        }
        "zone" -> {
            val k = PI / max(W, H)
            val px = IntArray(W * H)
            for (y in 0 until H) for (x in 0 until W) { val dx = x - W / 2.0; val dy = y - H / 2.0; val v = (127.5 + 127.5 * cos(k * (dx * dx + dy * dy))).toInt().coerceIn(0, 255); px[y * W + x] = android.graphics.Color.rgb(v, v, v) }
            val z = Bitmap.createBitmap(px, W, H, Bitmap.Config.ARGB_8888)
            c.drawBitmap(z, 0f, 0f, null); z.recycle()
        }
        "chart" -> {
            rect(rgb("#f2f2f2"), 0.0, 0.0, W.toDouble(), H.toDouble())
            fill.color = rgb("#111111")
            val cx = W * 0.27; val cy = H * 0.5; val R = min(W, H) * 0.38
            for (i in 0 until 36) {
                val a0 = i / 36.0 * 360; val sweep = 0.5 / 36 * 360
                c.drawArc(RectF((cx - R).toFloat(), (cy - R).toFloat(), (cx + R).toFloat(), (cy + R).toFloat()), a0.toFloat(), sweep.toFloat(), true, fill)
            }
            var x = W * 0.56
            for (lp in 1..8) {
                val bw = max(0.5, 6.0 / lp)
                for (k in 0 until 5) rect(rgb("#111111"), x + k * bw * 2, H * 0.12, bw, H * 0.3)
                for (k in 0 until 5) rect(rgb("#111111"), x, H * 0.55 + k * bw * 2, bw * 10, bw)
                x += bw * 10 + 8
            }
            for (i in 0 until 11) { val v = (i / 10.0 * 255).roundToInt(); rect(android.graphics.Color.rgb(v, v, v), W * 0.56 + i * (W * 0.4 / 11), H * 0.85, W * 0.4 / 11, H * 0.1) }
            strokeText(c, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = rgb("#111111") }, "LUCID 2026", W * 0.56, H * 0.46, H * 0.05, 0.12)
        }
        "grid" -> {
            rect(rgb("#ffffff"), 0.0, 0.0, W.toDouble(), H.toDouble())
            val n = 12; val cell = min(W, H) / 8.0
            for (gy in -n until n) for (gx in -n until n) if (((gx + gy) and 1) != 0) rect(rgb("#000000"), W / 2.0 + gx * cell, H / 2.0 + gy * cell, cell, cell)
        }
        else -> {
            fill.shader = LinearGradient(0f, 0f, 0f, H.toFloat(), rgb("#3d4148"), rgb("#1e2024"), Shader.TileMode.CLAMP)
            c.drawRect(0f, 0f, W.toFloat(), H.toFloat(), fill); fill.shader = null
            for (i in 0 until 900) { val v = (40 + r() * 40).toInt(); fill.color = android.graphics.Color.argb(89, v, v, v + 5); val x0 = r() * W; val y0 = r() * H; val ww = 1 + r() * 2; val hh = 1 + r() * 2; c.drawRect(x0.toFloat(), y0.toFloat(), (x0 + ww).toFloat(), (y0 + hh).toFloat(), fill) }
            val bw = W * 0.8; val bh = H * 0.62; val bx = (W - bw) / 2; val by = H * 0.2
            fill.color = rgb("#6b1418"); c.drawRoundRect(RectF(bx.toFloat(), by.toFloat(), (bx + bw).toFloat(), (by + bh).toFloat()), (H * 0.06).toFloat(), (H * 0.06).toFloat(), fill)
            rect(rgb("#4b0e11"), bx, by + bh * 0.72, bw, bh * 0.28)
            rect(rgb("#ff3b2f"), bx + bw * 0.04, by + bh * 0.18, bw * 0.16, bh * 0.16); rect(rgb("#ff3b2f"), bx + bw * 0.8, by + bh * 0.18, bw * 0.16, bh * 0.16)
            rect(rgb("#ffd0a0"), bx + bw * 0.06, by + bh * 0.21, bw * 0.05, bh * 0.08); rect(rgb("#ffd0a0"), bx + bw * 0.89, by + bh * 0.21, bw * 0.05, bh * 0.08)
            val pw = bw * 0.42; val ph = pw / 2.0; val px = (W - pw) / 2; val py = by + bh * 0.3
            fill.color = rgb("#e9e6dc"); c.drawRoundRect(RectF(px.toFloat(), py.toFloat(), (px + pw).toFloat(), (py + ph).toFloat()), (ph * 0.08).toFloat(), (ph * 0.08).toFloat(), fill)
            val st = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = rgb("#1c2a5a"); strokeWidth = max(1.0, ph * 0.04).toFloat() }
            c.drawRoundRect(RectF((px + ph * 0.05).toFloat(), (py + ph * 0.05).toFloat(), (px + pw - ph * 0.05).toFloat(), (py + ph - ph * 0.05).toFloat()), (ph * 0.06).toFloat(), (ph * 0.06).toFloat(), st)
            strokeText(c, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = rgb("#1c2a5a") }, "TEXAS", px + pw / 2 - strokeTextWidth("TEXAS", ph * 0.14) / 2, py + ph * 0.1, ph * 0.14, 0.14)
            val t = plateText(seed)
            val th = min(ph * 0.5, pw * 0.86 / (strokeTextWidth(t, 6.0) / 6))
            strokeText(c, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = rgb("#141414") }, t, px + pw / 2 - strokeTextWidth(t, th) / 2, py + ph * 0.32 + (ph * 0.5 - th) / 2, th, 0.14)
            fill.color = rgb("#777777")
            for (sx in listOf(0.18, 0.82)) c.drawCircle((px + pw * sx).toFloat(), (py + ph * 0.18).toFloat(), (ph * 0.03).toFloat(), fill)
        }
    }
    val big = StillDecoder.bitmapToFrame(bmp)
    bmp.recycle()
    return resize(big, W, H, Interp.BILINEAR)
}

private fun warpBarrel(f: Frame, k1: Double): Frame {
    val w = f.w; val h = f.h; val out = FloatArray(f.d.size)
    val cx = w / 2.0; val cy = h / 2.0; val R = hypot(cx, cy)
    for (y in 0 until h) for (x in 0 until w) {
        val nx = (x - cx) / R; val ny = (y - cy) / R; val r2 = nx * nx + ny * ny; val s = 1 + k1 * r2
        val sx = min(w - 1.0, max(0.0, cx + nx * s * R)); val sy = min(h - 1.0, max(0.0, cy + ny * s * R))
        val x0 = floor(sx).toInt(); val y0 = floor(sy).toInt(); val x1 = min(w - 1, x0 + 1); val y1 = min(h - 1, y0 + 1); val fx = sx - x0; val fy = sy - y0
        val o = (y * w + x) * 4
        for (ch in 0 until 3) {
            val a = f.d[(y0 * w + x0) * 4 + ch]; val b = f.d[(y0 * w + x1) * 4 + ch]; val cc = f.d[(y1 * w + x0) * 4 + ch]; val d = f.d[(y1 * w + x1) * 4 + ch]
            out[o + ch] = ((a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy).toFloat()
        }
        out[o + 3] = 255f
    }
    return Frame(w, h, out)
}

class SyntheticSource(id: String, private val p: Params) : SourceProvider {
    private val names = mapOf("plate" to "License Plate (degraded)", "bars" to "Color Bars", "chart" to "Resolution Chart", "zone" to "Zone Plate", "grid" to "Calibration Grid", "periodic" to "Periodic Noise")
    private val pattern = p.str("pattern", "plate")
    private val W = max(64, min(3840, p.int("width", 640))); private val H = max(64, min(2160, p.int("height", 360)))
    private val n = max(1, min(10000, p.int("frames", 60)))
    private val fps = p.num("fps", 25.0).let { if (it > 0) it else 25.0 }
    private val seed = p.int("seed", 7)
    override val info = SourceInfo(id, "synthetic", "Test Pattern — ${names[pattern] ?: pattern}", 0, 0, null, W, H, n, fps, n / fps,
        container = "Synthetic", codec = "Generated", engine = "Built-in generator")
    private val base: Frame
    private val shake = ArrayList<Pair<Double, Double>>()

    init {
        var b = drawScene(if (pattern == "periodic") "plate" else pattern, W, H, seed)
        if (pattern == "grid") b = warpBarrel(b, -0.22)
        base = b
        val r = rng(seed + 101)
        val ph = DoubleArray(4) { r() * 6.28 }
        val sh = p.num("shake")
        for (i in 0 until n) shake.add(sh * (0.6 * sin(i * 0.37 + ph[0]) + 0.4 * sin(i * 1.13 + ph[1])) to sh * (0.6 * sin(i * 0.29 + ph[2]) + 0.4 * sin(i * 0.91 + ph[3])))
        info.metadata.addAll(listOf("Generator" to (names[pattern] ?: pattern), "Motion Blur" to "${p.str("blur")} px at ${p.str("blurAngle")}°", "Noise (sigma)" to p.str("noise"), "Camera Shake" to "${p.str("shake")} px", "Seed" to seed.toString()))
        if (pattern == "plate" || pattern == "periodic") info.metadata.add("Ground Truth Plate" to plateText(seed))
    }

    override suspend fun getFrame(i0: Int, opts: DecodeOptions): Frame {
        val i = max(0, min(n - 1, i0))
        val w = base.w; val h = base.h
        val (shx, shy) = shake[i]
        val src = base.d
        val shifted = FloatArray(src.size)
        Par.forRows(h) { ya, yb ->
            for (y in ya until yb) for (x in 0 until w) {
                val sx = min(w - 1.0, max(0.0, x - shx)); val sy = min(h - 1.0, max(0.0, y - shy))
                val x0 = floor(sx).toInt(); val y0 = floor(sy).toInt(); val x1 = min(w - 1, x0 + 1); val y1 = min(h - 1, y0 + 1); val fx = sx - x0; val fy = sy - y0
                val o = (y * w + x) * 4
                for (c in 0 until 3) shifted[o + c] = ((src[(y0 * w + x0) * 4 + c] * (1 - fx) + src[(y0 * w + x1) * 4 + c] * fx) * (1 - fy) + (src[(y1 * w + x0) * 4 + c] * (1 - fx) + src[(y1 * w + x1) * 4 + c] * fx) * fy).toFloat()
            }
        }
        var blurred = shifted
        val blur = p.num("blur")
        if (blur >= 1) {
            val psf = linePsf(blur, p.num("blurAngle"))
            val tx = ArrayList<Int>(); val ty = ArrayList<Int>(); val tv = ArrayList<Double>()
            for (ky in 0 until psf.h) for (kx in 0 until psf.w) { val v = psf.d[ky * psf.w + kx]; if (v > 1e-5) { tx.add(kx - (psf.w shr 1)); ty.add(ky - (psf.h shr 1)); tv.add(v.toDouble()) } }
            val out = FloatArray(src.size)
            Par.forRows(h) { ya, yb ->
                for (y in ya until yb) for (x in 0 until w) {
                    var r = 0.0; var g = 0.0; var b = 0.0
                    for (t in tv.indices) {
                        val v = tv[t]
                        val k = (min(h - 1, max(0, y - ty[t])) * w + min(w - 1, max(0, x - tx[t]))) * 4
                        r += shifted[k] * v; g += shifted[k + 1] * v; b += shifted[k + 2] * v
                    }
                    val o = (y * w + x) * 4
                    out[o] = r.toFloat(); out[o + 1] = g.toFloat(); out[o + 2] = b.toFloat()
                }
            }
            blurred = out
        }
        val rand = rng(seed * 1000003 + i * 7919 + 1)
        val sigma = p.num("noise")
        val periodic = pattern == "periodic"
        val out = FloatArray(src.size)
        var k = 0; var px = 0
        while (k < out.size) {
            val x = px % w; val y = px / w
            val per = if (periodic) 28 * sin(x * 0.9 + y * 0.35) + 18 * sin(x * 0.21 - y * 0.77) else 0.0
            for (c in 0 until 3) {
                var nz = 0.0
                if (sigma > 0) { val u1 = max(1e-9, rand()); val u2 = rand(); nz = sigma * sqrt(-2 * ln(u1)) * cos(6.283185307 * u2) }
                out[k + c] = Math.floor(min(255.0, max(0.0, blurred[k + c] + nz + per)) + 0.5).toFloat()
            }
            out[k + 3] = 255f
            k += 4; px++
        }
        return Frame(w, h, out)
    }

    override fun meta(i: Int) = FrameMeta('I', i / info.fps, true, 0, i)
}
