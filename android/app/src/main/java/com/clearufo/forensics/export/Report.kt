package com.clearufo.forensics.export

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import android.net.Uri
import android.os.Build
import com.clearufo.forensics.BuildConfig
import com.clearufo.forensics.engine.FILTERS
import com.clearufo.forensics.engine.Frame
import com.clearufo.forensics.engine.FrameMeta
import com.clearufo.forensics.engine.StreamInfo
import com.clearufo.forensics.engine.format
import com.clearufo.forensics.engine.to8
import com.clearufo.forensics.engine.toArgb
import com.clearufo.forensics.engine.transient
import com.clearufo.forensics.media.Files
import com.clearufo.forensics.media.SourceInfo
import com.clearufo.forensics.project.ChainDoc
import com.clearufo.forensics.project.ProjectDoc
import java.security.MessageDigest
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlin.math.min

/** MD5 of a frame's 8-bit RGB samples (as displayed and exported): identifies a processed frame in reports. */
fun frameMd5(f: Frame): String {
    val m = MessageDigest.getInstance("MD5")
    val row = ByteArray(f.w * 3)
    for (y in 0 until f.h) { for (x in 0 until f.w) { val k = (y * f.w + x) * 4; row[x * 3] = to8(f.d[k]).toByte(); row[x * 3 + 1] = to8(f.d[k + 1]).toByte(); row[x * 3 + 2] = to8(f.d[k + 2]).toByte() }; m.update(row) }
    return Files.hex(m.digest())
}

class ReportInput(
    val project: ProjectDoc, val chain: ChainDoc, val sources: Map<String, SourceInfo>,
    val frame: Frame?, val frameIndex: Int, val meta: FrameMeta?, val info: StreamInfo?,
)

object Report {
    private const val W = 595; private const val H = 842; private const val M = 42f

    private class Writer(val doc: PdfDocument) {
        var page: PdfDocument.Page? = null
        var y = 0f
        var n = 0
        val body = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 9.5f; color = Color.rgb(20, 20, 20) }
        val mono = Paint(body).apply { typeface = Typeface.MONOSPACE; textSize = 8.2f }
        val bold = Paint(body).apply { typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD) }
        val h1 = Paint(bold).apply { textSize = 17f }
        val h2 = Paint(bold).apply { textSize = 12f }
        val muted = Paint(body).apply { color = Color.rgb(100, 100, 100); textSize = 8f }
        val c: Canvas get() = page!!.canvas

        fun newPage() {
            page?.let { finish(it) }
            n++
            page = doc.startPage(PdfDocument.PageInfo.Builder(W, H, n).create())
            y = M
        }
        private fun finish(p: PdfDocument.Page) {
            p.canvas.drawText("ClearUFO Forensics — processing report — page $n", M, H - 20f, muted)
            doc.finishPage(p)
        }
        fun close() { page?.let { finish(it) }; page = null }
        fun need(h: Float) { if (page == null || y + h > H - 40) newPage() }

        fun wrap(text: String, paint: Paint, width: Float): List<String> {
            val out = ArrayList<String>()
            for (para in text.split("\n")) {
                var line = ""
                for (word in para.split(" ")) {
                    val t = if (line.isEmpty()) word else "$line $word"
                    if (paint.measureText(t) <= width) line = t
                    else {
                        if (line.isNotEmpty()) out.add(line)
                        var wrd = word
                        while (paint.measureText(wrd) > width) { var k = wrd.length; while (k > 1 && paint.measureText(wrd, 0, k) > width) k--; out.add(wrd.substring(0, k)); wrd = wrd.substring(k) }
                        line = wrd
                    }
                }
                out.add(line)
            }
            return out
        }
        fun text(s: String, paint: Paint = body, indent: Float = 0f, gap: Float = 2f) {
            for (l in wrap(s, paint, W - 2 * M - indent)) { need(paint.textSize + gap); y += paint.textSize; c.drawText(l, M + indent, y, paint); y += gap }
        }
        fun row(k: String, v: String, kw: Float = 150f, vp: Paint = body) {
            val lines = wrap(v, vp, W - 2 * M - kw)
            need(lines.size * (vp.textSize + 3) + 2)
            y += body.textSize
            c.drawText(k, M, y, muted)
            lines.forEachIndexed { i, l -> if (i > 0) y += vp.textSize + 3; c.drawText(l, M + kw, y, vp) }
            y += 4
        }
        fun heading(s: String) { need(36f); y += 12; c.drawText(s, M, y + h2.textSize, h2); y += h2.textSize + 4; c.drawLine(M, y, W - M, y, muted); y += 6 }
    }

    fun write(ctx: Context, uri: Uri, r: ReportInput) {
        val doc = PdfDocument()
        val w = Writer(doc)
        w.newPage()
        val p = r.project
        w.y += 4; w.c.drawText("ClearUFO Forensics", M, w.y + 18, w.h1); w.y += 26
        w.text("Forensic image and video processing report", w.bold)
        w.text("Generated ${ZonedDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss z"))} on the device; all processing ran locally on the device.", w.muted)

        w.heading("Case")
        w.row("Project", p.name)
        w.row("Case number", p.caseInfo.caseNumber.ifEmpty { "—" }); w.row("Examiner", p.caseInfo.examiner.ifEmpty { "—" })
        w.row("Agency", p.caseInfo.agency.ifEmpty { "—" }); w.row("Exhibit", p.caseInfo.exhibit.ifEmpty { "—" })
        if (p.caseInfo.notes.isNotBlank()) w.row("Notes", p.caseInfo.notes)

        w.heading("Evidence")
        val chainSources = r.chain.filters.mapNotNull { (it.params["source"] as? String)?.takeIf { s -> s.isNotEmpty() } } + r.chain.filters.mapNotNull { (it.params["image"] as? String)?.takeIf { s -> s.isNotEmpty() } }
        if (chainSources.isEmpty()) w.text("The chain is generated (no evidence file).", w.muted)
        for (sid in chainSources.distinct()) {
            val ref = p.sources[sid]; val si = r.sources[sid]
            w.row("File", ref?.name ?: si?.name ?: sid, vp = w.bold)
            ref?.files?.let { fs -> if (fs.size > 1) w.row("Files", "${fs.size} files, ${fs.sumOf { it.size }} bytes") else fs.firstOrNull()?.let { f -> w.row("Size", "${f.size} bytes") } }
            w.row("MD5", ref?.md5 ?: "not computed", vp = w.mono); w.row("SHA-1", ref?.sha1 ?: "not computed", vp = w.mono); w.row("SHA-256", ref?.sha256 ?: "not computed", vp = w.mono)
            si?.let { s ->
                w.row("Format", listOfNotNull(s.container, s.codec).joinToString(" · ").ifEmpty { s.kind })
                w.row("Picture", "${s.width} × ${s.height}, ${s.frameCount} frame(s)${if (s.frameCount > 1) ", %.4f fps".format(s.fps) else ""}${s.vfr?.let { ", $it" } ?: ""}")
                w.row("Decoding", s.engine.ifEmpty { "—" })
                s.conversion?.let { w.row("Color conversion", it) }
                if (s.kind == "video") w.row("Color signaling", "matrix ${s.colorMatrix ?: "—"}, range ${s.colorRange ?: "—"}, transfer ${s.transfer ?: "—"}${if (s.rotation != 0) ", rotation ${s.rotation}° (not applied)" else ""}")
            }
            w.y += 6
        }

        w.heading("Processing chain — ${r.chain.name}")
        r.chain.filters.forEachIndexed { i, f ->
            val def = FILTERS[f.type]
            w.text("${i + 1}. ${def?.name ?: f.type}${if (!f.enabled && i > 0) " (disabled — not applied)" else ""}", w.bold)
            def?.params?.filter { !it.transient && it.visible(f.params) && it.key != "source" }?.forEach { d ->
                w.row("    ${d.label}", d.format(f.params[d.key]) { id -> p.chains.firstOrNull { it.id == id }?.name ?: id })
            }
            def?.reference?.let { w.text("Reference: $it", w.muted, 12f) }
            w.y += 4
        }

        r.frame?.let { f ->
            w.heading("Result — frame ${r.frameIndex}")
            r.info?.let { w.row("Output", "${it.width} × ${it.height}, ${it.frameCount} frame(s), %.4f fps".format(it.fps)) }
            r.meta?.let { m -> w.row("Frame", "index ${r.frameIndex}, type ${m.type}${m.pts?.let { ", time %.3f s".format(it) } ?: ""}${m.src?.let { ", source frame $it" } ?: ""}") }
            w.row("Frame MD5 (8-bit RGB)", frameMd5(f), vp = w.mono)
            val maxW = W - 2 * M; val maxH = 330f
            val s = min(maxW / f.w, maxH / f.h)
            val dw = f.w * s; val dh = f.h * s
            w.need(dh + 10)
            val bmp = Bitmap.createBitmap(f.toArgb(), f.w, f.h, Bitmap.Config.ARGB_8888)
            w.c.drawBitmap(bmp, null, RectF(M, w.y + 4, M + dw, w.y + 4 + dh), Paint(Paint.FILTER_BITMAP_FLAG))
            bmp.recycle()
            w.y += dh + 12
        }

        if (p.bookmarks.isNotEmpty()) {
            w.heading("Bookmarks")
            for (b in p.bookmarks) w.row("${p.chains.firstOrNull { it.id == b.chainId }?.name ?: "?"} · frame ${b.frame}", b.note.ifEmpty { "—" })
        }

        w.heading("Environment and integrity")
        w.row("Application", "ClearUFO Forensics ${BuildConfig.VERSION_NAME} (Android, native)")
        w.row("Device", "${Build.MANUFACTURER} ${Build.MODEL} (${Build.DEVICE}), Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
        w.text("Evidence files were opened read-only through the Android Storage Access Framework and never modified. Hashes are computed from the original bytes. The processing pipeline stores samples as 32-bit floats on a 0–255 scale without clamping between filters; values are rounded to 8 bits only for display and 8-bit exports.", w.muted)
        w.close()
        ctx.contentResolver.openOutputStream(uri, "wt")?.use { doc.writeTo(it) } ?: throw IllegalStateException("The report cannot be written")
        doc.close()
    }
}
