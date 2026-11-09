package com.clearufo.forensics

import android.media.MediaFormat
import com.clearufo.forensics.engine.*
import com.clearufo.forensics.media.ColorFacts
import com.clearufo.forensics.media.DecodeOptions
import com.clearufo.forensics.media.SourceInfo
import com.clearufo.forensics.media.SourceProvider
import com.clearufo.forensics.media.Yuv
import com.clearufo.forensics.media.planesToFrame
import com.clearufo.forensics.project.ChainDoc
import com.clearufo.forensics.project.newFilter
import kotlinx.coroutines.runBlocking
import org.junit.Assume
import org.junit.Test
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.Properties

/**
 * Runs the app's own pipeline on a whole video on a computer, for results identical to the phone's (opt-in: set
 * CLEARUFO_JOB to a job file). Raw 8-bit YUV 4:2:0 frames come from a file or pipe (e.g. `ffmpeg -i in.mkv
 * -fps_mode passthrough -f rawvideo -pix_fmt yuv420p in.yuv`; VP9, H.264 and HEVC decoding is bit-exact, so the
 * samples are the ones the phone's decoder produces); the app's Video Loader turns them into frames with
 * planesToFrame (the function the app calls on MediaCodec output), the app's filters (Extract Channel, Histogram Equalization, Temporal Smoothing...) run through the app's
 * Engine, and every result frame is written as YUV 4:2:0 with the formula of the app's video export
 * (Exporter.fillYuv), ready for an encoder.
 *
 * Job file (properties): in, out, w, h, n (frames), fps, name; colour facts as Android reports them for the file:
 * standard = bt601 | bt709 | bt2020 | none, range = limited | full; the filters after the loader: steps = a JSON list
 * such as [{"type":"extract_channel","params":{"channel":"b","stretch":true}}] (filter ids and parameter keys of the
 * catalog; missing parameters take their defaults), or just channel + stretch for one Extract Channel step.
 * outs = [{"step":2,"path":"a.yuv"},{"step":3,"path":"b.yuv"}] writes the result after several steps in one pass
 * (default: out = the last step); cacheMB = frame cache for temporal filters; ring = raw frames kept for them.
 *
 *   CLEARUFO_JOB=/path/job.properties ./gradlew :app:testDebugUnitTest --tests '*VideoJob*' --rerun
 */
class VideoJob {
    @Test fun run() = runBlocking {
        val job = System.getenv("CLEARUFO_JOB")?.let(::File)
        Assume.assumeTrue("set CLEARUFO_JOB to a job file", job != null && job.exists())
        val p = Properties().apply { job!!.inputStream().use { load(it) } }
        val w = p.getProperty("w").toInt(); val h = p.getProperty("h").toInt(); val n = p.getProperty("n").toInt()
        val cw = (w + 1) / 2; val ch = (h + 1) / 2
        val input = DataInputStream(FileInputStream(p.getProperty("in")).buffered(1 shl 22))
        // the colour facts Android's extractor reports for the file (e.g. Matroska Colour matrix 6 → BT.601)
        val standard = when (p.getProperty("standard", "none")) { "bt601" -> MediaFormat.COLOR_STANDARD_BT601_PAL; "bt709" -> MediaFormat.COLOR_STANDARD_BT709; "bt2020" -> MediaFormat.COLOR_STANDARD_BT2020; else -> null }
        val range = if (p.getProperty("range", "limited") == "full") MediaFormat.COLOR_RANGE_FULL else MediaFormat.COLOR_RANGE_LIMITED
        val colors = ColorFacts(standard, range, MediaFormat.COLOR_TRANSFER_SDR_VIDEO)
        val frameBytes = w * h + 2 * cw * ch
        // the input is read once, in order; the last `ring` raw frames are kept for temporal filters that look back
        val ring = p.getProperty("ring", "16").toInt()
        val recent = LinkedHashMap<Int, ByteArray>()
        var next = 0
        val src = object : SourceProvider {
            override val info = SourceInfo("v", "video", p.getProperty("name", "video"), width = w, height = h, frameCount = n, fps = p.getProperty("fps").toDouble())
            override suspend fun getFrame(i: Int, opts: DecodeOptions): Frame {
                val raw = synchronized(recent) {
                    while (next <= i) {
                        val b = ByteArray(frameBytes); input.readFully(b)
                        recent[next++] = b
                        while (recent.size > ring) recent.remove(recent.keys.first())
                    }
                    recent[i] ?: error("frame $i is no longer available (raise ring)")
                }
                val y = ShortArray(w * h) { (raw[it].toInt() and 255).toShort() }
                val u = ShortArray(cw * ch) { (raw[w * h + it].toInt() and 255).toShort() }
                val v = ShortArray(cw * ch) { (raw[w * h + cw * ch + it].toInt() and 255).toShort() }
                val f = planesToFrame(Yuv.Planes(w, h, y, u, v, cw, ch, 1, 1, 8), colors, opts, info)
                if (i == 0) println("JOB conversion: ${info.conversion} (options $opts)")
                return f
            }
            override fun meta(i: Int) = FrameMeta('?', i / info.fps, i == 0, 0, i)
        }
        val e = Engine()
        // frame cache (temporal filters reuse their neighbours' frames); 0 when each frame is used once
        e.cache.limit = p.getProperty("cacheMB", "0").toLong() * 1048576
        e.addSource("v", src)
        val loader = newFilter("video_loader").let { it.copy(params = it.params + ("source" to "v")) }
        // the filters after the loader: `steps` (JSON list of {"type", "params"}), or Extract Channel from channel/stretch
        val steps = p.getProperty("steps")?.let { js ->
            val a = org.json.JSONArray(js)
            (0 until a.length()).map { k ->
                val o = a.getJSONObject(k); val f = newFilter(o.getString("type"))
                val ps = o.optJSONObject("params")?.let { po -> po.keys().asSequence().associateWith { key -> ParamJson.fromJson(po.get(key)) } } ?: emptyMap()
                f.copy(params = f.params + ps)
            }
        } ?: listOf(newFilter("extract_channel").let { it.copy(params = it.params + mapOf("channel" to p.getProperty("channel", "y"), "stretch" to (p.getProperty("stretch", "false") == "true"))) })
        e.setProject(listOf(ChainDoc("c", "c", listOf(loader) + steps)))
        println("JOB loader params ${loader.params}")
        for (f in steps) println("JOB step ${f.type} ${f.params}")
        // outputs: `outs` (JSON list of {"step": 1-based step after the loader, "path"}), or `out` for the last step
        val outs = p.getProperty("outs")?.let { js ->
            val a = org.json.JSONArray(js)
            (0 until a.length()).map { k -> val o = a.getJSONObject(k); steps[o.getInt("step") - 1].id to o.getString("path") }
        } ?: listOf(steps.last().id to p.getProperty("out"))
        val streams = outs.map { (id, path) -> e.streamFor("c", id) to BufferedOutputStream(FileOutputStream(path), 1 shl 22) }
        val yuv = ByteArray(w * h + 2 * (w / 2) * (h / 2))
        val t0 = System.nanoTime()
        for (i in 0 until n) {
            for ((s, output) in streams) {
                val f = s.getFrame(i)
                // Exporter.fillYuv: RGB (0..255 float) → BT.709 limited-range YUV 4:2:0 (2x2 chroma average), same arithmetic
                Par.forRows(h) { y0, y1 ->
                    for (y in y0 until y1) for (x in 0 until w) {
                        val k = (y * f.w + x) * 4
                        val r = to8(f.d[k]); val g = to8(f.d[k + 1]); val b = to8(f.d[k + 2])
                        yuv[y * w + x] = (16 + (0.2126 * r + 0.7152 * g + 0.0722 * b) * 219 / 255 + 0.5).toInt().coerceIn(0, 255).toByte()
                    }
                }
                val uo = w * h; val vo = uo + (w / 2) * (h / 2)
                Par.forRows(h / 2) { c0, c1 ->
                    for (cy in c0 until c1) for (cx in 0 until w / 2) {
                        var r = 0.0; var g = 0.0; var b = 0.0
                        for (dy in 0..1) for (dx in 0..1) { val k = ((cy * 2 + dy) * f.w + cx * 2 + dx) * 4; r += to8(f.d[k]); g += to8(f.d[k + 1]); b += to8(f.d[k + 2]) }
                        r /= 4; g /= 4; b /= 4
                        val yy = 0.2126 * r + 0.7152 * g + 0.0722 * b
                        val u = 128 + (b - yy) / 1.8556 * 224 / 255; val v = 128 + (r - yy) / 1.5748 * 224 / 255
                        yuv[uo + cy * (w / 2) + cx] = (u + 0.5).toInt().coerceIn(0, 255).toByte()
                        yuv[vo + cy * (w / 2) + cx] = (v + 0.5).toInt().coerceIn(0, 255).toByte()
                    }
                }
                output.write(yuv)
            }
            if (i % 300 == 0 || i == n - 1) println("JOB frame ${i + 1}/$n, ${(System.nanoTime() - t0) / 1_000_000 / (i + 1)} ms per frame")
        }
        for ((_, output) in streams) { output.flush(); output.close() }
        input.close()
        println("JOB done: $n frames")
    }
}
