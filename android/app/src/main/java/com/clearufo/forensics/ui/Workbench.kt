package com.clearufo.forensics.ui

import android.app.Application
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.clearufo.forensics.engine.*
import com.clearufo.forensics.engine.kernels.Cancelled
import com.clearufo.forensics.export.Exporter
import com.clearufo.forensics.export.Report
import com.clearufo.forensics.export.ReportInput
import com.clearufo.forensics.export.WriteResult
import com.clearufo.forensics.export.frameMd5
import com.clearufo.forensics.media.*
import com.clearufo.forensics.project.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import java.io.File
import kotlin.math.max
import kotlin.math.min

enum class Tool { POINTER, INSPECT }

class RenderState(val bitmap: Bitmap, val frame: Frame, val info: StreamInfo, val meta: FrameMeta, val index: Int, val ms: Long, val input: Boolean)

/** An overlay parameter being drawn on the viewer. */
data class EditTarget(val filterId: String, val key: String)

class Prefs(ctx: Context) {
    private val sp = ctx.getSharedPreferences("clearufo", Context.MODE_PRIVATE)
    var theme: String get() = sp.getString("theme", "midnight")!!; set(v) { sp.edit().putString("theme", v).apply() }
    var threads: Int get() = sp.getInt("threads", 0); set(v) { sp.edit().putInt("threads", v).apply() }
    var cacheMB: Int get() = sp.getInt("cacheMB", 0); set(v) { sp.edit().putInt("cacheMB", v).apply() }
    var losslessOnly: Boolean get() = sp.getBoolean("losslessOnly", true); set(v) { sp.edit().putBoolean("losslessOnly", v).apply() }
    var autoSave: Boolean get() = sp.getBoolean("autoSave", true); set(v) { sp.edit().putBoolean("autoSave", v).apply() }
    var hashOnLoad: Boolean get() = sp.getBoolean("hashOnLoad", true); set(v) { sp.edit().putBoolean("hashOnLoad", v).apply() }
    var layout: String get() = sp.getString("layout", "auto")!!; set(v) { sp.edit().putString("layout", v).apply() }
}

class Workbench(app: Application) : AndroidViewModel(app) {
    private val ctx: Context get() = getApplication()
    val engine = Engine()
    val prefs = Prefs(app)

    var project by mutableStateOf(ProjectDoc()); private set
    val sourceInfos = mutableStateMapOf<String, SourceInfo>()
    var chainId by mutableStateOf<String?>(null); private set
    var filterId by mutableStateOf<String?>(null); private set
    var frame by mutableStateOf(0); private set
    var showInput by mutableStateOf(false)
    var render by mutableStateOf<RenderState?>(null); private set
    var renderError by mutableStateOf<Pair<String, String?>?>(null); private set
    var rendering by mutableStateOf(false); private set
    /** The last processing exception (diagnostics). */
    var lastError: Throwable? = null; private set
    var playing by mutableStateOf(false); private set
    var speed by mutableStateOf(1.0)
    var inPoint by mutableStateOf<Int?>(null)
    var outPoint by mutableStateOf<Int?>(null)
    var tool by mutableStateOf(Tool.POINTER)
    var edit by mutableStateOf<EditTarget?>(null)
    var inspect by mutableStateOf<Pair<Int, Int>?>(null)
    var dirty by mutableStateOf(false); private set
    var themeName by mutableStateOf(prefs.theme)
    var layoutPref by mutableStateOf(prefs.layout)
    val messages = mutableStateListOf<String>()
    val progress = engine.progress
    private val tasks = MutableStateFlow<Map<String, Pair<String, Double>>>(emptyMap())
    val appTasks = tasks
    var projectUri: Uri? = null

    private val undo = ArrayDeque<ProjectDoc>()
    private val redo = ArrayDeque<ProjectDoc>()
    private var editSnapshot: ProjectDoc? = null
    val canUndo get() = undo.isNotEmpty()
    val canRedo get() = redo.isNotEmpty()
    private var undoVersion by mutableStateOf(0)
    val historyVersion get() = undoVersion

    private val renderTrigger = MutableStateFlow(0L)
    private var playJob: Job? = null
    private val sessionFile = File(app.filesDir, "session.lfp")

    init {
        applyPrefs()
        viewModelScope.launch { renderTrigger.collectLatest { doRender() } }
        viewModelScope.launch { restoreSession() }
    }

    fun applyPrefs() {
        Par.threads = if (prefs.threads > 0) prefs.threads else Par.available
        engine.cache.limit = if (prefs.cacheMB > 0) prefs.cacheMB * 1048576L else (Runtime.getRuntime().maxMemory() * 0.35).toLong()
    }

    fun toast(m: String) { messages.add(m) }
    private fun task(id: String, label: String, v: Double, done: Boolean = false) { tasks.value = if (done) tasks.value - id else tasks.value + (id to (label to v)) }

    // ------------------------------------------------------------ project state
    val chain: ChainDoc? get() = project.chains.firstOrNull { it.id == chainId }
    val selectedFilter: FilterInstance? get() = chain?.filters?.firstOrNull { it.id == filterId }

    private fun publish(p: ProjectDoc, structural: Boolean = true) {
        project = p
        engine.setProject(p.chains)
        if (chainId == null || p.chains.none { it.id == chainId }) chainId = p.chains.firstOrNull()?.id
        val c = chain
        if (c != null && (filterId == null || c.filters.none { it.id == filterId })) filterId = c.filters.lastOrNull()?.id
        if (c == null) filterId = null
        if (structural) dirty = true
        requestRender()
        scheduleSave()
    }

    /** Undoable change of the project. */
    fun mutate(fn: (ProjectDoc) -> ProjectDoc) {
        val before = project
        val after = fn(before)
        if (after === before) return
        if (editSnapshot == null) { undo.addLast(before); if (undo.size > 200) undo.removeFirst(); redo.clear(); undoVersion++ }
        publish(after)
    }

    /** Continuous edits (slider drags): one undo step for the whole gesture. */
    fun beginEdit() { if (editSnapshot == null) { editSnapshot = project; undo.addLast(project); redo.clear(); undoVersion++ } }
    fun endEdit() { editSnapshot = null }

    fun undo() { val p = undo.removeLastOrNull() ?: return; redo.addLast(project); undoVersion++; publish(p) }
    fun redo() { val p = redo.removeLastOrNull() ?: return; undo.addLast(project); undoVersion++; publish(p) }

    private fun updateChain(id: String, fn: (ChainDoc) -> ChainDoc) = mutate { p -> p.copy(chains = p.chains.map { if (it.id == id) fn(it) else it }) }

    fun selectChain(id: String) { chainId = id; filterId = chain?.filters?.lastOrNull()?.id; frame = 0; edit = null; requestRender() }
    fun selectFilter(id: String?) { filterId = id; edit = null; requestRender() }
    fun seek(i: Int) { val n = render?.info?.frameCount ?: 1; frame = i.coerceIn(0, max(0, n - 1)); requestRender() }

    fun addFilter(type: String) {
        val c = chain ?: run { toast("Load an image or a video first (or a Test Pattern)."); return }
        val def = FILTERS[type] ?: return
        if (def.kind == FilterKind.LOADER) { toast("${def.name} starts a new chain: use Open."); return }
        val f = newFilter(type)
        val at = c.filters.indexOfFirst { it.id == filterId }.let { if (it < 0) c.filters.size else it + 1 }
        updateChain(c.id) { it.copy(filters = it.filters.toMutableList().apply { add(at, f) }) }
        filterId = f.id
        requestRender()
    }

    fun removeFilter(id: String) {
        val c = chain ?: return
        val i = c.filters.indexOfFirst { it.id == id }
        if (i <= 0) { toast("The loader is the start of the chain: delete the chain instead."); return }
        updateChain(c.id) { it.copy(filters = it.filters.filter { f -> f.id != id }) }
        filterId = c.filters.getOrNull(i - 1)?.id
        requestRender()
    }

    fun toggleFilter(id: String) { val c = chain ?: return; updateChain(c.id) { it.copy(filters = it.filters.map { f -> if (f.id == id) f.copy(enabled = !f.enabled) else f }) } }

    fun moveFilter(id: String, delta: Int) {
        val c = chain ?: return
        val i = c.filters.indexOfFirst { it.id == id }; val j = i + delta
        if (i <= 0 || j <= 0 || j >= c.filters.size) return
        updateChain(c.id) { val l = it.filters.toMutableList(); val t = l[i]; l[i] = l[j]; l[j] = t; it.copy(filters = l) }
    }

    fun setParam(filterId: String, key: String, value: Any?) {
        val c = project.chains.firstOrNull { ch -> ch.filters.any { it.id == filterId } } ?: return
        updateChain(c.id) { it.copy(filters = it.filters.map { f -> if (f.id == filterId) f.copy(params = f.params + (key to value)) else f }) }
    }

    fun renameChain(id: String, name: String) = updateChain(id) { it.copy(name = name.ifBlank { it.name }) }
    fun deleteChain(id: String) = mutate { p -> p.copy(chains = p.chains.filter { it.id != id }) }
    fun duplicateChain(id: String) {
        val c = project.chains.firstOrNull { it.id == id } ?: return
        val copy = c.copy(id = uid("c"), name = "${c.name} (copy)", filters = c.filters.map { it.copy(id = uid("f")) })
        mutate { p -> p.copy(chains = p.chains + copy) }
        selectChain(copy.id)
    }
    fun chainFromHere(id: String) {
        val c = chain ?: return
        val i = c.filters.indexOfFirst { it.id == id }
        if (i < 0) return
        val copy = ChainDoc(uid("c"), "${c.name} (from ${FILTERS[c.filters[i].type]?.name})", c.filters.take(i + 1).map { it.copy(id = uid("f")) })
        mutate { p -> p.copy(chains = p.chains + copy) }
        selectChain(copy.id)
    }

    fun setCaseInfo(ci: CaseInfo, name: String) = mutate { it.copy(caseInfo = ci, name = name.ifBlank { it.name }) }
    fun addBookmark(note: String) { val c = chain ?: return; mutate { it.copy(bookmarks = it.bookmarks + Bookmark(uid("b"), c.id, frame, note)) }; toast("Bookmark added at frame $frame.") }
    fun removeBookmark(id: String) = mutate { it.copy(bookmarks = it.bookmarks.filter { b -> b.id != id }) }

    fun newProject() {
        stop()
        for (id in engine.sources.keys.toList()) engine.closeSource(id)
        sourceInfos.clear(); undo.clear(); redo.clear(); undoVersion++
        projectUri = null; chainId = null; filterId = null; frame = 0; render = null; renderError = null; inPoint = null; outPoint = null
        publish(ProjectDoc()); dirty = false
    }

    // ------------------------------------------------------------ rendering and playback
    fun requestRender() { renderTrigger.value = renderTrigger.value + 1 }

    /** The viewer shows the filter input while an "input" overlay is edited (crop, perspective) or Show Input is on. */
    val showingInput: Boolean get() {
        val f = selectedFilter ?: return false
        val def = FILTERS[f.type]
        return (showInput || (edit != null && def?.overlayOn == "input")) && chain?.filters?.indexOf(f)?.let { it > 0 } == true
    }

    private suspend fun doRender() {
        val c = chainId ?: run { render = null; renderError = null; return }
        rendering = true
        try {
            val r = engine.render(c, filterId, showingInput, frame)
            val bmp = withContext(Dispatchers.Default) { Bitmap.createBitmap(r.frame.toArgb(), r.frame.w, r.frame.h, Bitmap.Config.ARGB_8888) }
            render = RenderState(bmp, r.frame, r.info, r.meta, r.index, r.ms, showingInput)
            if (frame != r.index) frame = r.index
            renderError = null
        } catch (e: CancellationException) { throw e
        } catch (e: Cancelled) { // superseded by a newer version of the project: its render follows
        } catch (e: FilterException) { lastError = e; renderError = (e.message ?: "Error") to e.filterId
        } catch (e: OutOfMemoryError) { engine.clearCache(); renderError = "Not enough memory for this frame: lower the resolution (Resize) or clear the cache." to null
        } catch (e: Exception) { renderError = (e.message ?: e.javaClass.simpleName) to null
        } finally { rendering = false }
    }

    fun togglePlay() { if (playing) stop() else play() }

    fun stop() { playing = false; playJob?.cancel(); playJob = null }

    fun play() {
        val c = chainId ?: return
        val n = render?.info?.frameCount ?: return
        if (n <= 1) return
        playing = true
        playJob = viewModelScope.launch {
            var i = if (frame >= (outPoint ?: n - 1)) (inPoint ?: 0) else frame
            while (isActive && playing) {
                val t0 = System.nanoTime()
                val fps = (render?.info?.fps ?: 25.0) * speed
                val next = async(Dispatchers.Default) { runCatching { engine.render(c, filterId, showingInput, min(n - 1, i + 1)) } }
                val r = try { engine.render(c, filterId, showingInput, i) } catch (e: Cancelled) { continue } catch (e: Exception) { renderError = (e.message ?: "Error") to (e as? FilterException)?.filterId; break }
                val bmp = withContext(Dispatchers.Default) { Bitmap.createBitmap(r.frame.toArgb(), r.frame.w, r.frame.h, Bitmap.Config.ARGB_8888) }
                render = RenderState(bmp, r.frame, r.info, r.meta, r.index, r.ms, showingInput); frame = r.index
                next.cancel()
                val end = outPoint ?: (n - 1)
                if (i >= end) { playing = false; break }
                i++
                val wait = (1e9 / fps - (System.nanoTime() - t0)).toLong() / 1_000_000
                if (wait > 0) delay(wait)
            }
            playing = false
        }
    }

    // ------------------------------------------------------------ opening media and projects
    private fun persist(uri: Uri) { try { ctx.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) { } }

    private fun kindOf(f: EvidenceFile, head: ByteArray): String {
        val ext = f.name.substringAfterLast('.', "").lowercase()
        return when {
            ext == "lfp" || ext == "json" -> "project"
            PngCodec.isPng(head) || TiffCodec.isTiff(head) -> "image"
            StreamSource.isAvi(head) -> "avi"
            f.mime?.startsWith("image/") == true || ext in setOf("jpg", "jpeg", "bmp", "gif", "webp", "heic", "heif", "avif", "png", "tif", "tiff", "dng") -> "image"
            ext in StreamSource.RAW_EXT -> "raw"
            f.mime?.startsWith("video/") == true || ext in setOf("mp4", "m4v", "mov", "mkv", "webm", "3gp", "ts", "mts", "m2ts", "mpg", "mpeg", "flv") -> "video"
            StreamSource.isRaw(f.name, head) -> "raw"
            else -> "video"
        }
    }

    fun openUris(uris: List<Uri>, sequence: Boolean = false) {
        if (uris.isEmpty()) return
        uris.forEach(::persist)
        viewModelScope.launch {
            val files = withContext(Dispatchers.IO) { uris.map { Files.describe(ctx, it) } }
            if (sequence && files.size > 1) { openSequence(files); return@launch }
            for (f in files) {
                try {
                    val head = withContext(Dispatchers.IO) { Files.head(ctx, f.uri, 64) }
                    when (val k = kindOf(f, head)) {
                        "project" -> openProject(f.uri)
                        else -> openMedia(f, k)
                    }
                } catch (e: Exception) { toast("${f.name}: ${e.message ?: e.javaClass.simpleName}") }
            }
        }
    }

    private suspend fun openSource(id: String, files: List<EvidenceFile>, kind: String, fps: Double = 25.0): SourceProvider {
        task("open:$id", "Opening ${files.first().name}", 0.0)
        try {
            val src = when (kind) {
                "image" -> withContext(Dispatchers.IO) { ImageSource.open(ctx, id, files.first()) }
                "sequence" -> withContext(Dispatchers.IO) { SequenceSource.open(ctx, id, files, fps) }
                "avi", "raw" -> StreamSource.open(ctx, id, files.first(), withContext(Dispatchers.IO) { Files.head(ctx, files.first().uri, 64) })
                else -> VideoSource.open(ctx, id, files.first())
            }
            engine.addSource(id, src)
            sourceInfos[id] = src.info
            if (!src.info.frameTypesReady) viewModelScope.launch {
                runCatching { src.analyze { task("analyze:$id", "Analyzing frame types", it) } }
                task("analyze:$id", "", 1.0, true)
                sourceInfos[id] = src.info; engine.clearCache(); requestRender()
            }
            return src
        } finally { task("open:$id", "", 1.0, true) }
    }

    private fun hashLater(id: String, files: List<EvidenceFile>) {
        if (!prefs.hashOnLoad) return
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val h = if (files.size == 1) Files.hash(ctx, files[0].uri, { task("hash:$id", "Hashing ${files[0].name}", it) }) else null
                h?.let { hh -> withContext(Dispatchers.Main) {
                    project.sources[id]?.let { ref -> project = project.copy(sources = project.sources + (id to ref.copy(md5 = hh.md5, sha1 = hh.sha1, sha256 = hh.sha256))); scheduleSave() }
                } }
            } catch (e: Exception) { toast("Hashing failed: ${e.message}") } finally { task("hash:$id", "", 1.0, true) }
        }
    }

    private fun refOf(id: String, kind: String, files: List<EvidenceFile>, options: Map<String, Any?> = emptyMap()) =
        SourceRef(id, if (kind == "avi" || kind == "raw") "video" else kind, if (files.size == 1) files[0].name else "${files[0].name} … (${files.size} images)",
            files.map { SourceFileRef(it.name, it.size, it.lastModified, it.mime ?: "") }, options, uris = files.map { it.uri.toString() })

    private suspend fun openMedia(f: EvidenceFile, kind: String) {
        val id = uid("s")
        val src = openSource(id, listOf(f), kind)
        val loader = if (kind == "image") "image_loader" else "video_loader"
        val fi = newFilter(loader).let { it.copy(params = it.params + ("source" to id)) }
        val c = ChainDoc(uid("c"), f.name.substringBeforeLast('.'), listOf(fi))
        mutate { p -> p.copy(chains = p.chains + c, sources = p.sources + (id to refOf(id, kind, listOf(f)))) }
        selectChain(c.id)
        hashLater(id, listOf(f))
        if (src.info.vfr != null) toast("Variable frame rate: ${src.info.vfr}")
    }

    private suspend fun openSequence(files: List<EvidenceFile>) {
        val id = uid("s")
        try {
            openSource(id, files, "sequence")
            val fi = newFilter("sequence_loader").let { it.copy(params = it.params + ("source" to id)) }
            val c = ChainDoc(uid("c"), files.sortedWith { a, b -> Files.naturalOrder.compare(a.name, b.name) }.first().name.substringBeforeLast('.') + " sequence", listOf(fi))
            mutate { p -> p.copy(chains = p.chains + c, sources = p.sources + (id to refOf(id, "sequence", files, mapOf("fps" to 25.0)))) }
            selectChain(c.id)
        } catch (e: Exception) { toast("Image sequence: ${e.message}") }
    }

    fun addTestPattern(pattern: String, label: String) {
        val f = newFilter("test_pattern")
        val plate = pattern == "plate"
        val params = f.params + mapOf("pattern" to pattern, "frames" to if (plate) 60.0 else 1.0, "blur" to if (plate) 9.0 else 0.0, "shake" to if (plate) 4.0 else 0.0, "noise" to if (plate) 10.0 else 3.0)
        val c = ChainDoc(uid("c"), label, listOf(f.copy(params = params)))
        mutate { p -> p.copy(chains = p.chains + c) }
        selectChain(c.id)
    }

    /** Loads the logo image of an Add Logo filter as a source. */
    fun setImageParam(filterId: String, key: String, uri: Uri) {
        persist(uri)
        viewModelScope.launch {
            try {
                val f = withContext(Dispatchers.IO) { Files.describe(ctx, uri) }
                val id = uid("s")
                openSource(id, listOf(f), "image")
                mutate { p -> p.copy(sources = p.sources + (id to refOf(id, "image", listOf(f)))) }
                setParam(filterId, key, id)
            } catch (e: Exception) { toast("Image: ${e.message}") }
        }
    }

    /** Points a loader at another file (relink missing media). */
    fun relink(sourceId: String, uris: List<Uri>) {
        uris.forEach(::persist)
        viewModelScope.launch {
            try {
                val files = withContext(Dispatchers.IO) { uris.map { Files.describe(ctx, it) } }
                val ref = project.sources[sourceId]
                val kind = when { ref?.kind == "sequence" -> "sequence"; ref?.kind == "image" -> "image"; else -> kindOf(files[0], withContext(Dispatchers.IO) { Files.head(ctx, files[0].uri) }) }
                openSource(sourceId, files, kind, (ref?.options?.get("fps") as? Double) ?: 25.0)
                val newRef = refOf(sourceId, kind, files, ref?.options ?: emptyMap())
                project = project.copy(sources = project.sources + (sourceId to newRef))
                engine.setProject(project.chains); requestRender(); scheduleSave()
                hashLater(sourceId, files)
                ref?.files?.firstOrNull()?.let { old -> if (old.size != files.sumOf { it.size } && files.size == 1) toast("Warning: the relinked file has a different size (${files[0].size} vs ${old.size} bytes).") }
            } catch (e: Exception) { toast("Relink: ${e.message}") }
        }
    }

    private suspend fun reopenSources(p: ProjectDoc): List<String> {
        val missing = ArrayList<String>()
        for ((id, ref) in p.sources) {
            if (engine.sources.containsKey(id)) continue
            try {
                if (ref.uris.isEmpty()) { missing.add(ref.name); continue }
                val files = withContext(Dispatchers.IO) { ref.uris.map { Files.describe(ctx, Uri.parse(it)) } }
                val kind = when (ref.kind) { "sequence" -> "sequence"; "image" -> "image"; else -> kindOf(files[0], withContext(Dispatchers.IO) { Files.head(ctx, files[0].uri) }) }
                openSource(id, files, kind, (ref.options["fps"] as? Double) ?: 25.0)
            } catch (_: Exception) { missing.add(ref.name) }
        }
        return missing
    }

    fun openProject(uri: Uri) {
        viewModelScope.launch {
            try {
                persist(uri)
                val text = withContext(Dispatchers.IO) { String(Files.readAll(ctx, uri)) }
                val p = ProjectJson.read(text)
                newProject()
                projectUri = uri
                val missing = reopenSources(p)
                publish(p); dirty = false
                chainId = p.chains.firstOrNull()?.id; filterId = chain?.filters?.lastOrNull()?.id; requestRender()
                toast(if (missing.isEmpty()) "Project \"${p.name}\" opened." else "Project opened. ${missing.size} media file(s) must be relinked (History › Relink): ${missing.take(3).joinToString()}")
            } catch (e: Exception) { toast("This project cannot be opened: ${e.message}") }
        }
    }

    fun saveProject(uri: Uri) {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                ctx.contentResolver.openOutputStream(uri, "wt")?.use { it.write(ProjectJson.write(project).toByteArray()) } ?: throw IllegalStateException("cannot write")
                projectUri = uri; withContext(Dispatchers.Main) { dirty = false }
                toast("Project saved.")
            } catch (e: Exception) { toast("Save failed: ${e.message}") }
        }
    }

    // ------------------------------------------------------------ session (survives the app being killed)
    private var saveJob: Job? = null
    private fun scheduleSave() {
        if (!prefs.autoSave) return
        saveJob?.cancel()
        saveJob = viewModelScope.launch(Dispatchers.IO) { delay(1200); runCatching { sessionFile.writeText(ProjectJson.write(project)) } }
    }

    private suspend fun restoreSession() {
        if (!prefs.autoSave || !sessionFile.exists()) return
        try {
            val p = ProjectJson.read(withContext(Dispatchers.IO) { sessionFile.readText() })
            if (p.chains.isEmpty()) return
            val missing = reopenSources(p)
            publish(p); dirty = false
            toast("Previous session restored${if (missing.isNotEmpty()) " (${missing.size} file(s) need relinking)" else ""}. File › New Project starts over.")
        } catch (_: Exception) { }
    }

    // ------------------------------------------------------------ exports and reports
    var exportJob: Job? by mutableStateOf(null); private set
    var exportProgress by mutableStateOf(0.0); private set
    var exportResult by mutableStateOf<WriteResult?>(null)

    fun export(uri: Uri, name: String, format: String, range: String, fps: Double, quality: Double, chainId: String? = this.chainId, filterId: String? = null) {
        val c = chainId ?: return
        exportResult = null; exportProgress = 0.0
        exportJob = viewModelScope.launch {
            try {
                val s = engine.streamFor(c, filterId ?: project.chains.firstOrNull { it.id == c }?.filters?.lastOrNull()?.id)
                val n = s.info.frameCount
                val (a, b) = when (range) { "current" -> frame.coerceIn(0, n - 1) to frame.coerceIn(0, n - 1); "inout" -> (inPoint ?: 0).coerceIn(0, n - 1) to (outPoint ?: n - 1).coerceIn(0, n - 1); else -> 0 to n - 1 }
                exportResult = Exporter.write(ctx, s, uri, name, format, min(a, b), max(a, b), fps, quality) { exportProgress = it }
                toast("Export complete: ${exportResult?.verified}")
            } catch (e: CancellationException) { runCatching { android.provider.DocumentsContract.deleteDocument(ctx.contentResolver, uri) }; toast("Export cancelled.")
            } catch (e: Exception) { toast("Export failed: ${e.message}") } finally { exportJob = null }
        }
    }

    fun cancelExport() { exportJob?.cancel() }

    fun report(uri: Uri) {
        val c = chain ?: return
        viewModelScope.launch {
            task("report", "Writing report", 0.5)
            try {
                val r = render
                withContext(Dispatchers.IO) { Report.write(ctx, uri, ReportInput(project, c, sourceInfos.toMap(), r?.frame, r?.index ?: 0, r?.meta, r?.info)) }
                toast("Report saved (PDF).")
            } catch (e: Exception) { toast("Report failed: ${e.message}") } finally { task("report", "", 1.0, true) }
        }
    }

    fun snapshotMd5(): String? = render?.frame?.let { frameMd5(it) }

    fun hashFile(uri: Uri, onDone: (EvidenceFile, Hashes) -> Unit) {
        persist(uri)
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val f = Files.describe(ctx, uri)
                val h = Files.hash(ctx, uri, { task("hashfile", "Hashing ${f.name}", it) })
                withContext(Dispatchers.Main) { onDone(f, h) }
            } catch (e: Exception) { toast("Hashing failed: ${e.message}") } finally { task("hashfile", "", 1.0, true) }
        }
    }

    /** Auto Levels (Levels filter action): input black/white from the 0.5% / 99.5% percentiles of the filter input. */
    fun autoLevels(filterId: String) {
        val c = chain ?: return
        viewModelScope.launch {
            try {
                val r = engine.render(c.id, filterId, true, frame)
                val Y = luma(r.frame); val h = com.clearufo.forensics.engine.kernels.histogramPlane(Y)
                val lo = com.clearufo.forensics.engine.kernels.percentileFromHist(h, Y.size, 0.005); val hi = com.clearufo.forensics.engine.kernels.percentileFromHist(h, Y.size, 0.995)
                mutate { p -> p.copy(chains = p.chains.map { ch -> if (ch.id != c.id) ch else ch.copy(filters = ch.filters.map { f -> if (f.id == filterId) f.copy(params = f.params + mapOf("inBlack" to lo.toDouble(), "inWhite" to max(lo + 1, hi).toDouble())) else f }) }) }
            } catch (e: Exception) { toast("Auto Levels: ${e.message}") }
        }
    }

    override fun onCleared() { stop(); for (s in engine.sources.values) s.dispose() }
}
