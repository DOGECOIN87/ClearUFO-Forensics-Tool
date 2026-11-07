package com.clearufo.forensics.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clearufo.forensics.engine.*
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private sealed class Draft {
    data class R(val a: Offset, val b: Offset) : Draft()
    data class L(val a: Offset, val b: Offset) : Draft()
}

@Composable
fun ViewerPane(wb: Workbench, modifier: Modifier = Modifier, compact: Boolean = false, onOpen: () -> Unit, onPattern: () -> Unit, onProject: () -> Unit) {
    val r = wb.render
    var view by remember { mutableStateOf(IntSize.Zero) }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var fitted by remember { mutableStateOf(true) }
    var draft by remember { mutableStateOf<Draft?>(null) }
    val slop = LocalViewConfiguration.current.touchSlop
    val iw = r?.frame?.w ?: 0; val ih = r?.frame?.h ?: 0

    fun fit() {
        if (iw == 0 || view.width == 0) return
        scale = min(view.width.toFloat() / iw, view.height.toFloat() / ih)
        offset = Offset((view.width - iw * scale) / 2f, (view.height - ih * scale) / 2f)
        fitted = true
    }
    fun zoomAt(c: Offset, z: Float) { val ns = (scale * z).coerceIn(0.02f, 64f); offset = c - (c - offset) * (ns / scale); scale = ns; fitted = false }
    LaunchedEffect(iw, ih, view) { if (fitted || scale == 1f) fit() }

    val sel = wb.selectedFilter
    val def = sel?.let { FILTERS[it.type] }
    val edit = wb.edit
    val editDef = edit?.let { e -> def?.params?.firstOrNull { it.key == e.key } }
    // overlays are in the coordinates of the view they belong to (filter input for geometry-changing filters)
    // (only when the viewer shows the selected filter itself, or it is the last step of the chain)
    val isLast = sel != null && wb.chain?.filters?.lastOrNull { it.enabled || it === wb.chain?.filters?.first() }?.id == sel.id
    val overlaysValid = def != null && (wb.viewFilterId == sel?.id || isLast) && (def.overlayOn != "input" || wb.showingInput)

    Box(modifier.background(Color.Black).clipToBounds().onSizeChanged { view = it }) {
        if (r == null) {
            EmptyState(wb, compact, onOpen, onPattern, onProject)
        } else {
            val bmp = remember(r.bitmap) { r.bitmap.asImageBitmap() }
            var lastTap by remember { mutableLongStateOf(0L) }
            var lastTapPos by remember { mutableStateOf(Offset.Zero) }
            Canvas(Modifier.fillMaxSize().pointerInput(edit, iw, ih, wb.tool) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val start = down.position
                    fun img(p: Offset) = Offset((p.x - offset.x) / scale, (p.y - offset.y) / scale)
                    var moved = false; var multi = false
                    // grab an existing vertex of the edited parameter
                    var grab: Int = -1
                    val p0 = sel?.params
                    if (edit != null && p0 != null) {
                        val verts: List<Pt> = when (editDef) {
                            is PointsParam -> p0.pts(edit.key); is LineParam -> p0.pts(edit.key); is PointParam -> listOfNotNull(p0.pt(edit.key)); else -> emptyList()
                        }
                        grab = verts.indexOfFirst { hypot((it.x * scale + offset.x - start.x).toDouble(), (it.y * scale + offset.y - start.y).toDouble()) < 28.dp.toPx() }
                    }
                    if (grab >= 0) wb.beginEdit()
                    val dragDraws = edit != null && grab < 0 && (editDef is RectParam || editDef is LineParam)
                    do {
                        val ev = awaitPointerEvent()
                        val pressed = ev.changes.filter { it.pressed }
                        if (pressed.size >= 2) {
                            multi = true; moved = true; draft = null
                            val z = ev.calculateZoom(); val pan = ev.calculatePan(); val c = ev.calculateCentroid()
                            if (z != 1f) zoomAt(c, z)
                            offset += pan; fitted = false
                            ev.changes.forEach { it.consume() }
                        } else if (pressed.size == 1 && !multi) {
                            val ch = pressed[0]
                            if (!moved && (ch.position - start).getDistance() > slop) moved = true
                            if (moved) {
                                when {
                                    grab >= 0 && sel != null && edit != null -> {
                                        val q = img(ch.position).let { Pt(it.x.toDouble(), it.y.toDouble()) }
                                        when (editDef) {
                                            is PointParam -> wb.setParam(sel.id, edit.key, q)
                                            else -> { val l = sel.params.pts(edit.key).toMutableList(); if (grab < l.size) { l[grab] = q; wb.setParam(sel.id, edit.key, l) } }
                                        }
                                    }
                                    dragDraws -> draft = if (editDef is RectParam) Draft.R(img(start), img(ch.position)) else Draft.L(img(start), img(ch.position))
                                    else -> { offset += ch.positionChange(); fitted = false }
                                }
                                ch.consume()
                            }
                        }
                    } while (ev.changes.any { it.pressed })
                    if (grab >= 0) wb.endEdit()
                    val d = draft
                    if (d != null && sel != null && edit != null) {
                        draft = null
                        when (d) {
                            is Draft.R -> { val x0 = min(d.a.x, d.b.x).coerceIn(0f, iw.toFloat()); val y0 = min(d.a.y, d.b.y).coerceIn(0f, ih.toFloat()); val x1 = max(d.a.x, d.b.x).coerceIn(0f, iw.toFloat()); val y1 = max(d.a.y, d.b.y).coerceIn(0f, ih.toFloat())
                                if (x1 - x0 >= 2 && y1 - y0 >= 2) wb.setParam(sel.id, edit.key, RectP(x0.roundToInt().toDouble(), y0.roundToInt().toDouble(), (x1 - x0).roundToInt().toDouble(), (y1 - y0).roundToInt().toDouble())) }
                            is Draft.L -> {
                                val a = Pt(d.a.x.toDouble(), d.a.y.toDouble()); val b = Pt(d.b.x.toDouble(), d.b.y.toDouble())
                                wb.setParam(sel.id, edit.key, listOf(a, b))
                                if (sel.type == "motion_deblurring" && edit.key == "line") {
                                    wb.setParam(sel.id, "length", Math.round(hypot(b.x - a.x, b.y - a.y) * 10) / 10.0)
                                    wb.setParam(sel.id, "angle", Math.round(Math.toDegrees(atan2(-(b.y - a.y), b.x - a.x)) * 10) / 10.0)
                                }
                            }
                        }
                    } else if (!moved && !multi) {
                        val now = System.currentTimeMillis()
                        val q = img(start)
                        if (now - lastTap < 320 && (start - lastTapPos).getDistance() < 60 && edit == null && wb.tool != Tool.INSPECT) {
                            // double tap: fit ↔ 100% at the tap
                            if (fitted) { val z = 1f / scale; zoomAt(start, z) } else fit()
                            lastTap = 0
                        } else {
                            lastTap = now; lastTapPos = start
                            val inside = q.x >= 0 && q.y >= 0 && q.x < iw && q.y < ih
                            if (edit != null && sel != null && inside) {
                                val pt = Pt(q.x.toDouble(), q.y.toDouble())
                                when (editDef) {
                                    is PointParam -> wb.setParam(sel.id, edit.key, pt)
                                    is PointsParam -> { val l = sel.params.pts(edit.key); wb.setParam(sel.id, edit.key, if (l.size >= editDef.maxPoints) listOf(pt) else l + pt) }
                                    else -> {}
                                }
                            } else if (inside && (wb.tool == Tool.INSPECT || edit == null)) wb.inspect = q.x.toInt() to q.y.toInt()
                        }
                    }
                }
            }) {
                val dst = IntSize((iw * scale).roundToInt().coerceAtLeast(1), (ih * scale).roundToInt().coerceAtLeast(1))
                drawImage(bmp, dstOffset = IntOffset(offset.x.roundToInt(), offset.y.roundToInt()), dstSize = dst, filterQuality = if (scale >= 4f) FilterQuality.None else FilterQuality.High)
                if (overlaysValid && sel != null && def != null) drawOverlays(def, sel.params, edit, offset, scale)
                when (val d = draft) {
                    is Draft.R -> { val a = d.a * scale + offset; val b = d.b * scale + offset; drawRect(Pal.gold, Offset(min(a.x, b.x), min(a.y, b.y)), Size(kotlin.math.abs(b.x - a.x), kotlin.math.abs(b.y - a.y)), style = Stroke(2.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(10f, 6f)))) }
                    is Draft.L -> drawLine(Pal.gold, d.a * scale + offset, d.b * scale + offset, 2.dp.toPx())
                    null -> {}
                }
                wb.inspect?.let { (x, y) -> if (x < iw && y < ih) { val c = Offset(x * scale + offset.x + scale / 2, y * scale + offset.y + scale / 2); drawLine(Color.Cyan, c - Offset(14f, 0f), c + Offset(14f, 0f), 2f); drawLine(Color.Cyan, c - Offset(0f, 14f), c + Offset(0f, 14f), 2f) } }
            }
            ViewerHud(wb, r, scale, compact, Modifier.align(Alignment.BottomStart))
            InspectorBox(wb, r, Modifier.align(Alignment.TopStart).padding(6.dp))
            ViewerTools(wb, fitted, { fit() }, { zoomAt(Offset(view.width / 2f, view.height / 2f), 1f / scale) }, Modifier.align(Alignment.TopEnd).padding(4.dp))
        }
        // at the bottom, so the image stays visible; a tap frees the cached frames and tries again
        wb.renderError?.let { (msg, _) -> Surface(onClick = { wb.retryRender() }, color = Color(0xE6200000), shape = RoundedCornerShape(8.dp), modifier = Modifier.align(Alignment.BottomCenter).padding(start = 16.dp, end = 16.dp, bottom = 56.dp)) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) { Text(msg, color = Color.White, fontSize = 13.sp); Text("Tap to try again", color = Color.White.copy(alpha = 0.7f), fontSize = 11.sp) }
        } }
        if (edit != null && editDef != null) EditBanner(wb, editDef, Modifier.align(Alignment.TopCenter).padding(top = 6.dp))
        if (wb.rendering && !wb.playing) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter).height(2.dp), color = Pal.gold, trackColor = Color.Transparent)
    }
}

private fun DrawScope.drawOverlays(def: FilterDef, p: Map<String, Any?>, edit: EditTarget?, o: Offset, s: Float) {
    fun sp(q: Pt) = Offset((q.x * s + o.x).toFloat(), (q.y * s + o.y).toFloat())
    for (d in def.params) {
        if (!d.isOverlay || !d.visible(p)) continue
        if (d.overlayIf?.invoke(p) == false) continue
        val active = edit?.key == d.key
        val col = if (active) Pal.gold else Color(0xCCFFFFFF)
        val w = (if (active) 2.5f else 1.5f) * density
        when (d) {
            is RectParam -> (p[d.key] as? RectP)?.let { r -> drawRect(col, sp(Pt(r.x, r.y)), Size((r.w * s).toFloat(), (r.h * s).toFloat()), style = Stroke(w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(12f, 6f)))) }
            is LineParam -> p.pts(d.key).takeIf { it.size >= 2 }?.let { l -> drawLine(col, sp(l[0]), sp(l[1]), w); l.forEach { drawCircle(col, 6f * density, sp(it), style = Stroke(w)) } }
            is PointParam -> (p[d.key] as? Pt)?.let { q -> val c = sp(q); drawCircle(col, 8f * density, c, style = Stroke(w)); drawLine(col, c - Offset(12f * density, 0f), c + Offset(12f * density, 0f), w); drawLine(col, c - Offset(0f, 12f * density), c + Offset(0f, 12f * density), w) }
            is PointsParam -> {
                val l = p.pts(d.key)
                for (i in l.indices) {
                    if (i > 0 && (d.polyline || d.closed || d.maxPoints == 4)) drawLine(col, sp(l[i - 1]), sp(l[i]), w)
                    drawCircle(col, 7f * density, sp(l[i]), style = Stroke(w))
                }
                if (d.closed && l.size == d.maxPoints) drawLine(col, sp(l.last()), sp(l.first()), w)
            }
            else -> {}
        }
    }
}

@Composable
private fun EditBanner(wb: Workbench, d: ParamDef, modifier: Modifier) {
    val what = when (d) { is RectParam -> "Drag to draw the region"; is LineParam -> "Drag to draw the line"; is PointParam -> "Tap to place the point"; is PointsParam -> if (d.maxPoints == 4) "Tap the 4 corners clockwise from the top left" else "Tap to add points"; else -> "" }
    Surface(color = Color(0xEE1A1A1A), shape = RoundedCornerShape(20.dp), modifier = modifier.border(1.dp, Pal.gold, RoundedCornerShape(20.dp))) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 12.dp)) {
            Text("${d.label}: $what · drag a handle to move it · pinch to zoom", color = Color.White, fontSize = 12.sp, modifier = Modifier.widthIn(max = 520.dp))
            TextButton(onClick = { wb.edit = null; wb.requestRender() }) { Text("Done", color = Pal.gold, fontWeight = FontWeight.Bold) }
        }
    }
}

@Composable
private fun ViewerTools(wb: Workbench, fitted: Boolean, onFit: () -> Unit, on100: () -> Unit, modifier: Modifier) {
    Surface(color = Color(0x99000000), shape = RoundedCornerShape(10.dp), modifier = modifier) {
        Row {
            IconButton(onClick = { if (fitted) on100() else onFit() }) { Icon(if (fitted) Icons.Outlined.ZoomIn else Icons.Outlined.FitScreen, if (fitted) "100%" else "Fit", tint = Color.White) }
            IconButton(onClick = { wb.tool = if (wb.tool == Tool.INSPECT) Tool.POINTER else Tool.INSPECT; if (wb.tool == Tool.POINTER) wb.inspect = null }) {
                Icon(Icons.Outlined.Colorize, "Pixel inspector", tint = if (wb.tool == Tool.INSPECT) Pal.gold else Color.White)
            }
            IconButton(onClick = { wb.toggleViewFinal() }) {
                Icon(if (wb.viewFinal) Icons.Outlined.Layers else Icons.Filled.Layers, if (wb.viewFinal) "Showing the final result (tap: only up to the selected step)" else "Showing up to the selected step (tap: final result)", tint = if (wb.viewFinal) Color.White else Pal.gold)
            }
            IconButton(onClick = { wb.showInput = !wb.showInput; wb.requestRender() }) { Icon(if (wb.showInput) Icons.Filled.Compare else Icons.Outlined.Compare, "Show input of the selected filter", tint = if (wb.showInput) Pal.gold else Color.White) }
        }
    }
}

@Composable
private fun ViewerHud(wb: Workbench, r: RenderState, scale: Float, compact: Boolean, modifier: Modifier) {
    val m = r.meta
    Surface(color = Color(0x99000000), shape = RoundedCornerShape(topEnd = 8.dp), modifier = modifier) {
        Text(
            buildString {
                if (r.input) append("INPUT · ") else if (wb.viewFilterId != null) append("STEP · ")
                append("${r.info.width}×${r.info.height}")
                if (r.info.frameCount > 1) append(" · ${r.index + 1}/${r.info.frameCount} · ${m.type}")
                append(" · ${(scale * 100).roundToInt()}%")
                if (!compact) append(" · ${r.ms} ms")
            },
            color = Color.White, style = monoSmall, modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
        )
    }
}

@Composable
private fun InspectorBox(wb: Workbench, r: RenderState, modifier: Modifier) {
    val (x, y) = wb.inspect ?: return
    if (x >= r.frame.w || y >= r.frame.h) return
    val k = (y * r.frame.w + x) * 4; val d = r.frame.d
    Surface(color = Color(0xDD000000), shape = RoundedCornerShape(8.dp), modifier = modifier) {
        Column(Modifier.padding(8.dp)) {
            Text("x $x  y $y", color = Color.White, style = monoSmall)
            Text("R %.3f  G %.3f  B %.3f".format(d[k], d[k + 1], d[k + 2]), color = Color.White, style = monoSmall)
            Text("8-bit %d %d %d  A %d".format(to8(d[k]), to8(d[k + 1]), to8(d[k + 2]), to8(d[k + 3])), color = Color(0xFFBDBDBD), style = monoSmall)
            Text("Y601 %.2f".format(0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]), color = Color(0xFFBDBDBD), style = monoSmall)
        }
    }
}

@Composable
private fun EmptyState(wb: Workbench, compact: Boolean, onOpen: () -> Unit, onPattern: () -> Unit, onProject: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        BrandBadge(if (compact) 72.dp else 110.dp)
        Spacer(Modifier.height(12.dp))
        Text("ClearUFO Forensics", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Text("Evidence first. Reproducible, on-device image and video enhancement.", color = Color(0xFFB4B4B4), fontSize = 13.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        Spacer(Modifier.height(18.dp))
        Button(onClick = onOpen) { Icon(Icons.Outlined.FolderOpen, null); Spacer(Modifier.width(8.dp)); Text("Open image or video") }
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onPattern) { Text("Test pattern", color = Color.White) }
            OutlinedButton(onClick = onProject) { Text("Open project", color = Color.White) }
        }
        Spacer(Modifier.height(14.dp))
        Text("Files are opened read-only and hashed (MD5, SHA-1, SHA-256). Nothing leaves the device.", color = Color(0xFF8A8A8A), fontSize = 11.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}

@Composable
fun BrandBadge(size: androidx.compose.ui.unit.Dp) {
    androidx.compose.foundation.Image(androidx.compose.ui.res.painterResource(com.clearufo.forensics.R.mipmap.ic_launcher_foreground), "ClearUFO", modifier = Modifier.size(size))
}
