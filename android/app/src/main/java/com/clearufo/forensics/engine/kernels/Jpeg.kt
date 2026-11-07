package com.clearufo.forensics.engine.kernels

import com.clearufo.forensics.engine.Frame
import com.clearufo.forensics.engine.Par
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

// Deterministic JPEG compression model (baseline JPEG, IJG quantization tables) used by Error Level Analysis
// (port of kernels/jpeg.ts). The platform JPEG codec differs between devices, so ELA run through it would not be
// reproducible; this model uses only +, -, *, / and rounding with the DCT constants written out, so the result is
// identical on every device (and to the browser workbench).

private val M = doubleArrayOf(
    0.3535533905932738, 0.3535533905932738, 0.3535533905932738, 0.3535533905932738, 0.3535533905932738, 0.3535533905932738, 0.3535533905932738, 0.3535533905932738,
    0.4903926402016152, 0.4157348061512726, 0.2777851165098011, 0.09754516100806414, -0.09754516100806414, -0.2777851165098011, -0.4157348061512726, -0.4903926402016152,
    0.46193976625564337, 0.1913417161825449, -0.1913417161825449, -0.46193976625564337, -0.46193976625564337, -0.1913417161825449, 0.1913417161825449, 0.46193976625564337,
    0.4157348061512726, -0.09754516100806414, -0.4903926402016152, -0.2777851165098011, 0.2777851165098011, 0.4903926402016152, 0.09754516100806414, -0.4157348061512726,
    0.3535533905932738, -0.3535533905932738, -0.3535533905932738, 0.3535533905932738, 0.3535533905932738, -0.3535533905932738, -0.3535533905932738, 0.3535533905932738,
    0.2777851165098011, -0.4903926402016152, 0.09754516100806414, 0.4157348061512726, -0.4157348061512726, -0.09754516100806414, 0.4903926402016152, -0.2777851165098011,
    0.1913417161825449, -0.46193976625564337, 0.46193976625564337, -0.1913417161825449, -0.1913417161825449, 0.46193976625564337, -0.46193976625564337, 0.1913417161825449,
    0.09754516100806414, -0.2777851165098011, 0.4157348061512726, -0.4903926402016152, 0.4903926402016152, -0.4157348061512726, 0.2777851165098011, -0.09754516100806414,
)

private val LUMA = intArrayOf(
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
)
private val CHROMA = intArrayOf(
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
)

/** Quantization table for a quality 1–100, exactly as libjpeg's jpeg_set_quality (baseline: max 255). */
fun quantTable(base: IntArray, quality: Int): DoubleArray {
    val q = min(100, max(1, quality))
    val scale = if (q < 50) 5000 / q else 200 - q * 2
    return DoubleArray(64) { min(255, max(1, (base[it] * scale + 50) / 100)).toDouble() }
}

private fun clamp8(v: Double) = if (v < 0) 0.0 else if (v > 255) 255.0 else v
private fun roundHalfAway(v: Double) = if (v < 0) -floor(-v + 0.5) else floor(v + 0.5)
private fun jsr(v: Double) = floor(v + 0.5)

/** Compresses and decompresses one 8-bit plane (values 0–255) block by block with the given table. */
fun roundTripPlane(src: DoubleArray, w: Int, h: Int, Q: DoubleArray): DoubleArray {
    val out = DoubleArray(w * h)
    val rowsOfBlocks = (h + 7) / 8
    Par.forRows(rowsOfBlocks, grain = 1) { ba, bb ->
        val blk = DoubleArray(64); val tmp = DoubleArray(64); val co = DoubleArray(64)
        for (bi in ba until bb) {
            val by = bi * 8
            var bx = 0
            while (bx < w) {
                for (y in 0 until 8) { val sy = min(h - 1, by + y) * w; for (x in 0 until 8) blk[y * 8 + x] = src[sy + min(w - 1, bx + x)] - 128 }
                for (y in 0 until 8) for (u in 0 until 8) { var s = 0.0; for (x in 0 until 8) s += M[u * 8 + x] * blk[y * 8 + x]; tmp[y * 8 + u] = s }
                for (v in 0 until 8) for (u in 0 until 8) { var s = 0.0; for (y in 0 until 8) s += M[v * 8 + y] * tmp[y * 8 + u]; co[v * 8 + u] = s }
                for (k in 0 until 64) co[k] = roundHalfAway(co[k] / Q[k]) * Q[k]
                for (y in 0 until 8) for (u in 0 until 8) { var s = 0.0; for (v in 0 until 8) s += M[v * 8 + y] * co[v * 8 + u]; tmp[y * 8 + u] = s }
                var y = 0
                while (y < 8 && by + y < h) {
                    var x = 0
                    while (x < 8 && bx + x < w) {
                        var s = 0.0
                        for (u in 0 until 8) s += M[u * 8 + x] * tmp[y * 8 + u]
                        out[(by + y) * w + bx + x] = clamp8(jsr(s + 128))
                        x++
                    }
                    y++
                }
                bx += 8
            }
        }
    }
    return out
}

private class Sub(val d: DoubleArray, val w: Int, val h: Int)

/** 2x2 average (4:2:0) as libjpeg's h2v2_downsample: rounding bias alternating 1, 2; edges replicated. */
private fun downsample(p: DoubleArray, w: Int, h: Int): Sub {
    val cw = (w + 1) shr 1; val ch = (h + 1) shr 1
    val d = DoubleArray(cw * ch)
    for (y in 0 until ch) {
        var bias = 1
        for (x in 0 until cw) {
            val x0 = 2 * x; val y0 = 2 * y; val x1 = min(w - 1, x0 + 1); val y1 = min(h - 1, y0 + 1)
            d[y * cw + x] = ((p[y0 * w + x0] + p[y0 * w + x1] + p[y1 * w + x0] + p[y1 * w + x1] + bias).toInt() shr 2).toDouble()
            bias = bias xor 3
        }
    }
    return Sub(d, cw, ch)
}

/** libjpeg h2v2_fancy_upsample (triangle filter, integer arithmetic), cropped to w x h. */
private fun upsampleFancy(c: DoubleArray, cw: Int, ch: Int, w: Int, h: Int): DoubleArray {
    val out = DoubleArray(w * h)
    val row = DoubleArray(2 * cw)
    for (y in 0 until ch) {
        for (v in 0 until 2) {
            val oy = 2 * y + v
            if (oy >= h) break
            val near = y * cw; val far = min(ch - 1, max(0, if (v == 0) y - 1 else y + 1)) * cw
            fun col(x: Int) = (c[near + x] * 3 + c[far + x]).toInt()
            if (cw == 1) { val t = col(0); row[0] = ((t * 4 + 8) shr 4).toDouble(); row[1] = ((t * 4 + 7) shr 4).toDouble() }
            else {
                var last: Int; var cur = col(0); var next = col(1)
                row[0] = ((cur * 4 + 8) shr 4).toDouble(); row[1] = ((cur * 3 + next + 7) shr 4).toDouble()
                for (x in 1 until cw - 1) {
                    last = cur; cur = next; next = col(x + 1)
                    row[2 * x] = ((cur * 3 + last + 8) shr 4).toDouble(); row[2 * x + 1] = ((cur * 3 + next + 7) shr 4).toDouble()
                }
                last = cur; cur = next
                row[2 * (cw - 1)] = ((cur * 3 + last + 8) shr 4).toDouble(); row[2 * (cw - 1) + 1] = ((cur * 4 + 7) shr 4).toDouble()
            }
            for (x in 0 until w) out[oy * w + x] = row[x]
        }
    }
    return out
}

/** The frame after a JPEG compression at `quality` (1–100) and decompression, with 4:2:0 or 4:4:4 chroma. */
fun jpegRoundTrip(f: Frame, quality: Int, chroma420: Boolean): Frame {
    val w = f.w; val h = f.h; val d = f.d; val n = w * h
    val Y = DoubleArray(n); val Cb = DoubleArray(n); val Cr = DoubleArray(n)
    for (i in 0 until n) {
        val k = i * 4
        val r = clamp8(jsr(d[k].toDouble())); val g = clamp8(jsr(d[k + 1].toDouble())); val b = clamp8(jsr(d[k + 2].toDouble()))
        Y[i] = clamp8(jsr(0.299 * r + 0.587 * g + 0.114 * b))
        Cb[i] = clamp8(jsr(-0.168736 * r - 0.331264 * g + 0.5 * b + 128))
        Cr[i] = clamp8(jsr(0.5 * r - 0.418688 * g - 0.081312 * b + 128))
    }
    val ql = quantTable(LUMA, quality); val qc = quantTable(CHROMA, quality)
    val y2 = roundTripPlane(Y, w, h, ql)
    val cb2: DoubleArray; val cr2: DoubleArray
    if (chroma420) {
        val b = downsample(Cb, w, h); val r = downsample(Cr, w, h)
        cb2 = upsampleFancy(roundTripPlane(b.d, b.w, b.h, qc), b.w, b.h, w, h)
        cr2 = upsampleFancy(roundTripPlane(r.d, r.w, r.h, qc), r.w, r.h, w, h)
    } else {
        cb2 = roundTripPlane(Cb, w, h, qc); cr2 = roundTripPlane(Cr, w, h, qc)
    }
    val out = FloatArray(n * 4)
    for (i in 0 until n) {
        val k = i * 4
        val yy = y2[i]; val cb = cb2[i] - 128; val cr = cr2[i] - 128
        out[k] = clamp8(jsr(yy + 1.402 * cr)).toFloat()
        out[k + 1] = clamp8(jsr(yy - 0.344136 * cb - 0.714136 * cr)).toFloat()
        out[k + 2] = clamp8(jsr(yy + 1.772 * cb)).toFloat()
        out[k + 3] = 255f
    }
    return Frame(w, h, out)
}
