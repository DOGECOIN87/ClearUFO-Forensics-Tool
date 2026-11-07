package com.clearufo.forensics.engine

import com.clearufo.forensics.engine.filters.BuildCtx
import com.clearufo.forensics.engine.filters.FilterImpl
import com.clearufo.forensics.engine.filters.basicFilters
import com.clearufo.forensics.engine.filters.linkFilters
import com.clearufo.forensics.engine.filters.presentationFilters
import com.clearufo.forensics.engine.filters.temporalFilters
import com.clearufo.forensics.engine.kernels.Cancelled
import com.clearufo.forensics.media.SourceProvider
import com.clearufo.forensics.project.ChainDoc
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap

// Processing engine (port of engine/engine.ts). Each chain is evaluated lazily: every active filter becomes a node
// whose key is a hash of its type, parameters and upstream key. Changing a parameter only invalidates the nodes
// downstream of it; frames of every node are cached in a byte-budgeted LRU shared by the whole project.

val IMPLS: Map<String, FilterImpl> = basicFilters + temporalFilters + linkFilters + presentationFilters

/**
 * Byte-budgeted LRU of computed frames; concurrent requests for the same frame share one computation. Computations run
 * in the engine's own scope, not in the coroutine of whoever asked first: a caller that is cancelled (playback paused,
 * a render superseded by a newer one) stops waiting, but never cancels a frame that other renders are waiting for.
 */
class FrameCache(@Volatile var limit: Long, private val scope: CoroutineScope) {
    private class Entry { lateinit var d: Deferred<Frame>; var bytes = 0L; var waiters = 0 }
    private val map = LinkedHashMap<String, Entry>(64, 0.75f, true)
    @Volatile var bytes = 0L; private set

    suspend fun getOrCompute(key: String, compute: suspend () -> Frame): Frame {
        val e = synchronized(this) {
            (map[key] ?: Entry().also { ent ->
                map[key] = ent
                ent.d = scope.async(start = CoroutineStart.LAZY) {
                    try {
                        compute().also { f -> synchronized(this@FrameCache) { if (map[key] === ent) { ent.bytes = f.bytes; bytes += f.bytes; evict() } } }
                    } catch (t: Throwable) {
                        synchronized(this@FrameCache) { if (map[key] === ent) map.remove(key) }
                        throw t
                    }
                }
            }).also { it.waiters++ }
        }
        e.d.start()
        try {
            return e.d.await()
        } finally {
            // a frame nobody waits for any more (scrubbing, a superseded render) is abandoned with its upstream work,
            // instead of filling the memory with full-resolution frames no one will look at
            synchronized(this) {
                e.waiters--
                if (e.waiters == 0 && !e.d.isCompleted) { if (map[key] === e) map.remove(key); e.d.cancel() }
            }
        }
    }

    private fun evict() {
        val it = map.entries.iterator()
        while (bytes > limit && it.hasNext()) {
            val e = it.next().value
            if (!e.d.isCompleted || map.size <= 1) continue
            bytes -= e.bytes; it.remove()
        }
    }

    fun clear() = synchronized(this) { map.clear(); bytes = 0 }
    val entries: Int get() = synchronized(this) { map.size }
}

data class Rendered(val frame: Frame, val info: StreamInfo, val meta: FrameMeta, val index: Int, val ms: Long)

class Engine {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val sources = ConcurrentHashMap<String, SourceProvider>()
    private val sourceTokens = ConcurrentHashMap<String, Int>()
    /**
     * One consistent version of the project: a render evaluates the chains and their cache keys of a single snapshot,
     * even while the user edits the project (which publishes a new snapshot).
     */
    private class Snapshot(val chains: Map<String, ChainDoc>) { val keyMemo = ConcurrentHashMap<String, List<String>>() }
    @Volatile private var snap = Snapshot(emptyMap())
    private val chains: Map<String, ChainDoc> get() = snap.chains
    private class Node(val key: String, val stream: Deferred<Stream>)
    private val nodes = ConcurrentHashMap<String, Node>()
    val cache = FrameCache((Runtime.getRuntime().maxMemory() * 0.25).toLong(), scope)

    private val _progress = MutableStateFlow<Map<String, Pair<String, Double>>>(emptyMap())
    val progress: StateFlow<Map<String, Pair<String, Double>>> = _progress

    fun progress(task: String, label: String, v: Double, done: Boolean = false) {
        _progress.update { if (done || v >= 1) it - task else it + (task to (label to v)) }
    }

    // ------------------------------------------------------------ sources
    fun addSource(id: String, src: SourceProvider) {
        sources.put(id, src)?.takeIf { it !== src }?.dispose()
        sourceTokens[id] = (sourceTokens[id] ?: 0) + 1
        snap = Snapshot(snap.chains); cache.clear()
    }

    fun closeSource(id: String) {
        sources.remove(id)?.dispose()
        sourceTokens[id] = (sourceTokens[id] ?: 0) + 1
        snap = Snapshot(snap.chains); cache.clear()
    }

    fun clearCache() = cache.clear()

    // ------------------------------------------------------------ project
    fun setProject(list: List<ChainDoc>) {
        snap = Snapshot(list.associateBy { it.id })
        val alive = list.flatMap { c -> c.filters.map { it.id } }.toSet()
        nodes.keys.retainAll(alive)
    }

    fun chain(id: String): ChainDoc? = chains[id]

    private fun chainKeys(sn: Snapshot, chainId: String, visiting: MutableSet<String> = HashSet()): List<String> {
        sn.keyMemo[chainId]?.let { return it }
        if (!visiting.add(chainId)) throw IllegalStateException("Circular reference between chains (a chain uses itself as input)")
        val chain = sn.chains[chainId] ?: throw IllegalStateException("Linked chain not found")
        val keys = ArrayList<String>()
        var key = "root"
        chain.filters.forEachIndexed { i, f ->
            val def = FILTERS[f.type]
            if (def != null && (i == 0 || f.enabled) && def.kind != FilterKind.WRITER) {
                val deps = StringBuilder()
                for (pd in def.params) {
                    if (pd is ChainParam) (f.params[pd.key] as? String)?.takeIf { it.isNotEmpty() }?.let { deps.append("|").append(lastKey(sn, it, visiting)) }
                    if (pd is ChainsParam) (f.params[pd.key] as? List<*>)?.forEach { id -> if (id is String && id != chainId) deps.append("|").append(lastKey(sn, id, visiting)) }
                }
                val src = (f.params["source"] as? String)?.takeIf { it.isNotEmpty() }?.let { "|src:$it:${if (sources.containsKey(it)) 1 else 0}:${sourceTokens[it] ?: 0}" } ?: ""
                val img = (f.params["image"] as? String)?.takeIf { it.isNotEmpty() }?.let { "|img:$it:${sourceTokens[it] ?: 0}" } ?: ""
                key = hash64("$key>${f.type}:${ParamJson.stable(f.params)}$deps$src$img")
            }
            keys.add(key)
        }
        visiting.remove(chainId)
        sn.keyMemo[chainId] = keys
        return keys
    }

    private fun lastKey(sn: Snapshot, chainId: String, visiting: MutableSet<String>) = chainKeys(sn, chainId, visiting).lastOrNull() ?: "empty"

    private fun hash64(s: String): String {
        var h = -0x340d631b7bdddcdbL // FNV-1a 64
        for (c in s) { h = h xor c.code.toLong(); h *= 0x100000001b3L }
        var g = 0x9E3779B97F4A7C15uL.toLong()
        for (c in s) { g = (g xor c.code.toLong()) * -0x40a7b892e31b1a47L; g = g xor (g ushr 29) }
        return java.lang.Long.toHexString(h) + java.lang.Long.toHexString(g)
    }

    private fun ctxFor(sn: Snapshot, chain: ChainDoc, filterId: String, key: String) = object : BuildCtx {
        override val chainId = chain.id
        override val filterId = filterId
        override val key = key
        override fun source(id: String) = sources[id] ?: throw IllegalStateException("The media file of this loader is not available: use Relink Media to locate it")
        override suspend fun chainStream(id: String) = chainOutput(id, sn)
        override fun chainName(id: String) = sn.chains[id]?.name ?: "?"
        override suspend fun originalStream() = streamAt(chain.id, 0, sn)
        override fun sourceOfChain(): SourceProvider? = (chain.filters.firstOrNull()?.params?.get("source") as? String)?.let { sources[it] }
        override fun progress(label: String, v: Double) = this@Engine.progress("node:$filterId", label, v, v >= 1)
        override fun isStale() = nodes[filterId]?.key != key
    }

    private fun wrap(s: Stream, key: String, filterId: String, name: String) = object : Stream {
        override val info = s.info
        override fun meta(i: Int) = s.meta(i)
        override suspend fun getFrame(i: Int): Frame {
            val fi = i.coerceIn(0, maxOf(0, s.info.frameCount - 1))
            return cache.getOrCompute("$key#$fi") {
                try {
                    try { s.getFrame(fi) }
                    catch (e: OutOfMemoryError) {
                        // free the cached frames and try once more before giving up
                        cache.clear(); System.gc()
                        s.getFrame(fi)
                    }
                }
                catch (e: FilterException) { throw e }
                catch (e: Cancelled) { throw e }
                catch (e: kotlinx.coroutines.CancellationException) { throw e }
                catch (e: OutOfMemoryError) { cache.clear(); throw FilterException("$name: not enough memory for a ${s.info.width}×${s.info.height} frame here. Use a smaller Size/window, fewer filters, or Resize before this step.", filterId) }
                catch (e: Exception) { throw FilterException("$name: ${e.message ?: e.javaClass.simpleName}", filterId, e) }
            }
        }
    }

    private suspend fun streamAt(chainId: String, idx: Int, sn: Snapshot): Stream {
        val chain = sn.chains[chainId] ?: throw IllegalStateException("Chain not found")
        if (chain.filters.isEmpty()) throw IllegalStateException("The chain is empty")
        val keys = chainKeys(sn, chainId)
        var stream: Stream? = null
        for (i in 0..minOf(idx, chain.filters.size - 1)) {
            val f = chain.filters[i]
            val def = FILTERS[f.type] ?: throw FilterException("Unknown filter type \"${f.type}\"", f.id)
            if ((i > 0 && !f.enabled) || def.kind == FilterKind.WRITER) continue
            if (i == 0 && def.kind != FilterKind.LOADER && def.kind != FilterKind.LINK) throw FilterException("The first filter of a chain must be a loader (found \"${def.name}\")", f.id)
            if (i > 0 && def.kind == FilterKind.LOADER) throw FilterException("\"${def.name}\" can only be the first filter of a chain", f.id)
            val impl = IMPLS[f.type] ?: throw FilterException("\"${def.name}\" is not implemented", f.id)
            val key = keys[i]
            var node = nodes[f.id]
            if (node == null || node.key != key) {
                val input = stream
                val params = normalizeParams(def, f.params) + ("__type" to f.type)
                val ctx = ctxFor(sn, chain, f.id, key)
                val d = scope.async(start = CoroutineStart.LAZY) { wrap(impl(input, params, ctx), key, f.id, def.name) }
                val n = Node(key, d)
                nodes[f.id] = n
                node = n
            }
            stream = try { node.stream.await() } catch (e: Throwable) {
                if (nodes[f.id] === node) nodes.remove(f.id)
                if (e is kotlinx.coroutines.CancellationException || e is Cancelled) throw e
                throw if (e is FilterException) e else FilterException("${def.name}: ${e.message ?: e.javaClass.simpleName}", f.id, e)
            }
        }
        return stream ?: throw IllegalStateException("No active filters")
    }

    private suspend fun chainOutput(chainId: String, sn: Snapshot): Stream {
        val c = sn.chains[chainId] ?: throw IllegalStateException("Linked chain not found")
        return streamAt(chainId, c.filters.size - 1, sn)
    }

    fun indexFor(chain: ChainDoc, filterId: String?, input: Boolean): Int {
        var idx = if (filterId != null) chain.filters.indexOfFirst { it.id == filterId } else chain.filters.size - 1
        if (idx < 0) idx = chain.filters.size - 1
        if (input) {
            idx--
            while (idx > 0 && (!chain.filters[idx].enabled || FILTERS[chain.filters[idx].type]?.kind == FilterKind.WRITER)) idx--
        }
        return idx
    }

    suspend fun streamFor(chainId: String, filterId: String?, input: Boolean = false): Stream {
        val sn = snap
        val chain = sn.chains[chainId] ?: throw IllegalStateException("Chain not found")
        val idx = indexFor(chain, filterId, input)
        if (idx < 0) throw IllegalStateException("No input: this is the first filter of the chain")
        return streamAt(chainId, idx, sn)
    }

    suspend fun streamInfo(chainId: String, filterId: String?, input: Boolean = false): StreamInfo? = try { streamFor(chainId, filterId, input).info } catch (_: Exception) { null }

    suspend fun render(chainId: String, filterId: String?, input: Boolean, frame: Int): Rendered = withContext(Dispatchers.Default) {
        val t0 = System.nanoTime()
        try {
            val s = streamFor(chainId, filterId, input)
            val n = s.info.frameCount
            val i = frame.coerceIn(0, maxOf(0, n - 1))
            val f = s.getFrame(i)
            Rendered(f, s.info, s.meta(i), i, (System.nanoTime() - t0) / 1_000_000)
        } finally {
            // filters report partial progress (e.g. Wiener deblurring); a finished render ends their tasks
            _progress.update { m -> m.filterKeys { !it.startsWith("node:") } }
        }
    }
}
