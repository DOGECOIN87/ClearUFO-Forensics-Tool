package com.clearufo.forensics

import com.clearufo.forensics.engine.*
import com.clearufo.forensics.media.BmpCodec
import com.clearufo.forensics.media.DecodeOptions
import com.clearufo.forensics.media.PngCodec
import com.clearufo.forensics.media.SourceInfo
import com.clearufo.forensics.media.SourceProvider
import com.clearufo.forensics.media.TiffCodec
import com.clearufo.forensics.media.rng
import com.clearufo.forensics.media.to16
import com.clearufo.forensics.project.ChainDoc
import com.clearufo.forensics.project.FilterInstance
import com.clearufo.forensics.project.ProjectDoc
import com.clearufo.forensics.project.ProjectJson
import com.clearufo.forensics.project.newFilter
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** A video of `n` deterministic frames, counting how often each frame is decoded. */
class FakeSource(val n: Int, val w: Int = 48, val h: Int = 32, val fps: Double = 25.0) : SourceProvider {
    val decodes = IntArray(n)
    override val info = SourceInfo("src", "video", "fake.mp4", width = w, height = h, frameCount = n, fps = fps)
    override suspend fun getFrame(i: Int, opts: DecodeOptions): Frame {
        decodes[i]++
        val r = rng(1000 + i); val f = Frame.alloc(w, h)
        for (k in 0 until w * h) { f.d[k * 4] = (k % w * 4 + r() * 10).toFloat(); f.d[k * 4 + 1] = (k / w * 6 + r() * 10).toFloat(); f.d[k * 4 + 2] = (i * 10 % 256).toFloat() }
        return f
    }
    override fun meta(i: Int) = FrameMeta(if (i % 5 == 0) 'I' else 'P', i / fps, i % 5 == 0, 1000 + i, i)
}

class EngineTest {
    private fun f(type: String, vararg p: Pair<String, Any?>): FilterInstance = newFilter(type).let { it.copy(params = it.params + p) }

    @Test fun chainEvaluatesCachesAndInvalidatesDownstreamOnly() = runBlocking {
        val e = Engine()
        val src = FakeSource(10)
        e.addSource("src", src)
        val loader = f("video_loader", "source" to "src")
        val blur = f("gaussian_filter", "sigma" to 1.5)
        val range = f("range_selector", "start" to 2.0, "end" to 7.0)
        val avg = f("frame_averaging", "mode" to "window", "window" to 3.0)
        val rs = f("resize", "scale" to 50.0)
        e.setProject(listOf(ChainDoc("c", "c", listOf(loader, blur, range, avg, rs))))
        val r = e.render("c", null, false, 0)
        assertEquals(24, r.frame.w); assertEquals(16, r.frame.h)
        assertEquals(6, r.info.frameCount)              // frames 2..7
        assertEquals(2, r.meta.src)                       // output frame 0 is source frame 2
        val decoded = src.decodes.sum()
        e.render("c", null, false, 0)                     // cached: no new decode
        assertEquals(decoded, src.decodes.sum())
        // changing the last filter recomputes it but not the decoding / blur upstream
        e.setProject(listOf(ChainDoc("c", "c", listOf(loader, blur, range, avg, rs.copy(params = rs.params + ("scale" to 25.0))))))
        val r2 = e.render("c", null, false, 0)
        assertEquals(12, r2.frame.w)
        assertEquals(decoded, src.decodes.sum())
        // the input of a filter (Show Input)
        val inp = e.render("c", rs.id, true, 0)
        assertEquals(48, inp.frame.w)
        // disabled filters are skipped
        e.setProject(listOf(ChainDoc("c", "c", listOf(loader, blur.copy(enabled = false)))))
        val raw = e.render("c", null, false, 4)
        assertArrayEquals(src.getFrame(4).d, raw.frame.d, 0f)
    }

    @Test fun temporalAndLinkFilters() = runBlocking {
        val e = Engine()
        e.addSource("a", FakeSource(8)); e.addSource("b", FakeSource(5, 40, 30))
        val ca = ChainDoc("ca", "A", listOf(f("video_loader", "source" to "a"), f("reverse"), f("freeze_frame", "frame" to 1.0, "duration" to 3.0)))
        val cb = ChainDoc("cb", "B", listOf(f("video_loader", "source" to "b")))
        val mix = ChainDoc("cm", "Mix", listOf(f("video_loader", "source" to "a"), f("video_mixer", "second" to "cb", "mode" to "sbs_h")))
        val tl = ChainDoc("ct", "Timeline", listOf(f("video_loader", "source" to "a"), f("timeline", "chains" to listOf("cb"))))
        val sel = ChainDoc("cs", "I only", listOf(f("video_loader", "source" to "a"), f("iframes_selector")))
        e.setProject(listOf(ca, cb, mix, tl, sel))
        assertEquals(10, e.render("ca", null, false, 0).info.frameCount)   // 8 + 2 held
        assertEquals(6, e.render("ca", null, false, 2).meta.src)           // reversed: frame 1 → source 6, held
        assertEquals(96, e.render("cm", null, false, 0).frame.w)           // side by side
        assertEquals(13, e.render("ct", null, false, 0).info.frameCount)  // 8 + 5
        assertEquals(48, e.render("ct", null, false, 10).frame.w)         // letterboxed to the first chain
        assertEquals(2, e.render("cs", null, false, 0).info.frameCount)   // frames 0 and 5 are I frames
    }

    /** Playback read-ahead: a cancelled request must not cancel the shared computation others wait for ("z was canceled"). */
    @Test fun cancellingOneRequestDoesNotFailAnother() = runBlocking {
        val slow = object : SourceProvider by FakeSource(3) {
            override suspend fun getFrame(i: Int, opts: DecodeOptions): Frame { kotlinx.coroutines.delay(300); return Frame.alloc(8, 8) }
        }
        val e = Engine(); e.addSource("s", slow)
        e.setProject(listOf(ChainDoc("c", "c", listOf(f("video_loader", "source" to "s"), f("negative")))))
        val first = launch(kotlinx.coroutines.Dispatchers.Default) { e.render("c", null, false, 1) }
        kotlinx.coroutines.delay(100)
        val second = async(kotlinx.coroutines.Dispatchers.Default) { e.render("c", null, false, 1) }
        kotlinx.coroutines.delay(20)
        first.cancel()
        assertEquals(8, second.await().frame.w)
    }

    @Test fun quarterTurnsAreExact() = runBlocking {
        val e = Engine(); val src = FakeSource(2); e.addSource("s", src)
        for ((angle, w, h) in listOf(Triple(90.0, 32, 48), Triple(-90.0, 32, 48), Triple(180.0, 48, 32))) {
            e.setProject(listOf(ChainDoc("c", "c", listOf(f("video_loader", "source" to "s"), f("rotate", "angle" to angle, "expand" to true)))))
            val o = e.render("c", null, false, 0).frame; val i = src.getFrame(0)
            assertEquals(w, o.w); assertEquals(h, o.h)
            for (y in 0 until o.h) for (x in 0 until o.w) {
                val (sx, sy) = when (angle) { 90.0 -> y to (i.h - 1 - x); -90.0 -> (i.w - 1 - y) to x; else -> (i.w - 1 - x) to (i.h - 1 - y) }
                for (c in 0 until 4) assertEquals(i.d[(sy * i.w + sx) * 4 + c], o.d[(y * o.w + x) * 4 + c], 0f)
            }
        }
    }

    /** Linked chains follow the timestamps: a 30 fps chain mixed with a 25 fps one shows the frame on screen at that moment. */
    @Test fun linkedChainsAreSynchronizedByTime() = runBlocking {
        val e = Engine()
        e.addSource("a", FakeSource(30, fps = 30.0)); e.addSource("b", FakeSource(25, fps = 25.0)); e.addSource("c", FakeSource(10, fps = 50.0))
        fun mix(sync: String, offset: Double) = ChainDoc("m", "m", listOf(f("video_loader", "source" to "a"), f("video_mixer", "second" to "cb", "mode" to "sbs_h", "sync" to sync, "offset" to offset)))
        val cb = ChainDoc("cb", "B", listOf(f("video_loader", "source" to "b")))
        fun bFrameShown(i: Int) = runBlocking { val o = e.render("m", null, false, i).frame; (o.d[(5 * o.w + 60) * 4 + 2] / 10f).toInt() } // blue = frame × 10
        e.setProject(listOf(mix("time", 0.0), cb))
        for (i in listOf(0, 1, 6, 7, 29)) assertEquals("A frame $i", Math.floor(i / 30.0 * 25 + 1e-6).toInt(), bFrameShown(i))
        e.setProject(listOf(mix("time", 3.0), cb))                       // 3 frames of A = 0.1 s
        assertEquals(Math.floor((12 / 30.0 + 0.1) * 25 + 1e-6).toInt(), bFrameShown(12))
        e.setProject(listOf(mix("frame", 0.0), cb))                       // browser projects: frame numbers
        assertEquals(7, bFrameShown(7))
        // Timeline: a 50 fps clip appended to a 30 fps chain is resampled (0.2 s → 6 frames), not played 1.67× too fast
        e.setProject(listOf(ChainDoc("t", "t", listOf(f("video_loader", "source" to "a"), f("timeline", "chains" to listOf("cc")))), ChainDoc("cc", "C", listOf(f("video_loader", "source" to "c")))))
        assertEquals(36, e.render("t", null, false, 0).info.frameCount)
    }

    @Test fun errorsNameTheFilter() = runBlocking {
        val e = Engine()
        val loader = f("video_loader", "source" to "missing")
        e.setProject(listOf(ChainDoc("c", "c", listOf(loader, f("negative")))))
        try { e.render("c", null, false, 0); fail("expected an error") } catch (x: FilterException) { assertEquals(loader.id, x.filterId) }
    }
}

class CodecTest {
    private fun frame(w: Int, h: Int): Frame { val r = rng(5); val f = Frame.alloc(w, h); for (i in 0 until w * h * 4) if (i % 4 != 3) f.d[i] = (r() * 300 - 20).toFloat(); return f }

    @Test fun png16RoundTripKeepsEverySample() {
        val f = frame(37, 23)
        val d = PngCodec.decode(PngCodec.encode(f, true)).frame
        for (i in 0 until 37 * 23 * 4) if (i % 4 != 3) assertEquals(to16(f.d[i]), Math.round(d.d[i] * 257.0).toInt())
    }

    @Test fun png8AndBmpAndTiffRoundTrips() {
        val f = frame(19, 11)
        val p8 = PngCodec.decode(PngCodec.encode(f, false)).frame
        for (i in 0 until 19 * 11 * 4) if (i % 4 != 3) assertEquals(to8(f.d[i]).toFloat(), p8.d[i])
        val t32 = TiffCodec.rawSamples(TiffCodec.encode(f, 4))
        for (k in t32.indices) assertEquals((f.d[(k / 3) * 4 + k % 3] / 255f).toDouble(), t32[k], 0.0)
        val t16 = TiffCodec.decode(TiffCodec.encode(f, 2)).frame
        for (i in 0 until 19 * 11 * 4) if (i % 4 != 3) assertEquals(to16(f.d[i]), Math.round(t16.d[i] * 257.0).toInt())
        val bmp = BmpCodec.encode(f)
        assertEquals(54 + ((19 * 3 + 3) and 3.inv()) * 11, bmp.size)
    }

    @Test fun projectJsonRoundTripAndLegacyPinning() {
        // a project saved by an older browser version: Video Loader without "chroma"/"hdr"
        val legacy = """{"app":"LUCID","schema":1,"name":"Case 7","chains":[{"id":"c1","name":"cam","filters":[
            {"id":"f1","type":"video_loader","enabled":true,"params":{"source":"s1","engine":"webcodecs","colorRange":"auto","matrix":"auto"}},
            {"id":"f2","type":"crop","enabled":true,"params":{"rect":{"x":1,"y":2,"w":30,"h":20}}},
            {"id":"f3","type":"correct_perspective","enabled":false,"params":{"points":[{"x":1,"y":1},{"x":9,"y":1},{"x":9,"y":9},{"x":1,"y":9}]}}]}],
            "sources":{"s1":{"id":"s1","kind":"video","name":"cam.mp4","files":[{"name":"cam.mp4","size":123,"lastModified":0,"type":"video/mp4"}],"md5":"abc"}},
            "caseInfo":{"caseNumber":"42","examiner":"E","agency":"","exhibit":"","notes":""},"bookmarks":[]}"""
        val p = ProjectJson.read(legacy)
        val vl = p.chains[0].filters[0]
        assertEquals("nearest", vl.params["chroma"])      // pinned legacy value: same results as before
        assertEquals("none", vl.params["hdr"])
        assertEquals(RectP(1.0, 2.0, 30.0, 20.0), p.chains[0].filters[1].params["rect"])
        assertEquals(4, (p.chains[0].filters[2].params["points"] as List<*>).size)
        assertFalse(p.chains[0].filters[2].enabled)
        val again = ProjectJson.read(ProjectJson.write(p))
        assertEquals(p.chains, again.chains)
        assertEquals("abc", again.sources["s1"]?.md5)
        assertEquals("42", again.caseInfo.caseNumber)
        try { ProjectJson.read("""{"schema":99,"chains":[]}"""); fail() } catch (e: IllegalArgumentException) { assertTrue(e.message!!.contains("newer")) }
        try { ProjectJson.read("""{"chains":[{"id":"c","filters":[{"id":"f","type":"warp_drive","params":{}}]}]}"""); fail() } catch (e: IllegalArgumentException) { assertTrue(e.message!!.contains("unknown")) }
    }

    @Test fun catalogMatchesTheBrowserWorkbench() {
        assertEquals(85, FILTER_LIST.size)
        assertEquals(17, CATEGORIES.size)
        for (d in FILTER_LIST) assertTrue("${d.id} has no implementation", IMPLS.containsKey(d.id) || d.kind == FilterKind.WRITER)
        assertEquals(FILTER_LIST.size, FILTER_LIST.map { it.id }.toSet().size)
    }
}

/** Every filter, parameter key, type, default, range and option list as in the browser workbench (catalog.json). */
class CatalogConformanceTest {
    @Test fun parametersMatchTheBrowserCatalog() {
        val text = javaClass.classLoader!!.getResource("conformance/catalog.json")!!.readText()
        val web = org.json.JSONArray(text)
        val problems = ArrayList<String>()
        val webIds = HashSet<String>()
        for (i in 0 until web.length()) {
            val wf = web.getJSONObject(i); val id = wf.getString("id"); webIds.add(id)
            val kf = FILTERS[id] ?: run { problems.add("missing filter $id"); null } ?: continue
            if (kf.category != wf.getString("category")) problems.add("$id: category ${kf.category} != ${wf.getString("category")}")
            if (kf.kind.name.lowercase() != wf.getString("kind")) problems.add("$id: kind ${kf.kind} != ${wf.getString("kind")}")
            val wp = wf.getJSONArray("params")
            val kp = kf.params.associateBy { it.key }
            for (j in 0 until wp.length()) {
                val p = wp.getJSONObject(j); val key = p.getString("key"); val type = p.getString("type")
                if (type == "action" && key in setOf("_dvr", "_dvrLast")) continue // DVR conversion dialog of the browser version
                val d = kp[key] ?: run { problems.add("$id.$key missing"); null } ?: continue
                val kt = when (d) { is NumberParam -> if (d.isInt) "int" else "number"; is SelectParam -> "select"; is BoolParam -> "bool"; is ColorParam -> "color"; is TextParam -> "text"; is RectParam -> "rect"; is PointParam -> "point"; is PointsParam -> "points"; is LineParam -> "line"; is ChainParam -> "chain"; is ChainsParam -> "chains"; is FrameParam -> "frame"; is CurveParam -> "curve"; is SourceParam -> "source"; is ImageParam -> "image"; is ActionParam -> "action"; is PsfParam -> "psf"; is FileInfoParam -> "fileinfo" }
                if (kt != type) problems.add("$id.$key type $kt != $type")
                val wd = ParamJson.fromJson(p.opt("default"))
                if (!d.transient && ParamJson.stable(d.default) != ParamJson.stable(wd)) problems.add("$id.$key default ${ParamJson.stable(d.default)} != ${ParamJson.stable(wd)}")
                val wl = ParamJson.fromJson(p.opt("legacy"))
                if (ParamJson.stable(d.legacy) != ParamJson.stable(wl)) problems.add("$id.$key legacy ${d.legacy} != $wl")
                if (d is NumberParam && (d.min != p.optDouble("min") || d.max != p.optDouble("max"))) problems.add("$id.$key range ${d.min}..${d.max} != ${p.opt("min")}..${p.opt("max")}")
                if (d is SelectParam) { val wo = p.getJSONArray("options").let { a -> (0 until a.length()).map { a.getString(it) } }; if (d.options.map { it.first } != wo) problems.add("$id.$key options ${d.options.map { it.first }} != $wo") }
            }
            for (k in kp.keys) if ((0 until wp.length()).none { wp.getJSONObject(it).getString("key") == k } && "$id.$k" !in ANDROID_ONLY_PARAMS) problems.add("$id.$k not in the browser catalog")
        }
        for (id in FILTERS.keys) if (id !in webIds) problems.add("extra filter $id")
        assertTrue(problems.joinToString("\n"), problems.isEmpty())
    }
}

@Suppress("unused") private val keep = ProjectDoc()
