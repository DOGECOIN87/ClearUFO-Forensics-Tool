package com.clearufo.forensics.ui

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.clearufo.forensics.MainActivity
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowLooper
import java.io.File

/**
 * Renders the real application (Compose UI, engine, synthetic test footage) on the Galaxy Z Fold3 inner screen
 * (1768×2208 px, ≈5:4) unfolded in portrait and landscape and half folded, and writes PNG screenshots to
 * build/screenshots. Flex mode postures are injected (WindowManager reports them on the device).
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34])
class FoldLayoutScreenshots {
    @get:Rule val rule = createEmptyComposeRule()

    @After fun reset() { PostureOverride.value = null }

    /** Opt-in (./gradlew :app:testDebugUnitTest -Pscreenshots): renders take a while and need native graphics. */
    @org.junit.Before fun enabled() { org.junit.Assume.assumeTrue(System.getProperty("screenshots") == "true") }

    private fun shoot(name: String, posture: Posture? = null, setup: (Workbench) -> Unit = ::demo) {
        PostureOverride.value = posture
        ActivityScenario.launch(MainActivity::class.java).use { sc ->
            var wb: Workbench? = null
            sc.onActivity { wb = it.wb; setup(it.wb) }
            // the engine renders on background threads and publishes on the main looper, which Robolectric only
            // advances when told to
            val t0 = System.currentTimeMillis()
            while (true) {
                ShadowLooper.idleMainLooper(16, java.util.concurrent.TimeUnit.MILLISECONDS)
                val w = wb!!
                w.renderError?.let { throw AssertionError("render failed: ${it.first}", w.lastError) }
                if (w.render != null && !w.rendering && w.appTasks.value.isEmpty()) break
                if (System.currentTimeMillis() - t0 > 180_000) throw AssertionError("no render within 3 minutes")
                Thread.sleep(50)
            }
            // let Compose run its frames (the paused clock only advances when told to)
            repeat(40) { ShadowLooper.idleMainLooper(50, java.util.concurrent.TimeUnit.MILLISECONDS); Thread.sleep(10) }
            var bmp: Bitmap? = null
            for (attempt in 1..10) {
                try { rule.mainClock.advanceTimeBy(500); bmp = rule.onRoot().captureToImage().asAndroidBitmap(); break }
                catch (e: androidx.compose.ui.test.ComposeTimeoutException) { repeat(20) { ShadowLooper.idleMainLooper(50, java.util.concurrent.TimeUnit.MILLISECONDS); Thread.sleep(10) } }
            }
            checkNotNull(bmp) { "the UI did not settle" }
            val dir = File("build/screenshots").apply { mkdirs() }
            File(dir, "$name.png").outputStream().use { bmp!!.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    /** A degraded license plate test video with a small enhancement chain. */
    private fun demo(wb: Workbench) {
        wb.addTestPattern("plate", "License Plate (degraded)")
        wb.addFilter("motion_deblurring")
        wb.selectedFilter?.let { f -> wb.setParam(f.id, "length", 9.0); wb.setParam(f.id, "angle", 12.0); wb.setParam(f.id, "noise", 0.02) }
        wb.addFilter("unsharp_mask")
    }

    @Test @Config(qualifiers = "w673dp-h841dp-port-420dpi") fun inner_portrait() = shoot("fold3_inner_portrait")
    @Test @Config(qualifiers = "w841dp-h673dp-land-420dpi") fun inner_landscape() = shoot("fold3_inner_landscape")
    @Test @Config(qualifiers = "w841dp-h673dp-land-420dpi") fun flex_tabletop() =
        shoot("fold3_flex_tabletop", Posture(halfOpened = true, horizontalHinge = true, bounds = intArrayOf(0, 868, 2208, 900), separating = true))
    @Test @Config(qualifiers = "w673dp-h841dp-port-420dpi") fun flex_book() =
        shoot("fold3_flex_book", Posture(halfOpened = true, horizontalHinge = false, bounds = intArrayOf(868, 0, 900, 2208), separating = true))
    @Test @Config(qualifiers = "w673dp-h841dp-port-420dpi") fun inner_welcome() = shoot("fold3_inner_welcome") { }
}
