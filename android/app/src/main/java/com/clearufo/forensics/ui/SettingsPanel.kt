package com.clearufo.forensics.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clearufo.forensics.engine.*
import com.clearufo.forensics.engine.kernels.curveFunction
import com.clearufo.forensics.engine.kernels.psfForFilter
import com.clearufo.forensics.project.FilterInstance
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Filter Settings: an editor for every parameter of the selected filter. */
@Composable
fun SettingsPanel(wb: Workbench, onWrite: (FilterInstance) -> Unit, onPickImage: (String, String) -> Unit, onRelink: (String) -> Unit, onShowViewer: () -> Unit) {
    val f = wb.selectedFilter
    val def = f?.let { FILTERS[it.type] }
    if (f == null || def == null) { Text("Select a filter in History to edit its settings.", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant); return }
    val p = normalizeParams(def, f.params)
    val chain = wb.chain
    val first = chain?.filters?.firstOrNull()?.id == f.id
    var tab by remember(f.id) { mutableIntStateOf(0) }
    Column(Modifier.fillMaxSize()) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 12.dp, end = 4.dp, top = 6.dp)) {
            Column(Modifier.weight(1f)) {
                Text(def.name, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                Text(def.category, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (!first) { Text("On", fontSize = 12.sp); Switch(f.enabled, { wb.toggleFilter(f.id) }, Modifier.padding(start = 4.dp)) }
        }
        Text(def.description, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 12.dp))
        if (def.tabs.size > 1) SecondaryTabRow(selectedTabIndex = tab) { def.tabs.forEachIndexed { i, t -> Tab(tab == i, { tab = i }, text = { Text(t, fontSize = 13.sp) }) } }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp)) {
            val tabName = def.tabs.getOrNull(tab)
            for (d in def.params) {
                val inTab = (d.tab ?: def.tabs.first()) == tabName
                if (!inTab || !d.visible(p)) continue
                ParamEditor(wb, f, def, d, p, onWrite, onPickImage, onRelink, onShowViewer)
            }
            def.hint?.let { if (tab == 0) Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 10.dp)) }
            def.reference?.let { if (tab == 0) Text(it, fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp)) }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun Label(d: ParamDef, value: String? = null) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp)) {
        Text(d.label, fontSize = 13.sp, modifier = Modifier.weight(1f))
        if (value != null) Text(value, style = monoSmall)
    }
    d.help?.let { Text(it, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, lineHeight = 14.sp) }
}

@Composable
private fun ParamEditor(wb: Workbench, f: FilterInstance, def: FilterDef, d: ParamDef, p: Params, onWrite: (FilterInstance) -> Unit, onPickImage: (String, String) -> Unit, onRelink: (String) -> Unit, onShowViewer: () -> Unit) {
    val set: (Any?) -> Unit = { wb.setParam(f.id, d.key, it) }
    val chainName: (String) -> String = { id -> wb.project.chains.firstOrNull { it.id == id }?.name ?: id }
    when (d) {
        is NumberParam -> NumberEditor(wb, d, p.num(d.key, d.default), set)
        is SelectParam -> {
            Label(d)
            var open by remember { mutableStateOf(false) }
            ExposedDropdownMenuBox(open, { open = it }) {
                OutlinedTextField(d.options.firstOrNull { it.first == p.str(d.key) }?.second ?: p.str(d.key), {}, readOnly = true, singleLine = true,
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(open) }, modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable), textStyle = LocalTextStyle.current.copy(fontSize = 14.sp))
                ExposedDropdownMenu(open, { open = false }) { d.options.forEach { (k, l) -> DropdownMenuItem({ Text(l) }, { set(k); open = false }) } }
            }
        }
        is BoolParam -> Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { set(!p.bool(d.key)) }.padding(top = 4.dp)) {
            Column(Modifier.weight(1f)) { Text(d.label, fontSize = 13.sp); d.help?.let { Text(it, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
            Switch(p.bool(d.key), { set(it) })
        }
        is ColorParam -> { Label(d, p.str(d.key)); ColorEditor(p.str(d.key, d.default), set) }
        is TextParam -> {
            Label(d)
            var t by remember(f.id, d.key) { mutableStateOf(p.str(d.key)) }
            OutlinedTextField(t, { t = it; set(it) }, singleLine = !d.multiline, minLines = if (d.multiline) 2 else 1, modifier = Modifier.fillMaxWidth())
        }
        is RectParam, is PointParam, is PointsParam, is LineParam -> {
            Label(d, d.format(p[d.key]))
            val editing = wb.edit?.filterId == f.id && wb.edit?.key == d.key
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTonalButton(onClick = { wb.edit = if (editing) null else EditTarget(f.id, d.key); wb.requestRender(); if (!editing) onShowViewer() }) {
                    Icon(if (editing) Icons.Filled.Check else Icons.Outlined.Draw, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(if (editing) "Done" else "Draw on viewer")
                }
                OutlinedButton(onClick = { set(d.default) }, enabled = p[d.key] != null && p[d.key] != d.default) { Text("Clear") }
            }
        }
        is FrameParam -> {
            val v = p.num(d.key, d.default)
            Label(d, if (v == -1.0 && d.allowLast) "Last" else jsRound(v).toString())
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                IntField(jsRound(v), Modifier.weight(1f)) { set(it.toDouble()) }
                FilledTonalButton(onClick = { set(wb.render?.meta?.src?.toDouble() ?: wb.frame.toDouble()) }) { Text("Current") }
                if (d.allowLast) OutlinedButton(onClick = { set(-1.0) }) { Text("Last") }
            }
            Text("Frame numbers refer to the input of this filter; \"Current\" takes the frame shown in the viewer.", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        is ChainParam -> {
            Label(d)
            var open by remember { mutableStateOf(false) }
            val others = wb.project.chains.filter { it.id != wb.chainId }
            ExposedDropdownMenuBox(open, { open = it }) {
                OutlinedTextField(p.str(d.key).let { if (it.isEmpty()) "Select a chain" else chainName(it) }, {}, readOnly = true, singleLine = true, trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(open) }, modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable))
                ExposedDropdownMenu(open, { open = false }) {
                    if (others.isEmpty()) DropdownMenuItem({ Text("Open a second file first") }, { open = false })
                    others.forEach { c -> DropdownMenuItem({ Text(c.name) }, { set(c.id); open = false }) }
                }
            }
        }
        is ChainsParam -> {
            Label(d)
            val sel = p.strs(d.key)
            wb.project.chains.filter { it.id != wb.chainId }.forEach { c ->
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { set(if (c.id in sel) sel - c.id else sel + c.id) }) {
                    Checkbox(c.id in sel, { set(if (it) sel + c.id else sel - c.id) }); Text(c.name)
                }
            }
            if (wb.project.chains.size < 2) Text("Open more files to combine their chains.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        is CurveParam -> { Label(d); CurveEditor(wb, p.pts(d.key).ifEmpty { d.default }, set) }
        is SourceParam -> {
            val id = p.str(d.key)
            val ref = wb.project.sources[id]
            Label(d)
            Text(ref?.name ?: if (id.isEmpty()) "—" else "missing media", fontSize = 13.sp)
            if (id.isNotEmpty()) TextButton(onClick = { onRelink(id) }) { Icon(Icons.Outlined.Link, null, Modifier.size(18.dp)); Text(" Relink / replace file…") }
        }
        is ImageParam -> {
            Label(d)
            val id = p.str(d.key)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(wb.project.sources[id]?.name ?: "No image", Modifier.weight(1f), fontSize = 13.sp)
                FilledTonalButton(onClick = { onPickImage(f.id, d.key) }) { Text("Choose…") }
            }
        }
        is ActionParam -> {
            Spacer(Modifier.height(8.dp))
            Button(onClick = {
                when (d.action) {
                    "write" -> onWrite(f)
                    "autoLevels" -> wb.autoLevels(f.id)
                    "addCurrentFrame" -> { val cur = wb.render?.meta?.src ?: wb.frame; val t = p.str("frames").trim(); wb.setParam(f.id, "frames", if (t.isEmpty()) "$cur" else "$t, $cur") }
                    else -> wb.toast("${d.label} is not available on Android.")
                }
            }, modifier = Modifier.fillMaxWidth()) { Text(d.label) }
        }
        is PsfParam -> PsfPreview(f.type, p)
        is FileInfoParam -> FileInfoView(wb)
    }
}

@Composable
private fun NumberEditor(wb: Workbench, d: NumberParam, v: Double, set: (Any?) -> Unit) {
    val fmt = if (d.isInt) jsRound(v).toString() else "%.${d.decimals}f".format(v)
    Label(d, fmt)
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (d.slider) {
            // log sliders: equal steps per decade (gamma, noise)
            val lo = d.min; val hi = d.max
            fun toS(x: Double) = if (d.log && lo > 0) (ln(x / lo) / ln(hi / lo)).toFloat() else ((x - lo) / (hi - lo)).toFloat()
            fun fromS(s: Float): Double { val x = if (d.log && lo > 0) lo * exp(s * ln(hi / lo)) else lo + s * (hi - lo); return if (d.isInt) Math.round(x).toDouble() else x }
            Slider(toS(v.coerceIn(lo, hi)).coerceIn(0f, 1f), { wb.beginEdit(); set(fromS(it)) }, onValueChangeFinished = { wb.endEdit() }, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(6.dp))
        }
        // the text follows the value except while it is being typed
        var t by remember { mutableStateOf(fmt) }
        var focused by remember { mutableStateOf(false) }
        LaunchedEffect(fmt, focused) { if (!focused) t = fmt }
        OutlinedTextField(t, { s -> t = s; s.replace(',', '.').toDoubleOrNull()?.let { x -> set((if (d.isInt) Math.round(x).toDouble() else x).coerceIn(d.min, d.max)) } },
            singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), textStyle = monoSmall.copy(fontSize = 13.sp),
            modifier = (if (d.slider) Modifier.width(96.dp) else Modifier.fillMaxWidth()).onFocusChanged { focused = it.isFocused })
    }
}

@Composable
private fun IntField(v: Int, modifier: Modifier, onSet: (Int) -> Unit) {
    var t by remember(v) { mutableStateOf(v.toString()) }
    OutlinedTextField(t, { s -> t = s; s.toIntOrNull()?.let(onSet) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = modifier, textStyle = monoSmall.copy(fontSize = 13.sp))
}

private val SWATCHES = listOf("#ffffff", "#000000", "#ff2020", "#ffd400", "#00ff66", "#00e0ff", "#2060ff", "#ff40ff", "#c0c0c0", "#202020")

@Composable
private fun ColorEditor(hex: String, set: (Any?) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        SWATCHES.forEach { s ->
            val c = parseColor(s)
            Box(Modifier.size(28.dp).background(Color(c[0], c[1], c[2]), CircleShape).border(if (s.equals(hex, true)) 3.dp else 1.dp, if (s.equals(hex, true)) Pal.gold else Color.Gray, CircleShape).clickable { set(s) })
        }
    }
    var t by remember(hex) { mutableStateOf(hex) }
    OutlinedTextField(t, { s -> t = s; if (Regex("^#?[0-9a-fA-F]{6}$").matches(s)) set(if (s.startsWith("#")) s else "#$s") }, singleLine = true, label = { Text("Hex") }, modifier = Modifier.width(150.dp).padding(top = 4.dp))
}

/** Curve editor: tap to add a point, drag to move, double-tap a point to remove it. */
@Composable
private fun CurveEditor(wb: Workbench, pts: List<Pt>, set: (Any?) -> Unit) {
    val cur by rememberUpdatedState(pts)
    val outline = MaterialTheme.colorScheme.outline
    Box(Modifier.fillMaxWidth().aspectRatio(1f).padding(vertical = 6.dp).border(1.dp, outline)) {
        var drag by remember { mutableIntStateOf(-1) }
        Canvas(Modifier.fillMaxSize()
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = { o -> val x = (o.x / size.width * 255.0).coerceIn(0.0, 255.0); val y = (255 - o.y / size.height * 255.0).coerceIn(0.0, 255.0); set((cur + Pt(Math.round(x).toDouble(), Math.round(y).toDouble())).sortedBy { it.x }) },
                    onDoubleTap = { o -> val i = cur.indexOfFirst { abs(it.x / 255 * size.width - o.x) < 40 && abs((255 - it.y) / 255 * size.height - o.y) < 40 }; if (i >= 0 && cur.size > 2) set(cur.filterIndexed { k, _ -> k != i }) },
                )
            }
            .pointerInput(Unit) {
                detectDragGestures(onDragStart = { o -> drag = cur.indexOfFirst { abs(it.x / 255 * size.width - o.x) < 48 && abs((255 - it.y) / 255 * size.height - o.y) < 48 }; if (drag >= 0) wb.beginEdit() },
                    onDragEnd = { drag = -1; wb.endEdit() }, onDragCancel = { drag = -1; wb.endEdit() }) { ch, _ ->
                    if (drag >= 0) {
                        val x = (ch.position.x / size.width * 255.0).coerceIn(0.0, 255.0); val y = (255 - ch.position.y / size.height * 255.0).coerceIn(0.0, 255.0)
                        set(cur.mapIndexed { k, q -> if (k == drag) Pt(Math.round(x).toDouble(), Math.round(y).toDouble()) else q })
                    }
                }
            }) {
            for (k in 1..3) { val g = k / 4f; drawLine(outline, Offset(g * size.width, 0f), Offset(g * size.width, size.height)); drawLine(outline, Offset(0f, g * size.height), Offset(size.width, g * size.height)) }
            drawLine(outline, Offset(0f, size.height), Offset(size.width, 0f))
            val fn = curveFunction(cur)
            val path = Path()
            for (i in 0..128) { val x = i / 128.0 * 255; val y = fn(x).coerceIn(0.0, 255.0); val px = (x / 255 * size.width).toFloat(); val py = ((255 - y) / 255 * size.height).toFloat(); if (i == 0) path.moveTo(px, py) else path.lineTo(px, py) }
            drawPath(path, Pal.gold, style = Stroke(3f))
            cur.forEach { q -> drawCircle(Color.White, 9f, Offset((q.x / 255 * size.width).toFloat(), ((255 - q.y) / 255 * size.height).toFloat())) }
        }
    }
    TextButton(onClick = { set(listOf(Pt(0.0, 0.0), Pt(255.0, 255.0))) }) { Text("Reset curve") }
}

@Composable
private fun PsfPreview(type: String, p: Params) {
    val psf = remember(type, p) { psfForFilter(type, p) } ?: run { Text("Point spread function: draw the blur first.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp)); return }
    val bmp = remember(psf) {
        val mx = psf.d.maxOrNull()?.takeIf { it > 0 } ?: 1f
        val px = IntArray(psf.w * psf.h) { val v = (psf.d[it] / mx * 255).roundToInt().coerceIn(0, 255); (0xff shl 24) or (v shl 16) or (v shl 8) or v }
        android.graphics.Bitmap.createBitmap(px, psf.w, psf.h, android.graphics.Bitmap.Config.ARGB_8888).asImageBitmap()
    }
    Text("Point Spread Function (${psf.w}×${psf.h})", fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
    Canvas(Modifier.size(min(160, max(64, psf.w * 6)).dp).background(Color.Black)) {
        drawImage(bmp, dstSize = androidx.compose.ui.unit.IntSize(size.width.toInt(), size.height.toInt()), filterQuality = androidx.compose.ui.graphics.FilterQuality.None)
    }
}

