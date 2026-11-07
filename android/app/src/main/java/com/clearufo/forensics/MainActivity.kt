package com.clearufo.forensics

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.LaunchedEffect
import com.clearufo.forensics.ui.AppRoot
import com.clearufo.forensics.ui.ClearUfoTheme
import com.clearufo.forensics.ui.Workbench

class MainActivity : ComponentActivity() {
    val wb: Workbench by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) handleIntent(intent)
        setContent {
            ClearUfoTheme(wb.themeName) {
                // keep the screen on while a video plays or an export runs
                LaunchedEffect(wb.playing, wb.exportJob) {
                    if (wb.playing || wb.exportJob != null) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
                AppRoot(wb, this)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    /** "Open with" and "Share" from the gallery, the file manager or a messenger. */
    private fun handleIntent(i: Intent?) {
        i ?: return
        val uris = ArrayList<Uri>()
        when (i.action) {
            Intent.ACTION_VIEW -> i.data?.let(uris::add)
            Intent.ACTION_SEND -> (if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else @Suppress("DEPRECATION") i.getParcelableExtra(Intent.EXTRA_STREAM))?.let(uris::add)
            Intent.ACTION_SEND_MULTIPLE -> (if (Build.VERSION.SDK_INT >= 33) i.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) else @Suppress("DEPRECATION") i.getParcelableArrayListExtra(Intent.EXTRA_STREAM))?.let(uris::addAll)
        }
        if (uris.isNotEmpty()) wb.openUris(uris, sequence = i.action == Intent.ACTION_SEND_MULTIPLE && uris.size > 1)
    }
}
