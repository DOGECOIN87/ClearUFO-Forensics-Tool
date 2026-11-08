package com.clearufo.forensics

import com.clearufo.forensics.engine.Frame
import com.clearufo.forensics.engine.Pt
import com.clearufo.forensics.engine.filters.smoothFrame
import com.clearufo.forensics.engine.kernels.*
import com.clearufo.forensics.engine.luma
import com.clearufo.forensics.media.Yuv
import com.clearufo.forensics.media.rng
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

/**
 * The Android engine against the browser workbench: every vector in resources/conformance was produced by the
 * TypeScript kernels of src/engine (android/conformance/generate.ts) on the same deterministic input. Results must
 * agree to within floating point noise (transcendental functions may differ in the last bit between V8 and the JVM).
 */
class ConformanceTest {
    private val dir = File(javaClass.classLoader!!.getResource("conformance/manifest.json")!!.toURI()).parentFile!!
    private val report = StringBuilder()

    private fun load(name: String): FloatArray {
        val b = File(dir, "$name.f32").readBytes()
        val fb = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
        return FloatArray(fb.remaining()).also { fb.get(it) }
    }

    private fun check(name: String, actual: FloatArray, tol: Double) {
        val exp = load(name)
        assertEquals("$name: size", exp.size, actual.size)
        var mx = 0.0; var at = -1
        for (i in exp.indices) { val d = abs(exp[i].toDouble() - actual[i]); if (d > mx || d.isNaN()) { mx = d; at = i } }
        report.append("%-32s max |Δ| = %.3g%n".format(name, mx))
        assertTrue("$name: max difference $mx at $at (expected ${exp.getOrNull(at)}, got ${actual.getOrNull(at)}) exceeds $tol", mx <= tol)
    }
    private fun check(name: String, f: Frame, tol: Double = 1e-3) = check(name, f.d, tol)

    /** Same generator as generate.ts (mulberry32, Math.fround). */
    private fun input(w: Int, h: Int, seed: Int, dx: Double = 0.0, dy: Double = 0.0): Frame {
        val r = rng(seed); val d = FloatArray(w * h * 4)
        for (y in 0 until h) for (x in 0 until w) {
            val X = x - dx; val Y = y - dy; val k = (y * w + x) * 4
            val disk = if (hypot(X - w * 0.6, Y - h * 0.45) < h * 0.22) 120 else 0
            val edge = if (X > w * 0.3) 40 else 0
            d[k] = (30 + X / w * 150 + disk + r() * 12).toFloat()
            d[k + 1] = (20 + Y / h * 170 + edge + r() * 12).toFloat()
            d[k + 2] = (60 + (X + Y) / (w + h) * 120 + (if (disk != 0) 40 else 0) + r() * 12 - 4).toFloat()
            d[k + 3] = 255f
        }
        return Frame(w, h, d)
    }

    private val W = 61; private val H = 47

    @Test fun engineMatchesBrowserWorkbench() = runBlocking { try { body() } finally { println(report) } }

    private suspend fun body() {
        val f = input(W, H, 7)
        check("input", f, 0.0)
        // spatial
        check("gauss_1_3", gaussianBlur(f, 1.3))
        check("gauss_4_2", gaussianBlur(f, 4.2))
        check("box_2", boxBlur(f, 2))
        check("median_1", medianFilter(f, 1), 0.0)
        check("median_3", medianFilter(f, 3), 0.0)
        check("bilateral", bilateral(f, 2.0, 20.0))
        check("nlmeans", nlMeans(f, 10.0, 1, 3), 2e-3)
        check("wiener", wienerAdaptive(f, 2, 0.0), 2e-3)
        check("deblock", deblock(f, 8, 0.6, 24.0))
        // geometry
        check("resize_up_bicubic", resize(f, 97, 73, Interp.BICUBIC))
        check("resize_down_lanczos", resize(f, 29, 22, Interp.LANCZOS))
        check("resize_up_bilinear", resize(f, 80, 60, Interp.BILINEAR))
        run {
            val a = 17 * Math.PI / 180; val c = cos(a); val s = sin(a)
            val ow = ceil(abs(W * c) + abs(H * s)).toInt(); val oh = ceil(abs(W * s) + abs(H * c)).toInt()
            check("rotate_17", warp(f, ow, oh, Interp.BICUBIC, intArrayOf(0, 0, 0)) { x, y, q -> val dx = x - ow / 2.0 + 0.5; val dy = y - oh / 2.0 + 0.5; q[0] = c * dx + s * dy + W / 2.0 - 0.5; q[1] = -s * dx + c * dy + H / 2.0 - 0.5 })
        }
        run {
            val pts = listOf(Pt(5.0, 4.0), Pt(55.0, 9.0), Pt(50.0, 42.0), Pt(8.0, 38.0))
            val m = homography(listOf(Pt(0.0, 0.0), Pt(39.0, 0.0), Pt(39.0, 29.0), Pt(0.0, 29.0)), pts)
            check("perspective", warp(f, 40, 30, Interp.BILINEAR) { x, y, q -> val wq = m[6] * x + m[7] * y + m[8]; q[0] = (m[0] * x + m[1] * y + m[2]) / wq; q[1] = (m[3] * x + m[4] * y + m[5]) / wq })
        }
        check("translate", translate(f, 2.37, -1.61, true))
        // tone
        check("clahe", clahe(luma(f), W, H, 4, 3.0), 1e-3)
        val lv = levelsLut(10.0, 240.0, 1.4, 5.0, 250.0); check("levels", applyLuts(f, lv, lv, lv))
        val cv = Lut(curveFunction(listOf(Pt(0.0, 0.0), Pt(64.0, 40.0), Pt(180.0, 220.0), Pt(255.0, 255.0)))); check("curves", applyLuts(f, cv, null, cv))
        val bc = brightnessContrastLut(12.0, 35.0); check("brightness_contrast", applyLuts(f, bc, bc, bc))
        val ex = exposureLut(0.7, 1.8, -6.0); check("exposure", applyLuts(f, ex, ex, ex))
        // frequency domain
        check("deconv_wiener_line", deconvolve(f, linePsf(7.0, 20.0), DeconvMethod.WIENER, 0.01, 1), 2e-3)
        check("deconv_tikhonov_gauss", deconvolve(f, gaussianPsf(1.5), DeconvMethod.TIKHONOV, 0.02, 1), 2e-3)
        check("deconv_rl_disk", deconvolve(f, diskPsf(2.5), DeconvMethod.RL, 0.01, 6), 2e-3)
        check("deconv_wiener_path", deconvolve(f, pathPsf(listOf(Pt(0.0, 0.0), Pt(6.0, 2.0), Pt(9.0, 7.0)), 2.0), DeconvMethod.WIENER, 0.02, 1), 2e-3)
        check("fourier_notch", fourierFilter(f, "notch", listOf(Pt(20.0, 15.0), Pt(40.0, 9.0)), 4.0, true, 0.1, true), 2e-3)
        check("fourier_lowpass", fourierFilter(f, "lowpass", emptyList(), 8.0, true, 0.12, false), 2e-3)
        check("spectrum_log", spectrum(luma(f), W, H, false, true), 2e-3)
        check("spectrum_phase", spectrum(luma(f), W, H, true, false), 2e-3)
        run {
            val g = input(W, H, 7, 3.4, -2.2)
            val s = phaseCorrelate(hannWindowed(luma(f), W, H, 0, 0, 64, 64), hannWindowed(luma(g), W, H, 0, 0, 64, 64), 64, 64)
            check("phase_correlate", floatArrayOf(s.dx.toFloat(), s.dy.toFloat(), s.peak.toFloat()), 1e-4)
        }
        // ELA model: bit exact
        check("jpeg_q90_420", jpegRoundTrip(f, 90, true), 0.0)
        check("jpeg_q75_444", jpegRoundTrip(f, 75, false), 0.0)
        // temporal smoothing
        val frames = (0..6).map { k -> input(W, H, 100 + k, if (k == 3) 6.0 else 0.0, 0.0) }
        val get: suspend (Int) -> Frame = { frames[it] }
        check("smooth_mean_protect", smoothFrame(get, 3, 7, 5, "mean", true, 12.0, false) { false })
        check("smooth_gauss", smoothFrame(get, 3, 7, 7, "gaussian", false, 12.0, false) { false })
        check("smooth_median_protect", smoothFrame(get, 3, 7, 5, "median", true, 8.0, false) { false })
        check("smooth_mean_mask", smoothFrame(get, 3, 7, 5, "mean", true, 6.0, true) { false })
        // YUV → RGB
        run {
            val w = 33; val h = 21; val cw = (w + 1) / 2; val ch = (h + 1) / 2
            val buf = load("yuv_planes")
            fun plane(off: Int, n: Int) = ShortArray(n) { buf[off + it].toInt().toShort() }
            val p = Yuv.Planes(w, h, plane(0, w * h), plane(w * h, cw * ch), plane(w * h + cw * ch, cw * ch), cw, ch, 1, 1, 8)
            check("yuv_709_limited_bicubic_left", Yuv.toFrame(p, "bt709", false, "bicubic", "left"))
            check("yuv_601_full_bilinear_center", Yuv.toFrame(p, "bt601", true, "bilinear", "center"))
            check("yuv_2020_limited_nearest", Yuv.toFrame(p, "bt2020", false, "nearest", "left"))
        }
    }

    /** Super Resolution as a whole filter (registration, splatting, blend with the bicubic base). */
    private fun superRes(frames: List<Frame>, vararg p: Pair<String, Any?>): Frame = runBlocking {
        val W = frames[0].w; val H = frames[0].h
        val s = object : com.clearufo.forensics.engine.Stream {
            override val info = com.clearufo.forensics.engine.StreamInfo(W, H, frames.size, 25.0)
            override suspend fun getFrame(i: Int) = frames[i]
            override fun meta(i: Int) = com.clearufo.forensics.engine.FrameMeta('P', i / 25.0, i == 0, 0, i)
        }
        val ctx = object : com.clearufo.forensics.engine.filters.BuildCtx {
            override val chainId = "c"; override val filterId = "f"; override val key = "k"
            override fun source(id: String) = throw IllegalStateException()
            override suspend fun chainStream(id: String) = throw IllegalStateException()
            override fun chainName(id: String) = "c"
            override suspend fun originalStream() = s
            override fun sourceOfChain() = null
            override fun progress(label: String, v: Double) {}
            override fun isStale() = false
        }
        val def = com.clearufo.forensics.engine.FILTERS["super_resolution"]!!
        com.clearufo.forensics.engine.IMPLS["super_resolution"]!!(s, com.clearufo.forensics.engine.normalizeParams(def, mapOf(*p)), ctx).getFrame(0)
    }

    @Test fun superResolutionMatchesBrowserWorkbench() {
        val W = 61; val H = 47
        val shifts = listOf(0.0 to 0.0, 0.4 to -0.3, -0.7 to 0.25, 1.2 to 0.6, -0.35 to -0.8, 0.55 to 1.1)
        val frames = shifts.mapIndexed { k, (dx, dy) -> input(W, H, 200 + k, dx, dy) }
        val roi = com.clearufo.forensics.engine.RectP(9.0, 7.0, 40.0, 33.0)
        check("superres_gauss_x2", superRes(frames, "scale" to 2.0, "maxFrames" to 30.0, "kernel" to "gaussian", "output" to "frame"), 1e-3)
        check("superres_bilinear_x3", superRes(frames, "scale" to 3.0, "maxFrames" to 30.0, "kernel" to "bilinear", "output" to "frame"), 1e-3)
        val whole = superRes(frames, "scale" to 2.0, "roi" to roi, "maxFrames" to 4.0, "kernel" to "gaussian", "output" to "frame")
        check("superres_gauss_x2_roi", whole, 1e-3)
        // "Registration region only": exactly the region of the whole-frame result
        val part = superRes(frames, "scale" to 2.0, "roi" to roi, "maxFrames" to 4.0, "kernel" to "gaussian", "output" to "region")
        val x0 = 9 * 2; val y0 = 7 * 2; val pw = (49 - 9) * 2; val ph = (40 - 7) * 2
        assertEquals(pw, part.w); assertEquals(ph, part.h)
        for (y in 0 until ph) for (x in 0 until pw) for (c in 0 until 4)
            assertEquals("region pixel $x,$y", whole.d[((y + y0) * whole.w + x + x0) * 4 + c], part.d[(y * pw + x) * 4 + c], 0f)
        // built in many bands (little memory): the same result
        com.clearufo.forensics.engine.filters.superResBandBytes = 122L * 32 * 7
        try {
            val banded = superRes(frames, "scale" to 2.0, "maxFrames" to 30.0, "kernel" to "gaussian", "output" to "frame")
            val single = run { com.clearufo.forensics.engine.filters.superResBandBytes = 0; superRes(frames, "scale" to 2.0, "maxFrames" to 30.0, "kernel" to "gaussian", "output" to "frame") }
            org.junit.Assert.assertArrayEquals("banded result", single.d, banded.d, 0f)
            com.clearufo.forensics.engine.filters.superResBandBytes = 183L * 32 * 5
            val bandedBl = superRes(frames, "scale" to 3.0, "maxFrames" to 30.0, "kernel" to "bilinear", "output" to "frame")
            check("superres_bilinear_x3", bandedBl, 1e-3)
        } finally { com.clearufo.forensics.engine.filters.superResBandBytes = 0 }
        println(report)
    }
}
