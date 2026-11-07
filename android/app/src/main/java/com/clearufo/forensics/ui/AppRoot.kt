package com.clearufo.forensics.ui

import android.app.Activity
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Redo
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.activity.compose.BackHandler
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import com.clearufo.forensics.BuildConfig
import com.clearufo.forensics.engine.FILTER_LIST
import com.clearufo.forensics.project.FilterInstance
import androidx.compose.foundation.horizontalScroll
import com.clearufo.forensics.engine.Par
import com.clearufo.forensics.engine.WriteFormats
import com.clearufo.forensics.engine.CATEGORIES
import com.clearufo.forensics.engine.num
import com.clearufo.forensics.engine.str
import com.clearufo.forensics.media.EvidenceFile
import com.clearufo.forensics.media.Hashes
import com.clearufo.forensics.media.fmtBytes
import com.clearufo.forensics.project.CaseInfo
import com.clearufo.forensics.project.PROJECT_EXT
import java.io.File
import kotlin.math.max
import kotlin.math.min

enum class Panel(val title: String, val icon: ImageVector) {
    FILTERS("Filters", Icons.Outlined.AutoFixHigh), SETTINGS("Settings", Icons.Outlined.Tune),
    HISTORY("History", Icons.Outlined.AccountTree), TOOLS("Tools", Icons.Outlined.Insights),
}

/** Layouts: cover screen / phones (STACK), phone landscape (SIDE), unfolded inner screen (DUAL) and Flex mode. */
enum class Mode { STACK, SIDE, DUAL, TABLETOP, BOOK }

class ExportRequest(val format: String, val range: String, val name: String, val fps: Double, val quality: Double, val filterId: String?)

@Composable
fun AppRoot(wb: Workbench, activity: Activity) {
    val live by rememberPosture(activity)
    val posture = PostureOverride.value ?: live
    val snack = remember { SnackbarHostState() }
    LaunchedToasts(wb) { snack.showSnackbar(it, withDismissAction = true, duration = SnackbarDuration.Short) }

    // ------------------------------------------------------------ system pickers (Storage Access Framework)
    var relinkId by remember { mutableStateOf<String?>(null) }
    var imageTarget by remember { mutableStateOf<Pair<String, String>?>(null) }
    var pendingExport by remember { mutableStateOf<ExportRequest?>(null) }
    var hashResult by remember { mutableStateOf<Pair<EvidenceFile, Hashes>?>(null) }
    var captureFile by remember { mutableStateOf<File?>(null) }
    val openMedia = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { wb.openUris(it) }
    val openSeq = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { wb.openUris(it, sequence = true) }
    val openProject = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(wb::openProject) }
    val saveProject = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { it?.let(wb::saveProject) }
    val relink = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> relinkId?.let { if (uris.isNotEmpty()) wb.relink(it, uris) }; relinkId = null }
    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { u -> imageTarget?.let { (f, k) -> u?.let { wb.setImageParam(f, k, it) } }; imageTarget = null }
    val report = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/pdf")) { it?.let(wb::report) }
    val hashPick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { u -> u?.let { wb.hashFile(it) { f, h -> hashResult = f to h } } }
    val exportTo = rememberLauncherForActivityResult(CreateDoc()) { u ->
        val r = pendingExport; pendingExport = null
        if (u != null && r != null) wb.export(u, r.name, r.format, r.range, r.fps, r.quality, filterId = r.filterId)
    }
    val captureVideo = rememberLauncherForActivityResult(ActivityResultContracts.CaptureVideo()) { ok -> captureFile?.let { f -> if (ok && f.length() > 0) wb.openUris(listOf(Uri.fromFile(f))) } }
    val capturePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok -> captureFile?.let { f -> if (ok && f.length() > 0) wb.openUris(listOf(Uri.fromFile(f))) } }

    fun captureUri(ext: String): Uri {
        val dir = File(activity.filesDir, "captures").apply { mkdirs() }
        val f = File(dir, "capture_${System.currentTimeMillis()}.$ext"); captureFile = f
        return FileProvider.getUriForFile(activity, "${activity.packageName}.files", f)
    }

    var dialog by remember { mutableStateOf<String?>(null) }
    var exportFor by remember { mutableStateOf<FilterInstance?>(null) }
    val actions = Actions(
        openMedia = { openMedia.launch(arrayOf("*/*")) },
        openSequence = { openSeq.launch(arrayOf("image/*")) },
        openProject = { openProject.launch(arrayOf("*/*")) },
        saveProject = { saveProject.launch("${WriteFormats.sanitizeName(wb.project.name)}$PROJECT_EXT") },
        export = { exportFor = null; dialog = "export" },
        report = { report.launch("${WriteFormats.sanitizeName(wb.project.name)}_report.pdf") },
        dialog = { dialog = it },
        hashFile = { hashPick.launch(arrayOf("*/*")) },
        captureVideo = { captureVideo.launch(captureUri("mp4")) },
        capturePhoto = { capturePhoto.launch(captureUri("jpg")) },
    )
    var panelFocus by remember { mutableStateOf<Panel?>(null) }
    BackHandler(enabled = wb.edit != null || wb.inspect != null) { if (wb.edit != null) { wb.edit = null; wb.requestRender() } else wb.inspect = null }
    val onWrite: (FilterInstance) -> Unit = { exportFor = it; dialog = "export" }
    val onRelink: (String) -> Unit = { relinkId = it; relink.launch(arrayOf("*/*")) }
    val onPickImage: (String, String) -> Unit = { f, k -> imageTarget = f to k; pickImage.launch(arrayOf("image/*")) }

    @Composable
    fun panel(p: Panel, onShowViewer: () -> Unit = {}) {
        when (p) {
            Panel.FILTERS -> FiltersPanel(wb) { panelFocus = Panel.SETTINGS }
            Panel.SETTINGS -> SettingsPanel(wb, onWrite, onPickImage, onRelink, onShowViewer)
            Panel.HISTORY -> HistoryPanel(wb, onRelink) { panelFocus = Panel.SETTINGS }
            Panel.TOOLS -> ToolsPanel(wb)
        }
    }

    val density = LocalDensity.current
    var rootTop by remember { mutableFloatStateOf(0f) }
    var rootLeft by remember { mutableFloatStateOf(0f) }

    Scaffold(snackbarHost = { SnackbarHost(snack) }, containerColor = MaterialTheme.colorScheme.background, contentWindowInsets = WindowInsets.safeDrawing) { pad ->
        BoxWithConstraints(Modifier.fillMaxSize().padding(pad).onGloballyPositioned { val p = it.positionInWindow(); rootTop = p.y; rootLeft = p.x }) {
            val w = maxWidth; val h = maxHeight
            val ratio = w.value / h.value
            val mode = when {
                wb.layoutPref == "phone" -> if (w > h && h < 520.dp) Mode.SIDE else Mode.STACK
                posture.tabletop && h > 400.dp -> Mode.TABLETOP
                posture.book && w > 560.dp -> Mode.BOOK
                wb.layoutPref == "dual" || (min(w.value, h.value) >= 560f && ratio in 0.68f..1.5f) || w >= 900.dp -> Mode.DUAL
                w > h -> Mode.SIDE
                else -> Mode.STACK
            }
            val compact = mode == Mode.STACK || mode == Mode.SIDE
            // the evidence decides: tall (portrait) frames get a tall viewer column
            val tallMedia = wb.render?.info?.let { it.height > it.width * 1.15 } ?: false
            val viewer: @Composable (Modifier) -> Unit = { m -> ViewerPane(wb, m, compact, actions.openMedia, { dialog = "pattern" }, actions.openProject) }
            when (mode) {
                Mode.STACK -> {
                    // Cover screen (24.5:9) and phones: viewer on top, one panel below, navigation at the bottom
                    var sel by rememberSaveable { mutableStateOf(Panel.HISTORY) }
                    LaunchedEffect(panelFocus) { panelFocus?.let { sel = it; panelFocus = null } }
                    val tall = h.value / w.value > 2.0f
                    Column(Modifier.fillMaxSize()) {
                        TopBar(wb, actions, compact = true)
                        viewer(Modifier.fillMaxWidth().weight(if (tall) 1f else 1.15f))
                        PlayerBar(wb, compact = true)
                        Surface(Modifier.fillMaxWidth().weight(if (tall) 1.05f else 0.85f), color = MaterialTheme.colorScheme.surface) { panel(sel) }
                        NavigationBar(Modifier.height(64.dp), containerColor = MaterialTheme.colorScheme.surfaceContainer) {
                            listOf(Panel.FILTERS, Panel.SETTINGS, Panel.HISTORY, Panel.TOOLS).forEach { p ->
                                NavigationBarItem(sel == p, { sel = p }, { Icon(p.icon, p.title) }, label = { Text(p.title, fontSize = 11.sp) })
                            }
                        }
                    }
                }
                Mode.SIDE -> Row(Modifier.fillMaxSize()) {
                    Column(Modifier.weight(1.6f).fillMaxHeight()) { TopBar(wb, actions, compact = true); viewer(Modifier.weight(1f).fillMaxWidth()); PlayerBar(wb, compact = true) }
                    PanelGroup(listOf(Panel.SETTINGS, Panel.HISTORY, Panel.FILTERS, Panel.TOOLS), panelFocus, { panelFocus = null }, Modifier.weight(1f).fillMaxHeight()) { panel(it) }
                }
                Mode.DUAL -> if (tallMedia) {
                    // portrait videos (phone recordings): a tall viewer column, settings and the chain stacked beside it
                    Row(Modifier.fillMaxSize()) {
                        Column(Modifier.weight(if (ratio < 1.05f) 1.15f else 1f).fillMaxHeight()) { TopBar(wb, actions, compact = true); viewer(Modifier.weight(1f).fillMaxWidth()); PlayerBar(wb, compact = true) }
                        VerticalDivider()
                        Column(Modifier.weight(1f).fillMaxHeight()) {
                            PanelGroup(listOf(Panel.SETTINGS, Panel.TOOLS), panelFocus.takeIf { it == Panel.SETTINGS || it == Panel.TOOLS }, { panelFocus = null }, Modifier.weight(1.15f).fillMaxWidth()) { panel(it) }
                            HorizontalDivider()
                            PanelGroup(listOf(Panel.HISTORY, Panel.FILTERS), panelFocus.takeIf { it == Panel.FILTERS || it == Panel.HISTORY }, { panelFocus = null }, Modifier.weight(1f).fillMaxWidth()) { panel(it) }
                        }
                    }
                } else if (ratio < 1.05f) {
                    // Fold3 unfolded, portrait (≈ 5:4): large viewer, two panel groups side by side underneath
                    Column(Modifier.fillMaxSize()) {
                        TopBar(wb, actions, compact = false)
                        viewer(Modifier.fillMaxWidth().weight(1.3f))
                        PlayerBar(wb, compact = false)
                        Row(Modifier.fillMaxWidth().weight(1f)) {
                            PanelGroup(listOf(Panel.HISTORY, Panel.FILTERS), panelFocus.takeIf { it == Panel.FILTERS || it == Panel.HISTORY }, { panelFocus = null }, Modifier.weight(1f).fillMaxHeight()) { panel(it) }
                            VerticalDivider()
                            PanelGroup(listOf(Panel.SETTINGS, Panel.TOOLS), panelFocus.takeIf { it == Panel.SETTINGS || it == Panel.TOOLS }, { panelFocus = null }, Modifier.weight(1f).fillMaxHeight()) { panel(it) }
                        }
                    }
                } else {
                    // Fold3 unfolded, landscape: viewer and player on the left, settings and the chain on the right
                    Row(Modifier.fillMaxSize()) {
                        Column(Modifier.weight(1.55f).fillMaxHeight()) { TopBar(wb, actions, compact = false); viewer(Modifier.weight(1f).fillMaxWidth()); PlayerBar(wb, compact = false) }
                        VerticalDivider()
                        Column(Modifier.weight(1f).fillMaxHeight()) {
                            PanelGroup(listOf(Panel.SETTINGS, Panel.TOOLS), panelFocus.takeIf { it == Panel.SETTINGS || it == Panel.TOOLS }, { panelFocus = null }, Modifier.weight(1.15f).fillMaxWidth()) { panel(it) }
                            HorizontalDivider()
                            PanelGroup(listOf(Panel.HISTORY, Panel.FILTERS), panelFocus.takeIf { it == Panel.FILTERS || it == Panel.HISTORY }, { panelFocus = null }, Modifier.weight(1f).fillMaxWidth()) { panel(it) }
                        }
                    }
                }
                Mode.TABLETOP -> {
                    // Flex mode, half folded like a laptop: the image above the hinge, every control below it
                    val b = posture.bounds!!
                    val topH = with(density) { max(120f, b[1] - rootTop).toDp() }
                    val gap = with(density) { (b[3] - b[1]).toFloat().toDp() }
                    Column(Modifier.fillMaxSize()) {
                        Column(Modifier.fillMaxWidth().height(topH)) { TopBar(wb, actions, compact = true); viewer(Modifier.weight(1f).fillMaxWidth()) }
                        Spacer(Modifier.height(gap))
                        PlayerBar(wb, compact = false)
                        Row(Modifier.fillMaxWidth().weight(1f)) {
                            PanelGroup(listOf(Panel.HISTORY, Panel.FILTERS), panelFocus.takeIf { it == Panel.FILTERS || it == Panel.HISTORY }, { panelFocus = null }, Modifier.weight(1f).fillMaxHeight()) { panel(it) }
                            VerticalDivider()
                            PanelGroup(listOf(Panel.SETTINGS, Panel.TOOLS), panelFocus.takeIf { it == Panel.SETTINGS || it == Panel.TOOLS }, { panelFocus = null }, Modifier.weight(1f).fillMaxHeight()) { panel(it) }
                        }
                    }
                }
                Mode.BOOK -> {
                    // Flex mode, half folded like a book: the evidence on the left page, the controls on the right page
                    val b = posture.bounds!!
                    val leftW = with(density) { max(200f, b[0] - rootLeft).toDp() }
                    val gap = with(density) { (b[2] - b[0]).toFloat().toDp() }
                    Row(Modifier.fillMaxSize()) {
                        Column(Modifier.width(leftW).fillMaxHeight()) { TopBar(wb, actions, compact = true); viewer(Modifier.weight(1f).fillMaxWidth()); PlayerBar(wb, compact = true) }
                        Spacer(Modifier.width(gap))
                        Column(Modifier.weight(1f).fillMaxHeight()) {
                            PanelGroup(listOf(Panel.SETTINGS, Panel.TOOLS), panelFocus.takeIf { it == Panel.SETTINGS || it == Panel.TOOLS }, { panelFocus = null }, Modifier.weight(1.1f).fillMaxWidth()) { panel(it) }
                            HorizontalDivider()
                            PanelGroup(listOf(Panel.HISTORY, Panel.FILTERS), panelFocus.takeIf { it == Panel.FILTERS || it == Panel.HISTORY }, { panelFocus = null }, Modifier.weight(1f).fillMaxWidth()) { panel(it) }
                        }
                    }
                }
            }
            ProgressOverlay(wb, Modifier.align(Alignment.BottomCenter).padding(bottom = if (mode == Mode.STACK) 72.dp else 8.dp))
        }
    }

    // ------------------------------------------------------------ dialogs
    when (dialog) {
        "pattern" -> PatternDialog(wb) { dialog = null }
        "export" -> ExportDialog(wb, exportFor, { dialog = null }) { req, fileName, mime ->
            dialog = null; pendingExport = req
            exportTo.launch(fileName to mime)
        }
        "case" -> CaseDialog(wb) { dialog = null }
        "settings" -> SettingsDialog(wb) { dialog = null }
        "about" -> AboutDialog { dialog = null }
        "help" -> HelpDialog { dialog = null }
        "bookmark" -> TextInputDialog("Add Bookmark (frame ${wb.frame})", "", { dialog = null }) { wb.addBookmark(it); dialog = null }
    }
    if (wb.exportJob != null) ExportProgressDialog(wb)
    wb.exportResult?.let { r ->
        AlertDialog(onDismissRequest = { wb.exportResult = null }, confirmButton = { TextButton(onClick = { wb.exportResult = null }) { Text("OK") } }, title = { Text("Export complete") },
            text = { Column(Modifier.verticalScroll(rememberScrollState())) {
                Text("${r.name} · ${WriteFormats.of(r.format)?.short} · ${r.frames} frame(s) · ${fmtBytes(r.bytes)}")
                Spacer(Modifier.height(6.dp)); Text(r.verified, color = if (r.verified.startsWith("verified")) Pal.ok else MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
                Spacer(Modifier.height(6.dp)); Text("MD5", fontSize = 11.sp); Text(r.md5, style = monoSmall); Text("SHA-256", fontSize = 11.sp); Text(r.sha256, style = monoSmall)
            } })
    }
    hashResult?.let { (f, h) ->
        AlertDialog(onDismissRequest = { hashResult = null }, confirmButton = { TextButton(onClick = { hashResult = null }) { Text("OK") } }, title = { Text("File Hashes") },
            text = { Column { Text("${f.name} · ${h.bytes} bytes", fontWeight = FontWeight.Bold); Spacer(Modifier.height(6.dp)); listOf("MD5" to h.md5, "SHA-1" to h.sha1, "SHA-256" to h.sha256).forEach { (k, v) -> Text(k, fontSize = 11.sp); Text(v, style = monoSmall) } } })
    }
}

class Actions(val openMedia: () -> Unit, val openSequence: () -> Unit, val openProject: () -> Unit, val saveProject: () -> Unit, val export: () -> Unit, val report: () -> Unit,
              val dialog: (String) -> Unit, val hashFile: () -> Unit, val captureVideo: () -> Unit, val capturePhoto: () -> Unit)

@Composable
private fun TopBar(wb: Workbench, a: Actions, compact: Boolean) {
    var menu by remember { mutableStateOf(false) }
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().height(if (compact) 48.dp else 54.dp).padding(start = 6.dp)) {
            BrandBadge(if (compact) 30.dp else 36.dp)
            Column(Modifier.weight(1f).padding(start = 6.dp)) {
                Text("ClearUFO", fontWeight = FontWeight.Bold, fontSize = if (compact) 14.sp else 16.sp, maxLines = 1)
                Text(wb.project.name + if (wb.dirty) " *" else "", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            key(wb.historyVersion) {
                IconButton(onClick = { wb.undo() }, enabled = wb.canUndo) { Icon(Icons.AutoMirrored.Filled.Undo, "Undo") }
                IconButton(onClick = { wb.redo() }, enabled = wb.canRedo) { Icon(Icons.AutoMirrored.Filled.Redo, "Redo") }
            }
            IconButton(onClick = a.openMedia) { Icon(Icons.Outlined.FolderOpen, "Open image or video") }
            if (!compact) {
                IconButton(onClick = a.export, enabled = wb.chain != null) { Icon(Icons.Outlined.SaveAlt, "Export") }
                IconButton(onClick = a.report, enabled = wb.chain != null) { Icon(Icons.Outlined.Description, "Generate report (PDF)") }
            }
            Box {
                IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "Menu") }
                DropdownMenu(menu, { menu = false }) {
                    @Composable fun item(t: String, icon: ImageVector, enabled: Boolean = true, f: () -> Unit) = DropdownMenuItem({ Text(t) }, { menu = false; f() }, leadingIcon = { Icon(icon, null) }, enabled = enabled)
                    item("New Project", Icons.Outlined.NoteAdd) { wb.newProject() }
                    item("Open Project…", Icons.Outlined.FileOpen, f = a.openProject)
                    item("Save Project…", Icons.Outlined.Save, f = a.saveProject)
                    HorizontalDivider()
                    item("Load Image or Video…", Icons.Outlined.FolderOpen, f = a.openMedia)
                    item("Load Image Sequence…", Icons.Outlined.Collections, f = a.openSequence)
                    item("Record Video with the Camera…", Icons.Outlined.Videocam, f = a.captureVideo)
                    item("Take Photo with the Camera…", Icons.Outlined.PhotoCamera, f = a.capturePhoto)
                    item("Test Pattern…", Icons.Outlined.GridOn) { a.dialog("pattern") }
                    HorizontalDivider()
                    item("Export (Write Video / Images)…", Icons.Outlined.SaveAlt, wb.chain != null, a.export)
                    item("Generate Report (PDF)…", Icons.Outlined.Description, wb.chain != null, a.report)
                    item("Add Bookmark…", Icons.Outlined.BookmarkAdd, wb.chain != null) { a.dialog("bookmark") }
                    item("Compute File Hashes…", Icons.Outlined.Fingerprint, f = a.hashFile)
                    item("Case Information…", Icons.Outlined.Badge) { a.dialog("case") }
                    item("Clear Processing Cache", Icons.Outlined.CleaningServices) { wb.engine.clearCache(); wb.requestRender(); wb.toast("Cache cleared.") }
                    HorizontalDivider()
                    item("Settings…", Icons.Outlined.Settings) { a.dialog("settings") }
                    item("Quick Start", Icons.Outlined.HelpOutline) { a.dialog("help") }
                    item("About ClearUFO", Icons.Outlined.Info) { a.dialog("about") }
                }
            }
        }
    }
}

@Composable
private fun PanelGroup(panels: List<Panel>, focus: Panel?, consumed: () -> Unit, modifier: Modifier, content: @Composable (Panel) -> Unit) {
    var sel by rememberSaveable { mutableIntStateOf(0) }
    LaunchedEffect(focus) { if (focus != null) { panels.indexOf(focus).takeIf { it >= 0 }?.let { sel = it }; consumed() } }
    Column(modifier.background(MaterialTheme.colorScheme.surface)) {
        PrimaryTabRow(selectedTabIndex = sel.coerceIn(0, panels.size - 1), containerColor = MaterialTheme.colorScheme.surfaceContainer) {
            panels.forEachIndexed { i, p -> Tab(sel == i, { sel = i }, text = { Text(p.title, fontSize = 13.sp, maxLines = 1) }, icon = { Icon(p.icon, null, Modifier.size(20.dp)) }) }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) { content(panels[sel.coerceIn(0, panels.size - 1)]) }
    }
}

@Composable
private fun ProgressOverlay(wb: Workbench, modifier: Modifier) {
    val eng by wb.progress.collectAsState()
    val app by wb.appTasks.collectAsState()
    // filter progress matters only while something is being computed
    val busy = wb.rendering || wb.playing || wb.exportJob != null
    val t = (app + if (busy) eng else emptyMap()).values.lastOrNull() ?: return
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHighest, shape = MaterialTheme.shapes.medium, shadowElevation = 6.dp, modifier = modifier.widthIn(max = 420.dp).fillMaxWidth(0.9f)) {
        Column(Modifier.padding(10.dp)) {
            Text(t.first, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            LinearProgressIndicator({ t.second.toFloat().coerceIn(0f, 1f) }, Modifier.fillMaxWidth().padding(top = 4.dp))
        }
    }
}

// ---------------------------------------------------------------- dialogs
@Composable
private fun PatternDialog(wb: Workbench, onDismiss: () -> Unit) {
    val items = listOf("plate" to "License Plate (degraded)", "bars" to "Color Bars", "chart" to "Resolution Chart", "zone" to "Zone Plate", "grid" to "Calibration Grid", "periodic" to "Periodic Noise")
    AlertDialog(onDismissRequest = onDismiss, confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } }, title = { Text("Test Pattern") },
        text = { Column { Text("Synthetic, deterministic test material to validate the processing.", fontSize = 13.sp); items.forEach { (k, l) -> TextButton(onClick = { wb.addTestPattern(k, l); onDismiss() }) { Text(l) } } } })
}

@Composable
private fun ExportDialog(wb: Workbench, writer: FilterInstance?, onDismiss: () -> Unit, onGo: (ExportRequest, String, String) -> Unit) {
    val n = wb.render?.info?.frameCount ?: 1
    val isVideoWriter = writer?.type == "video_writer"
    val wp = writer?.params ?: emptyMap()
    var video by remember { mutableStateOf(if (writer != null) isVideoWriter else n > 1) }
    val lossless = wb.prefs.losslessOnly
    val formats = (if (video) WriteFormats.VIDEO_EXPORT else WriteFormats.IMAGE_EXPORT).filter { !lossless || WriteFormats.of(it)?.lossy == false }
    var format by remember(video) { mutableStateOf(wp.str("format").takeIf { it in formats } ?: formats.first()) }
    var range by remember(video) { mutableStateOf(wp.str("range").ifEmpty { if (video) "all" else "current" }) }
    var name by remember { mutableStateOf(wp.str("name").ifEmpty { WriteFormats.sanitizeName(wb.chain?.name ?: "output") }) }
    var quality by remember { mutableFloatStateOf(wp.num("quality", 0.95).toFloat()) }
    val fps = wp.num("fps", 0.0)
    AlertDialog(onDismissRequest = onDismiss, title = { Text(if (writer != null) (if (isVideoWriter) "Write Video" else "Write Images") else "Export") },
        confirmButton = { TextButton(onClick = {
            val count = when (range) { "current" -> 1; "inout" -> ((wb.outPoint ?: n - 1) - (wb.inPoint ?: 0) + 1); else -> n }
            val (file, mime, _) = WriteFormats.outputFile(format, name, count)
            // a writer filter writes what reaches it: the output of the filter before it
            val filterId = writer?.let { w -> wb.chain?.filters?.let { fs -> fs.getOrNull(fs.indexOfFirst { it.id == w.id } - 1)?.id } }
            onGo(ExportRequest(format, range, name, fps, quality.toDouble(), filterId), file, mime)
        }) { Text("Choose location…") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        text = { Column(Modifier.verticalScroll(rememberScrollState())) {
            if (writer == null && n > 1) Row { FilterChip(video, { video = true }, { Text("Video") }); Spacer(Modifier.width(8.dp)); FilterChip(!video, { video = false }, { Text("Images") }) }
            Text("Format", fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
            formats.forEach { f -> Row(verticalAlignment = Alignment.CenterVertically) { RadioButton(format == f, { format = f }); Text(WriteFormats.label(f, video), fontSize = 13.sp) } }
            if (lossless) Text("Lossy formats are hidden (Settings › Lossless exports only).", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (WriteFormats.of(format)?.lossy == true) { Text("Quality %.2f".format(quality), fontSize = 12.sp); Slider(quality, { quality = it }, valueRange = 0.1f..1f) }
            Text("Frames", fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
            listOf("current" to "Current frame (${wb.frame})", "all" to "All $n frames", "inout" to "In/Out range (${wb.inPoint ?: 0}–${wb.outPoint ?: (n - 1)})").filter { video.not() || it.first != "current" }.forEach { (k, l) ->
                Row(verticalAlignment = Alignment.CenterVertically) { RadioButton(range == k, { range = k }); Text(l, fontSize = 13.sp) }
            }
            OutlinedTextField(name, { name = it }, label = { Text("File name") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
            Text("Lossless exports are read back after writing and compared sample by sample. Several images are packaged in one ZIP (stored).", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
        } })
}

@Composable
private fun ExportProgressDialog(wb: Workbench) {
    AlertDialog(onDismissRequest = {}, confirmButton = { TextButton(onClick = { wb.cancelExport() }) { Text("Cancel") } }, title = { Text("Exporting…") },
        text = { Column { LinearProgressIndicator({ wb.exportProgress.toFloat() }, Modifier.fillMaxWidth()); Spacer(Modifier.height(6.dp)); Text("%.0f %%".format(wb.exportProgress * 100)) } })
}

@Composable
private fun CaseDialog(wb: Workbench, onDismiss: () -> Unit) {
    val c = wb.project.caseInfo
    var name by remember { mutableStateOf(wb.project.name) }
    var num by remember { mutableStateOf(c.caseNumber) }; var ex by remember { mutableStateOf(c.examiner) }; var ag by remember { mutableStateOf(c.agency) }
    var exh by remember { mutableStateOf(c.exhibit) }; var notes by remember { mutableStateOf(c.notes) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Case Information") },
        confirmButton = { TextButton(onClick = { wb.setCaseInfo(CaseInfo(num, ex, ag, exh, notes), name); onDismiss() }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            OutlinedTextField(name, { name = it }, label = { Text("Project name") }, singleLine = true)
            OutlinedTextField(num, { num = it }, label = { Text("Case number") }, singleLine = true)
            OutlinedTextField(ex, { ex = it }, label = { Text("Examiner") }, singleLine = true)
            OutlinedTextField(ag, { ag = it }, label = { Text("Agency") }, singleLine = true)
            OutlinedTextField(exh, { exh = it }, label = { Text("Exhibit") }, singleLine = true)
            OutlinedTextField(notes, { notes = it }, label = { Text("Notes") }, minLines = 3)
        } })
}

@Composable
private fun SettingsDialog(wb: Workbench, onDismiss: () -> Unit) {
    val p = wb.prefs
    var threads by remember { mutableIntStateOf(p.threads) }
    var cache by remember { mutableIntStateOf(p.cacheMB) }
    var lossless by remember { mutableStateOf(p.losslessOnly) }
    var auto by remember { mutableStateOf(p.autoSave) }
    var hash by remember { mutableStateOf(p.hashOnLoad) }
    var theme by remember { mutableStateOf(p.theme) }
    var layout by remember { mutableStateOf(p.layout) }
    @Composable fun <T> choice(label: String, opts: List<Pair<T, String>>, v: T, set: (T) -> Unit) {
        Text(label, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) { opts.forEach { (k, l) -> FilterChip(v == k, { set(k) }, { Text(l, fontSize = 12.sp) }, Modifier.padding(end = 6.dp)) } }
    }
    @Composable fun toggle(label: String, v: Boolean, set: (Boolean) -> Unit) = Row(verticalAlignment = Alignment.CenterVertically) { Text(label, Modifier.weight(1f), fontSize = 13.sp); Switch(v, set) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Settings") },
        confirmButton = { TextButton(onClick = {
            p.threads = threads; p.cacheMB = cache; p.losslessOnly = lossless; p.autoSave = auto; p.hashOnLoad = hash; p.theme = theme; p.layout = layout
            wb.themeName = theme; wb.layoutPref = layout; wb.applyPrefs(); wb.requestRender(); onDismiss()
        }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        text = { Column(Modifier.verticalScroll(rememberScrollState())) {
            choice("Processing threads (this device has ${Par.available} cores)", listOf(0 to "Auto") + (1..8).map { it to "$it" }, threads) { threads = it }
            choice("Frame cache (memory available to the app: ${Runtime.getRuntime().maxMemory() / 1048576} MB)", listOf(0 to "Auto (25%)", 256 to "256 MB", 512 to "512 MB", 1024 to "1 GB", 2048 to "2 GB"), cache) { cache = it }
            choice("Theme", listOf("midnight" to "Night", "classic" to "Daylight", "system" to "System"), theme) { theme = it }
            choice("Layout", listOf("auto" to "Automatic (fold aware)", "phone" to "Phone", "dual" to "Two panes"), layout) { layout = it }
            toggle("Lossless exports only", lossless) { lossless = it }
            toggle("Hash media when loading (MD5, SHA-1, SHA-256)", hash) { hash = it }
            toggle("Keep the session (restore after the app is closed)", auto) { auto = it }
        } })
}

@Composable
private fun AboutDialog(onDismiss: () -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, confirmButton = { TextButton(onClick = onDismiss) { Text("OK") } },
        title = { Row(verticalAlignment = Alignment.CenterVertically) { BrandBadge(40.dp); Spacer(Modifier.width(8.dp)); Text("ClearUFO Forensics") } },
        text = { Column(Modifier.verticalScroll(rememberScrollState())) {
            Text("Paranormal video forensics — native Android edition ${BuildConfig.VERSION_NAME}")
            Spacer(Modifier.height(6.dp))
            Text("${FILTER_LIST.size} filters in ${CATEGORIES.size} categories. Everything runs on the device: Kotlin processing engine on all CPU cores (32-bit float pipeline), hardware video decoding and encoding (MediaCodec) with ClearUFO's own YUV → RGB conversion, exact PNG/TIFF codecs, PDF reports. No network access.", fontSize = 13.sp)
            Spacer(Modifier.height(6.dp))
            Text("Device: ${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("Projects (.lfp) are compatible with the ClearUFO browser workbench.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } })
}

@Composable
private fun HelpDialog(onDismiss: () -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, confirmButton = { TextButton(onClick = onDismiss) { Text("OK") } }, title = { Text("Quick Start") },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("1. Load — open an image, a video (MP4, MOV, MKV, WebM, 3GP, TS, AVI, raw H.264/HEVC) or an image sequence. Each file becomes a chain. The file is hashed and never modified.", fontSize = 13.sp)
            Text("2. Process — in Filters, tap + to add a filter after the one selected in History.", fontSize = 13.sp)
            Text("3. Configure — adjust it in Settings. Regions, lines and points are drawn on the viewer (Draw on viewer).", fontSize = 13.sp)
            Text("4. Review — tap any step in History to see its output; use the player, Show Input and the Tools (histogram, frame analysis, file info, pixel inspector).", fontSize = 13.sp)
            Text("5. Export — write video or images (lossless formats are verified after writing) and generate a PDF report documenting the evidence hashes and every processing step.", fontSize = 13.sp)
            Text("Gestures: pinch to zoom, drag to pan, double-tap = fit ↔ 100%.", fontSize = 13.sp)
            Text("Galaxy Z Fold: the cover screen uses a compact layout; unfolded, the viewer and two panel groups share the screen; half-folded (Flex mode) the image stays above or beside the hinge and the controls on the other half.", fontSize = 13.sp)
        } })
}

/** ACTION_CREATE_DOCUMENT with the file name and MIME type chosen at launch (the export format decides both). */
class CreateDoc : androidx.activity.result.contract.ActivityResultContract<Pair<String, String>, Uri?>() {
    override fun createIntent(context: android.content.Context, input: Pair<String, String>) =
        android.content.Intent(android.content.Intent.ACTION_CREATE_DOCUMENT).addCategory(android.content.Intent.CATEGORY_OPENABLE).setType(input.second).putExtra(android.content.Intent.EXTRA_TITLE, input.first)
    override fun parseResult(resultCode: Int, intent: android.content.Intent?): Uri? = if (resultCode == Activity.RESULT_OK) intent?.data else null
}
