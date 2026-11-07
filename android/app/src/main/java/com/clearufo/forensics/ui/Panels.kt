package com.clearufo.forensics.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clearufo.forensics.engine.*
import com.clearufo.forensics.media.SourceInfo
import com.clearufo.forensics.media.fmtBytes
import com.clearufo.forensics.engine.filters.fmtTime
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.max

// ---------------------------------------------------------------- player
val SPEEDS = listOf(0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0)

@Composable
fun PlayerBar(wb: Workbench, compact: Boolean, modifier: Modifier = Modifier) {
    val r = wb.render
    val n = r?.info?.frameCount ?: 0
    Surface(color = MaterialTheme.colorScheme.surfaceContainer, modifier = modifier) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 2.dp)) {
            if (n > 1) {
                var drag by remember { mutableStateOf<Float?>(null) }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(fmtTime(r?.meta?.pts ?: 0.0), style = monoSmall, modifier = Modifier.width(78.dp))
                    Slider(
                        value = drag ?: wb.frame.toFloat(), valueRange = 0f..(n - 1).toFloat(),
                        onValueChange = { drag = it; wb.seek(it.toInt()) }, onValueChangeFinished = { drag = null },
                        modifier = Modifier.weight(1f).height(32.dp),
                    )
                    Text("${wb.frame}", style = monoSmall, modifier = Modifier.width(48.dp), maxLines = 1)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                val enabled = n > 1
                IconButton(onClick = { wb.stop(); wb.seek(wb.inPoint ?: 0) }, enabled = enabled) { Icon(Icons.Filled.SkipPrevious, "First frame") }
                IconButton(onClick = { wb.stop(); wb.seek(wb.frame - 1) }, enabled = enabled) { Icon(Icons.Filled.ChevronLeft, "Previous frame") }
                FilledIconButton(onClick = { wb.togglePlay() }, enabled = enabled) { Icon(if (wb.playing) Icons.Filled.Pause else Icons.Filled.PlayArrow, "Play / pause") }
                IconButton(onClick = { wb.stop(); wb.seek(wb.frame + 1) }, enabled = enabled) { Icon(Icons.Filled.ChevronRight, "Next frame") }
                IconButton(onClick = { wb.stop(); wb.seek(wb.outPoint ?: (n - 1)) }, enabled = enabled) { Icon(Icons.Filled.SkipNext, "Last frame") }
                var speedMenu by remember { mutableStateOf(false) }
                Box {
                    TextButton(onClick = { speedMenu = true }, enabled = enabled) { Text("${fmtSpeed(wb.speed)}×", style = monoSmall) }
                    DropdownMenu(speedMenu, { speedMenu = false }) { SPEEDS.forEach { s -> DropdownMenuItem({ Text("${fmtSpeed(s)}×") }, { wb.speed = s; speedMenu = false }) } }
                }
                TextButton(onClick = { wb.inPoint = if (wb.inPoint == wb.frame) null else wb.frame }, enabled = enabled) { Text(if (wb.inPoint != null) "In ${wb.inPoint}" else "Set In", fontSize = 12.sp) }
                TextButton(onClick = { wb.outPoint = if (wb.outPoint == wb.frame) null else wb.frame }, enabled = enabled) { Text(if (wb.outPoint != null) "Out ${wb.outPoint}" else "Set Out", fontSize = 12.sp) }
                IconButton(onClick = { wb.addBookmark("") }, enabled = r != null) { Icon(Icons.Outlined.BookmarkAdd, "Add bookmark") }
                if (!compact && r != null) Text("%.3f fps".format(r.info.fps), style = monoSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 6.dp))
            }
        }
    }
}

fun fmtSpeed(v: Double) = if (v >= 1) v.toInt().toString() else v.toString().trimEnd('0')

// ---------------------------------------------------------------- filters browser
@Composable
fun FiltersPanel(wb: Workbench, onAdded: () -> Unit) {
    var q by remember { mutableStateOf("") }
    var cat by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<FilterDef?>(null) }
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(q, { q = it }, singleLine = true, placeholder = { Text("Quick search (${FILTER_LIST.count { it.kind != FilterKind.LOADER }} filters)") },
            leadingIcon = { Icon(Icons.Outlined.Search, null) }, trailingIcon = { if (q.isNotEmpty()) IconButton(onClick = { q = "" }) { Icon(Icons.Filled.Close, "Clear") } },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), modifier = Modifier.fillMaxWidth().padding(6.dp))
        val list = when {
            q.isNotBlank() -> FILTER_LIST.filter { it.kind != FilterKind.LOADER && (it.name.contains(q, true) || it.description.contains(q, true) || it.category.contains(q, true)) }
            cat != null -> filtersInCategory(cat!!).filter { it.kind != FilterKind.LOADER }
            else -> null
        }
        if (list == null) {
            LazyColumn(Modifier.fillMaxSize()) {
                items(CATEGORIES.filter { c -> c.name != "Load" }) { c ->
                    ListItem(headlineContent = { Text(c.name) }, supportingContent = { Text(c.description, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        trailingContent = { Text("${filtersInCategory(c.name).size}", color = MaterialTheme.colorScheme.onSurfaceVariant) },
                        modifier = Modifier.clickable { cat = c.name })
                }
            }
        } else {
            if (cat != null && q.isBlank()) Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { cat = null }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Categories") }
                Text(cat!!, fontWeight = FontWeight.Bold)
            }
            LazyColumn(Modifier.fillMaxSize()) {
                items(list, key = { it.id }) { f ->
                    ListItem(
                        headlineContent = { Text(f.name) },
                        supportingContent = { Text(f.description, maxLines = 2, overflow = TextOverflow.Ellipsis, fontSize = 12.sp) },
                        overlineContent = if (q.isNotBlank()) ({ Text(f.category) }) else null,
                        trailingContent = { FilledTonalIconButton(onClick = { wb.addFilter(f.id); onAdded() }) { Icon(Icons.Filled.Add, "Add ${f.name}") } },
                        modifier = Modifier.combinedClickable(onClick = { info = f }, onDoubleClick = { wb.addFilter(f.id); onAdded() }),
                    )
                }
            }
        }
    }
    info?.let { f ->
        AlertDialog(onDismissRequest = { info = null }, confirmButton = { TextButton(onClick = { wb.addFilter(f.id); info = null; onAdded() }) { Text("Add") } },
            dismissButton = { TextButton(onClick = { info = null }) { Text("Close") } }, title = { Text(f.name) },
            text = { Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(f.description); f.hint?.let { Spacer(Modifier.height(8.dp)); Text(it, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                f.reference?.let { Spacer(Modifier.height(8.dp)); Text(it, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                if (f.temporal) Text("Uses several frames per output frame.", fontSize = 12.sp, color = Pal.warn)
            } })
    }
}

// ---------------------------------------------------------------- history (chains and their filters)
@Composable
fun HistoryPanel(wb: Workbench, onRelink: (String) -> Unit, onEditSettings: () -> Unit) {
    val p = wb.project
    var rename by remember { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
            Row(Modifier.weight(1f).horizontalScroll(rememberScrollState())) {
                p.chains.forEach { c ->
                    FilterChip(selected = c.id == wb.chainId, onClick = { wb.selectChain(c.id) }, label = { Text(c.name, maxLines = 1) }, modifier = Modifier.padding(end = 4.dp))
                }
            }
            Box {
                IconButton(onClick = { menu = true }, enabled = wb.chain != null) { Icon(Icons.Filled.MoreVert, "Chain menu") }
                DropdownMenu(menu, { menu = false }) {
                    val c = wb.chain
                    DropdownMenuItem({ Text("Rename chain…") }, { rename = c?.name; menu = false })
                    DropdownMenuItem({ Text("Duplicate chain") }, { c?.let { wb.duplicateChain(it.id) }; menu = false })
                    DropdownMenuItem({ Text("New chain from selected filter") }, { wb.filterId?.let { wb.chainFromHere(it) }; menu = false })
                    DropdownMenuItem({ Text("Relink media…") }, { (c?.filters?.firstOrNull()?.params?.get("source") as? String)?.let(onRelink); menu = false })
                    DropdownMenuItem({ Text("Delete chain", color = Pal.err) }, { c?.let { wb.deleteChain(it.id) }; menu = false })
                }
            }
        }
        val c = wb.chain
        if (c == null) { Text("No chains yet: open an image or a video.", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant); return@Column }
        LazyColumn(Modifier.fillMaxSize()) {
            items(c.filters.size, key = { c.filters[it].id }) { i ->
                val f = c.filters[i]; val def = FILTERS[f.type]
                val selected = f.id == wb.filterId
                val failing = wb.renderError?.second == f.id
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()
                    .background(if (selected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                    .combinedClickable(onClick = { wb.selectFilter(f.id) }, onDoubleClick = { wb.selectFilter(f.id); onEditSettings() })
                    .padding(horizontal = 6.dp, vertical = 2.dp)) {
                    if (i > 0) Checkbox(f.enabled, { wb.toggleFilter(f.id) }) else Icon(Icons.Outlined.Movie, null, Modifier.padding(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("${i + 1}. ${def?.name ?: f.type}", fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal, color = if (failing) Pal.err else if (!f.enabled && i > 0) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val summary = def?.params?.filter { !it.transient && it.visible(f.params) && it !is SourceParam }?.take(3)?.joinToString(" · ") { "${it.label}: ${it.format(f.params[it.key]) { id -> wb.project.chains.firstOrNull { ch -> ch.id == id }?.name ?: id }}" }
                        val src = (f.params["source"] as? String)?.let { wb.project.sources[it]?.name }
                        Text(src ?: summary ?: "", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (selected && i > 0) {
                        IconButton(onClick = { wb.moveFilter(f.id, -1) }, enabled = i > 1) { Icon(Icons.Filled.KeyboardArrowUp, "Move up") }
                        IconButton(onClick = { wb.moveFilter(f.id, 1) }, enabled = i < c.filters.size - 1) { Icon(Icons.Filled.KeyboardArrowDown, "Move down") }
                        IconButton(onClick = { wb.removeFilter(f.id) }) { Icon(Icons.Outlined.Delete, "Remove filter") }
                    }
                }
            }
            item { if (wb.project.bookmarks.any { it.chainId == c.id }) {
                Text("Bookmarks", fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 12.dp, top = 12.dp))
                wb.project.bookmarks.filter { it.chainId == c.id }.forEach { b ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { wb.seek(b.frame) }.padding(horizontal = 12.dp)) {
                        Icon(Icons.Outlined.Bookmark, null, Modifier.size(18.dp)); Text(" Frame ${b.frame} ${b.note}", Modifier.weight(1f), fontSize = 13.sp)
                        IconButton(onClick = { wb.removeBookmark(b.id) }) { Icon(Icons.Outlined.Close, "Remove bookmark", Modifier.size(18.dp)) }
                    }
                }
            } }
        }
    }
    rename?.let { cur -> TextInputDialog("Rename Chain", cur, { rename = null }) { wb.chainId?.let { id -> wb.renameChain(id, it) }; rename = null } }
}

// ---------------------------------------------------------------- tools: histogram, frame analysis, file info
@Composable
fun ToolsPanel(wb: Workbench) {
    var tab by remember { mutableIntStateOf(0) }
    Column(Modifier.fillMaxSize()) {
        SecondaryScrollableTabRow(selectedTabIndex = tab, edgePadding = 4.dp) {
            listOf("Histogram", "Frame Analysis", "File Info", "Pixel").forEachIndexed { i, t -> Tab(tab == i, { tab = i }, text = { Text(t, fontSize = 13.sp) }) }
        }
        Box(Modifier.fillMaxSize().padding(8.dp)) {
            when (tab) { 0 -> HistogramView(wb); 1 -> FrameAnalysis(wb); 2 -> FileInfoView(wb, Modifier.verticalScroll(rememberScrollState())); else -> PixelHelp(wb) }
        }
    }
}

@Composable
private fun HistogramView(wb: Workbench) {
    val r = wb.render ?: run { Text("No image."); return }
    val hist by produceState<Array<IntArray>?>(null, r.frame) {
        value = withContext(Dispatchers.Default) {
            val h = Array(4) { IntArray(256) }; val d = r.frame.d
            var i = 0
            while (i < d.size) { for (c in 0 until 3) h[c][to8(d[i + c])]++; h[3][to8((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]).toFloat())]++; i += 4 }
            h
        }
    }
    var log by remember { mutableStateOf(false) }
    val h = hist ?: return
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) { Text("RGB and luma (8-bit levels)", Modifier.weight(1f), fontSize = 12.sp); Text("Log", fontSize = 12.sp); Switch(log, { log = it }) }
        Canvas(Modifier.fillMaxWidth().height(150.dp).border(1.dp, MaterialTheme.colorScheme.outline)) {
            val cols = listOf(Color(0xCCFF4040), Color(0xCC40FF40), Color(0xCC4080FF), Color(0xFFEEEEEE))
            fun v(x: Int) = if (log) kotlin.math.ln(1.0 + x) else x.toDouble()
            val mx = h.maxOf { a -> a.maxOf { v(it) } }.coerceAtLeast(1.0)
            for (c in 0 until 4) {
                val p = Path()
                for (k in 0 until 256) { val x = k / 255f * size.width; val y = size.height - (v(h[c][k]) / mx * size.height).toFloat(); if (k == 0) p.moveTo(x, y) else p.lineTo(x, y) }
                drawPath(p, cols[c], style = Stroke(if (c == 3) 2f else 1.5f))
            }
        }
        val n = r.frame.w * r.frame.h
        fun stats(c: Int): String { var s = 0.0; var mn = 255; var mx = 0; for (k in 0 until 256) { s += k.toDouble() * h[c][k]; if (h[c][k] > 0) { mn = minOf(mn, k); mx = maxOf(mx, k) } }; return "mean %.1f  min %d  max %d".format(s / n, mn, mx) }
        listOf("R", "G", "B", "Y").forEachIndexed { c, l -> Text("$l  ${stats(c)}", style = monoSmall) }
        val clipped = h[0][255] + h[1][255] + h[2][255]
        if (clipped > 0) Text("Clipped highlights: $clipped samples at 255", fontSize = 11.sp, color = Pal.warn)
    }
}

@Composable
private fun FrameAnalysis(wb: Workbench) {
    val r = wb.render ?: run { Text("No video."); return }
    val n = r.info.frameCount
    val c = wb.chain
    val src = (c?.filters?.firstOrNull()?.params?.get("source") as? String)?.let { wb.engine.sources[it] }
    if (src == null || src.info.frameCount <= 1) { Text("Frame analysis shows the GOP structure (frame types and coded sizes) of a video source.", fontSize = 13.sp); return }
    val m = src.info.frameCount
    val metas = remember(src, src.info.frameTypesReady) { (0 until m).map { src.meta(it) } }
    val maxBytes = max(1, metas.maxOf { it.bytes })
    val counts = metas.groupingBy { it.type }.eachCount()
    Column {
        Text("Source frames: $m · I ${counts['I'] ?: 0} · P ${counts['P'] ?: 0} · B ${counts['B'] ?: 0}${if ((counts['?'] ?: 0) > 0) " · unknown ${counts['?']}" else ""}${if (!src.info.frameTypesReady) " (analyzing…)" else ""}", fontSize = 12.sp)
        Text("Bars: coded frame size; red I, green P, blue B. Tap to jump (source frame index).", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        val sel = r.meta.src ?: wb.frame
        Box(Modifier.fillMaxWidth().height(120.dp).border(1.dp, MaterialTheme.colorScheme.outline)) {
            Canvas(Modifier.fillMaxSize().clickable { }) {
                val bw = size.width / m
                for (i in 0 until m) {
                    val e = metas[i]; val hh = e.bytes.toFloat() / maxBytes * size.height
                    val col = when (e.type) { 'I' -> Color(0xFFFF5A52); 'P' -> Color(0xFF4CC38A); 'B' -> Color(0xFF4F8DFF); else -> Color.Gray }
                    drawRect(col, Offset(i * bw, size.height - hh), Size(max(1f, bw - if (bw > 3) 1f else 0f), hh))
                }
                drawRect(Pal.gold, Offset(sel * bw, 0f), Size(max(2f, bw), size.height), style = Stroke(2f))
            }
        }
        Text("Current: frame ${wb.frame} → source frame $sel, type ${r.meta.type}, ${r.meta.bytes} bytes${r.meta.pts?.let { ", t = %.4f s".format(it) } ?: ""}", style = monoSmall)
        if (n != m) Text("The chain output has $n frames (frame selection or rate filters).", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun FileInfoView(wb: Workbench, modifier: Modifier = Modifier) {
    val c = wb.chain ?: run { Text("No chain."); return }
    val sid = c.filters.firstOrNull()?.params?.get("source") as? String
    val si: SourceInfo? = sid?.let { wb.sourceInfos[it] }
    val ref = sid?.let { wb.project.sources[it] }
    Column(modifier) {
        if (si == null) { Text(if (sid == null) "Generated chain (no evidence file)." else "The media file is not available: relink it (History › ⋮ › Relink media).", fontSize = 13.sp); return@Column }
        @Composable fun kv(k: String, v: String?, mono: Boolean = false) { if (!v.isNullOrBlank()) Row(Modifier.padding(vertical = 2.dp)) { Text(k, Modifier.width(120.dp), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant); Text(v, style = if (mono) monoSmall else LocalTextStyle.current.copy(fontSize = 12.sp)) } }
        kv("File", si.name); kv("Size", "${fmtBytes(si.fileSize)} (${si.fileSize} bytes)${if (si.fileCount > 1) " in ${si.fileCount} files" else ""}")
        kv("MD5", ref?.md5 ?: "computing…", true); kv("SHA-1", ref?.sha1 ?: "computing…", true); kv("SHA-256", ref?.sha256 ?: "computing…", true)
        kv("Container", si.container); kv("Codec", si.codec); kv("Resolution", "${si.width} × ${si.height}${if (si.bitDepth != 8) " · ${si.bitDepth}-bit" else ""}")
        if (si.frameCount > 1) { kv("Frames", "${si.frameCount}"); kv("Frame rate", "%.4f fps".format(si.fps)); kv("Duration", fmtTime(si.duration)); kv("Timing", si.vfr ?: "constant frame rate") }
        si.bitrate?.let { kv("Bitrate", "%.0f kbit/s".format(it / 1000.0)) }
        kv("Matrix", si.colorMatrix); kv("Range", si.colorRange); kv("Transfer", si.transfer)
        if (si.rotation != 0) kv("Rotation", "${si.rotation}° (stored; not applied)")
        kv("Audio", if (si.hasAudio) si.audio else null)
        kv("Decoder", si.engine); kv("YUV → RGB", si.conversion)
        si.metadata.forEach { (k, v) -> kv(k, v) }
    }
}

@Composable
private fun PixelHelp(wb: Workbench) {
    Column {
        Text("Pixel inspector", fontWeight = FontWeight.Bold)
        Text("Turn on the eyedropper on the viewer, then tap a pixel: the float values (0–255 scale, unclamped), the 8-bit values and the BT.601 luma are shown. Pinch to zoom in to single pixels.", fontSize = 13.sp)
        Spacer(Modifier.height(8.dp))
        val r = wb.render; val p = wb.inspect
        if (r != null && p != null && p.first < r.frame.w && p.second < r.frame.h) {
            val k = (p.second * r.frame.w + p.first) * 4; val d = r.frame.d
            Text("(${p.first}, ${p.second})  R %.4f  G %.4f  B %.4f  A %.1f".format(d[k], d[k + 1], d[k + 2], d[k + 3]), style = monoSmall)
        }
        Spacer(Modifier.height(8.dp))
        Text("Frame MD5 (8-bit RGB of the current output)", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        val md5 by produceState<String?>(null, wb.render) { value = withContext(Dispatchers.Default) { wb.snapshotMd5() } }
        Text(md5 ?: "—", style = monoSmall)
    }
}

@Composable
fun TextInputDialog(title: String, initial: String, onDismiss: () -> Unit, multiline: Boolean = false, onOk: (String) -> Unit) {
    var t by remember { mutableStateOf(initial) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text(title) }, text = { OutlinedTextField(t, { t = it }, singleLine = !multiline, modifier = Modifier.fillMaxWidth()) },
        confirmButton = { TextButton(onClick = { onOk(t) }) { Text("OK") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

