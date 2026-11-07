package com.clearufo.forensics.ui

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import kotlinx.coroutines.flow.map

// "Midnight": the workbench's black/graphite investigation console; "Daylight": white chrome for bright rooms.
object Pal {
    val ok = Color(0xFF4CC38A)
    val warn = Color(0xFFFFB020)
    val err = Color(0xFFFF5A52)
    val accent = Color(0xFFF2F2F2)
    val gold = Color(0xFFFFD400)
}

private val Midnight = darkColorScheme(
    primary = Color(0xFFF2F2F2), onPrimary = Color(0xFF000000),
    primaryContainer = Color(0xFF2A2A2A), onPrimaryContainer = Color(0xFFF2F2F2),
    secondary = Color(0xFFBDBDBD), onSecondary = Color.Black,
    secondaryContainer = Color(0xFF262626), onSecondaryContainer = Color(0xFFEDEDED),
    tertiary = Pal.gold, onTertiary = Color.Black,
    background = Color(0xFF000000), onBackground = Color(0xFFEDEDED),
    surface = Color(0xFF0E0E0E), onSurface = Color(0xFFEDEDED),
    surfaceVariant = Color(0xFF161616), onSurfaceVariant = Color(0xFFB4B4B4),
    surfaceContainer = Color(0xFF121212), surfaceContainerHigh = Color(0xFF1A1A1A), surfaceContainerHighest = Color(0xFF222222),
    surfaceContainerLow = Color(0xFF0B0B0B), surfaceContainerLowest = Color(0xFF050505),
    outline = Color(0xFF3A3A3A), outlineVariant = Color(0xFF262626),
    error = Pal.err, onError = Color.Black,
)

private val Daylight = lightColorScheme(
    primary = Color(0xFF111111), onPrimary = Color.White,
    primaryContainer = Color(0xFFE6E6E6), onPrimaryContainer = Color(0xFF111111),
    secondary = Color(0xFF555555), secondaryContainer = Color(0xFFEDEDED),
    tertiary = Color(0xFF9A6B00),
    background = Color(0xFFF4F4F4), surface = Color.White, surfaceVariant = Color(0xFFF0F0F0),
    surfaceContainer = Color(0xFFF7F7F7), surfaceContainerHigh = Color(0xFFEFEFEF),
    outline = Color(0xFFBDBDBD), outlineVariant = Color(0xFFDADADA),
)

val Mono = FontFamily.Monospace

@Composable
fun ClearUfoTheme(theme: String, content: @Composable () -> Unit) {
    val scheme = when (theme) { "classic" -> Daylight; "system" -> if (isSystemInDarkTheme()) Midnight else Daylight; else -> Midnight }
    val base = Typography()
    MaterialTheme(colorScheme = scheme, typography = base.copy(
        bodySmall = base.bodySmall.copy(fontSize = 12.sp), labelSmall = base.labelSmall.copy(fontSize = 11.sp),
    ), content = content)
}

val monoSmall = TextStyle(fontFamily = Mono, fontSize = 11.sp)

// ---------------------------------------------------------------- foldable posture (Jetpack WindowManager)
/** Galaxy Z Fold3: the cover screen reports no fold; the inner screen reports a vertical hinge (FLAT or HALF_OPENED). */
data class Posture(
    val halfOpened: Boolean = false,
    val horizontalHinge: Boolean = false,
    /** Fold bounds in window pixels (left, top, right, bottom), or null. */
    val bounds: IntArray? = null,
    val separating: Boolean = false,
) {
    val tabletop get() = halfOpened && horizontalHinge
    val book get() = halfOpened && !horizontalHinge
}

/** Test hook: a fixed posture (screenshot tests of the Flex mode layouts off-device). */
object PostureOverride { @Volatile var value: Posture? = null }

@Composable
fun rememberPosture(activity: Activity): State<Posture> {
    val flow = remember(activity) {
        WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity).map { info ->
            val f = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull()
            if (f == null) Posture() else Posture(
                halfOpened = f.state == FoldingFeature.State.HALF_OPENED,
                horizontalHinge = f.orientation == FoldingFeature.Orientation.HORIZONTAL,
                bounds = intArrayOf(f.bounds.left, f.bounds.top, f.bounds.right, f.bounds.bottom),
                separating = f.isSeparating,
            )
        }
    }
    return flow.collectAsState(initial = Posture())
}

@Composable
fun LaunchedToasts(wb: Workbench, show: suspend (String) -> Unit) {
    LaunchedEffect(wb.messages.size) {
        while (wb.messages.isNotEmpty()) { val m = wb.messages.removeAt(0); show(m) }
    }
}
