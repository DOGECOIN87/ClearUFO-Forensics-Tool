package com.clearufo.forensics.engine

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Frame representation used by the processing engine: RGBA interleaved, 32-bit float, nominal range 0..255.
 * Values are never clamped between filters, so no precision is lost along a chain; clamping happens only when
 * converting to 8-bit for display or export (the same convention as the browser workbench).
 */
class Frame(val w: Int, val h: Int, val d: FloatArray) {
    init { require(d.size == w * h * 4) { "frame buffer size mismatch" } }

    fun copy(): Frame = Frame(w, h, d.copyOf())
    val bytes: Long get() = d.size.toLong() * 4L

    companion object {
        fun alloc(w: Int, h: Int, fillAlpha: Boolean = true): Frame {
            val d = FloatArray(w * h * 4)
            if (fillAlpha) { var i = 3; while (i < d.size) { d[i] = 255f; i += 4 } }
            return Frame(w, h, d)
        }

        fun solid(w: Int, h: Int, r: Float, g: Float, b: Float, a: Float = 255f): Frame {
            val f = alloc(w, h, false)
            val d = f.d
            var i = 0
            while (i < d.size) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; i += 4 }
            return f
        }

        /** From packed ARGB ints (android.graphics.Bitmap.getPixels). */
        fun fromArgb(px: IntArray, w: Int, h: Int): Frame {
            val f = alloc(w, h, false)
            val d = f.d
            Par.forRows(h) { y0, y1 ->
                for (i in y0 * w until y1 * w) {
                    val c = px[i]
                    val k = i * 4
                    d[k] = ((c shr 16) and 255).toFloat(); d[k + 1] = ((c shr 8) and 255).toFloat()
                    d[k + 2] = (c and 255).toFloat(); d[k + 3] = ((c ushr 24) and 255).toFloat()
                }
            }
            return f
        }
    }
}

/** Uint8ClampedArray semantics: NaN → 0, clamp to 0..255, round half to even. */
fun to8(v: Float): Int {
    if (v.isNaN() || v <= 0f) return 0
    if (v >= 255f) return 255
    return Math.rint(v.toDouble()).toInt()
}

fun clamp255(v: Double): Double = if (v < 0) 0.0 else if (v > 255) 255.0 else v
fun clampi(v: Int, a: Int, b: Int): Int = if (v < a) a else if (v > b) b else v

/** Opaque ARGB pixels for display (alpha forced to 255, as the viewer shows the RGB samples). */
fun Frame.toArgb(out: IntArray? = null, keepAlpha: Boolean = false): IntArray {
    val n = w * h
    val o = if (out != null && out.size == n) out else IntArray(n)
    val src = d
    Par.forRows(h) { y0, y1 ->
        for (i in y0 * w until y1 * w) {
            val k = i * 4
            val a = if (keepAlpha) to8(src[k + 3]) else 255
            o[i] = (a shl 24) or (to8(src[k]) shl 16) or (to8(src[k + 1]) shl 8) or to8(src[k + 2])
        }
    }
    return o
}

/** BT.601 luma plane. */
fun luma(f: Frame): FloatArray {
    val n = f.w * f.h
    val out = FloatArray(n)
    val d = f.d
    for (i in 0 until n) { val j = i * 4; out[i] = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]).toFloat() }
    return out
}

/** Split into planar channels R, G, B, A. */
fun split(f: Frame): Array<FloatArray> {
    val n = f.w * f.h
    val r = FloatArray(n); val g = FloatArray(n); val b = FloatArray(n); val a = FloatArray(n)
    val d = f.d
    for (i in 0 until n) { val j = i * 4; r[i] = d[j]; g[i] = d[j + 1]; b[i] = d[j + 2]; a[i] = d[j + 3] }
    return arrayOf(r, g, b, a)
}

fun merge(w: Int, h: Int, r: FloatArray, g: FloatArray, b: FloatArray, a: FloatArray? = null): Frame {
    val n = w * h
    val d = FloatArray(n * 4)
    for (i in 0 until n) { val j = i * 4; d[j] = r[i]; d[j + 1] = g[i]; d[j + 2] = b[i]; d[j + 3] = a?.get(i) ?: 255f }
    return Frame(w, h, d)
}

fun grayFrame(w: Int, h: Int, plane: FloatArray): Frame {
    val n = w * h
    val d = FloatArray(n * 4)
    for (i in 0 until n) { val j = i * 4; val v = plane[i]; d[j] = v; d[j + 1] = v; d[j + 2] = v; d[j + 3] = 255f }
    return Frame(w, h, d)
}

/** Apply a per-plane function to R, G and B (in parallel), keeping alpha. */
fun mapRGB(f: Frame, fn: (FloatArray) -> FloatArray): Frame {
    val p = split(f)
    val out = arrayOfNulls<FloatArray>(3)
    Par.forEach(3) { c -> out[c] = fn(p[c]) }
    return merge(f.w, f.h, out[0]!!, out[1]!!, out[2]!!, p[3])
}

/** Copy a rectangular region (clipped coordinates replicate the edge). */
fun cropFrame(f: Frame, x0: Double, y0: Double, w0: Double, h0: Double): Frame {
    val x = jsRound(x0); val y = jsRound(y0)
    val w = max(1, jsRound(w0)); val h = max(1, jsRound(h0))
    val out = Frame.alloc(w, h, false)
    val sd = f.d; val od = out.d
    for (yy in 0 until h) {
        val sy = min(f.h - 1, max(0, y + yy))
        for (xx in 0 until w) {
            val sx = min(f.w - 1, max(0, x + xx))
            val si = (sy * f.w + sx) * 4; val oi = (yy * w + xx) * 4
            od[oi] = sd[si]; od[oi + 1] = sd[si + 1]; od[oi + 2] = sd[si + 2]; od[oi + 3] = sd[si + 3]
        }
    }
    return out
}

/** Copy whole rows of `src` into `dst` at (ox, oy) (no clipping: the caller guarantees the fit). */
fun putRows(dst: Frame, src: Frame, ox: Int, oy: Int) {
    for (y in 0 until src.h) System.arraycopy(src.d, y * src.w * 4, dst.d, ((y + oy) * dst.w + ox) * 4, src.w * 4)
}

/** JavaScript Math.round (half up toward +infinity). */
fun jsRound(v: Double): Int = Math.floor(v + 0.5).toInt()

fun parseColor(hex: String?): IntArray {
    var s = (hex ?: "#000").trim().removePrefix("#")
    if (s.length == 3) s = s.map { "$it$it" }.joinToString("")
    val n = s.take(6).toIntOrNull(16) ?: 0
    return intArrayOf((n shr 16) and 255, (n shr 8) and 255, n and 255)
}

/** android color int with alpha from "#rrggbb" and an opacity 0..1. */
fun colorInt(hex: String?, alpha: Double = 1.0): Int {
    val c = parseColor(hex)
    val a = (alpha.coerceIn(0.0, 1.0) * 255).roundToInt()
    return (a shl 24) or (c[0] shl 16) or (c[1] shl 8) or c[2]
}
