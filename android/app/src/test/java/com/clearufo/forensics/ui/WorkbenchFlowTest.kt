package com.clearufo.forensics.ui

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper
import java.util.concurrent.TimeUnit

/** Drives the view model as the UI does (add steps, change parameters, switch chains) and checks what the viewer gets. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class WorkbenchFlowTest {
    private fun settle(wb: Workbench, what: String) {
        val t0 = System.currentTimeMillis()
        while (true) {
            ShadowLooper.idleMainLooper(16, TimeUnit.MILLISECONDS)
            wb.renderError?.let { throw AssertionError("$what: render failed: ${it.first}", wb.lastError) }
            if (wb.render != null && !wb.rendering) { Thread.sleep(150); ShadowLooper.idleMainLooper(16, TimeUnit.MILLISECONDS); if (!wb.rendering) return }
            if (System.currentTimeMillis() - t0 > 60_000) throw AssertionError("$what: no render within a minute")
            Thread.sleep(20)
        }
    }

    @Test fun extractChannelShowsTheChosenChannel() {
        val wb = Workbench(ApplicationProvider.getApplicationContext<Application>())
        wb.addTestPattern("plate", "Plate")
        settle(wb, "pattern")
        wb.addFilter("temporal_smoothing"); wb.selectedFilter!!.let { wb.setParam(it.id, "method", "median"); wb.setParam(it.id, "size", 4.0) }
        settle(wb, "smoothing")
        val smoothed = wb.render!!.frame
        wb.addFilter("extract_channel")
        val ex = wb.selectedFilter!!
        assertEquals("extract_channel", ex.type)
        for (ch in listOf("y", "r", "g", "b")) {
            wb.setParam(ex.id, "channel", ch)
            settle(wb, "channel $ch")
            val f = wb.render!!.frame
            var gray = true; var same = true
            for (k in 0 until f.w * f.h step 97) {
                val q = k * 4
                if (f.d[q] != f.d[q + 1] || f.d[q] != f.d[q + 2]) gray = false
                val want = when (ch) { "r" -> smoothed.d[q]; "g" -> smoothed.d[q + 1]; "b" -> smoothed.d[q + 2]; else -> (0.299 * smoothed.d[q] + 0.587 * smoothed.d[q + 1] + 0.114 * smoothed.d[q + 2]).toFloat() }
                if (kotlin.math.abs(f.d[q] - want) > 1e-3) same = false
            }
            assertTrue("channel $ch: output is not gray", gray)
            assertTrue("channel $ch: output is not the $ch channel of the smoothed frame", same)
        }
    }
}
