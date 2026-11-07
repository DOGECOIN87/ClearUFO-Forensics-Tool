package com.clearufo.forensics.project

import com.clearufo.forensics.engine.FILTERS
import com.clearufo.forensics.engine.ParamJson
import com.clearufo.forensics.engine.defaultParams
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

// Project document: the same JSON structure (and schema number) as the browser workbench's .lfp files, so a case
// started on a computer can be continued on the phone and vice versa. Media are referenced by name, size and hash.

const val APP_NAME = "ClearUFO Forensics"
const val PROJECT_EXT = ".lfp"
/** 3: Video Loaders carry explicit Chroma Filter and HDR Video choices (see shared/project.ts). */
const val PROJECT_SCHEMA = 3

data class FilterInstance(val id: String, val type: String, val params: Map<String, Any?>, val enabled: Boolean = true)
data class ChainDoc(val id: String, val name: String, val filters: List<FilterInstance>)
data class SourceFileRef(val name: String, val size: Long, val lastModified: Long, val type: String)
data class SourceRef(
    val id: String, val kind: String, val name: String, val files: List<SourceFileRef>,
    val options: Map<String, Any?> = emptyMap(), val md5: String? = null, val sha1: String? = null, val sha256: String? = null,
    /** Android only: content URIs of the files (persisted read permission), so the project reopens its media. */
    val uris: List<String> = emptyList(),
)
data class CaseInfo(val caseNumber: String = "", val examiner: String = "", val agency: String = "", val exhibit: String = "", val notes: String = "")
data class Bookmark(val id: String, val chainId: String, val frame: Int, val note: String)

data class ProjectDoc(
    val name: String = "Untitled",
    val chains: List<ChainDoc> = emptyList(),
    val sources: Map<String, SourceRef> = emptyMap(),
    val caseInfo: CaseInfo = CaseInfo(),
    val bookmarks: List<Bookmark> = emptyList(),
    val created: String = Instant.now().toString(),
    val modified: String = Instant.now().toString(),
    val schema: Int = PROJECT_SCHEMA,
)

fun uid(prefix: String = "id"): String = "${prefix}_${java.lang.Long.toString(System.currentTimeMillis(), 36)}${java.lang.Long.toString((Math.random() * 2176782336L).toLong(), 36).padStart(6, '0').take(6)}"

fun newFilter(type: String): FilterInstance = FilterInstance(uid("f"), type, defaultParams(FILTERS.getValue(type)), true)

object ProjectJson {
    fun write(p: ProjectDoc): String {
        val o = JSONObject()
        o.put("app", APP_NAME); o.put("schema", PROJECT_SCHEMA); o.put("name", p.name)
        o.put("chains", JSONArray().also { a -> p.chains.forEach { c ->
            a.put(JSONObject().put("id", c.id).put("name", c.name).put("filters", JSONArray().also { fa -> c.filters.forEach { f ->
                fa.put(JSONObject().put("id", f.id).put("type", f.type).put("enabled", f.enabled).put("params", ParamJson.paramsToJson(f.params.filterKeys { !it.startsWith("__") })))
            } }))
        } })
        o.put("sources", JSONObject().also { so -> p.sources.forEach { (k, s) ->
            so.put(k, JSONObject().put("id", s.id).put("kind", s.kind).put("name", s.name)
                .put("files", JSONArray().also { fa -> s.files.forEach { f -> fa.put(JSONObject().put("name", f.name).put("size", f.size).put("lastModified", f.lastModified).put("type", f.type)) } })
                .put("options", ParamJson.paramsToJson(s.options)).apply {
                    s.md5?.let { put("md5", it) }; s.sha1?.let { put("sha1", it) }; s.sha256?.let { put("sha256", it) }
                    if (s.uris.isNotEmpty()) put("androidUris", JSONArray(s.uris))
                })
        } })
        o.put("caseInfo", JSONObject().put("caseNumber", p.caseInfo.caseNumber).put("examiner", p.caseInfo.examiner).put("agency", p.caseInfo.agency).put("exhibit", p.caseInfo.exhibit).put("notes", p.caseInfo.notes))
        o.put("bookmarks", JSONArray().also { a -> p.bookmarks.forEach { b -> a.put(JSONObject().put("id", b.id).put("chainId", b.chainId).put("frame", b.frame).put("note", b.note)) } })
        o.put("created", p.created); o.put("modified", Instant.now().toString())
        return o.toString(2)
    }

    /** Parses and validates a project; parameters added since it was saved get their legacy values (same results). */
    fun read(text: String): ProjectDoc {
        val o = try { JSONObject(text) } catch (e: Exception) { throw IllegalArgumentException("the file does not contain a project") }
        val chainsA = o.optJSONArray("chains") ?: throw IllegalArgumentException(if (o.optString("app").isNotEmpty()) "it was written by “${o.optString("app")}” and has no filter chains" else "no filter chains were found")
        val schema = o.optInt("schema", 1)
        if (schema > PROJECT_SCHEMA) throw IllegalArgumentException("it was saved by a newer version (schema $schema)")
        val unknown = LinkedHashSet<String>()
        val chains = (0 until chainsA.length()).map { ci ->
            val c = chainsA.optJSONObject(ci) ?: throw IllegalArgumentException("chain ${ci + 1} is damaged")
            val fa = c.optJSONArray("filters") ?: throw IllegalArgumentException("chain ${ci + 1} is damaged")
            if (fa.length() == 0) throw IllegalArgumentException("chain ${ci + 1} is damaged")
            ChainDoc(c.getString("id"), c.optString("name", "Chain ${ci + 1}"), (0 until fa.length()).map { fi ->
                val f = fa.getJSONObject(fi)
                val type = f.getString("type")
                val def = FILTERS[type]
                if (def == null) unknown.add(type)
                val params = ParamJson.paramsFromJson(f.optJSONObject("params"))
                // migrateProject: pin the legacy value of parameters the saving version did not have
                def?.params?.forEach { d -> if (d.legacy != null && !params.containsKey(d.key)) params[d.key] = d.legacy }
                FilterInstance(f.getString("id"), type, params, f.optBoolean("enabled", true))
            })
        }
        if (unknown.isNotEmpty()) throw IllegalArgumentException("it uses filters unknown to this version (${unknown.take(5).joinToString(", ")})")
        val sources = LinkedHashMap<String, SourceRef>()
        o.optJSONObject("sources")?.let { so -> for (k in so.keys()) { val s = so.getJSONObject(k)
            val files = s.optJSONArray("files")?.let { fa -> (0 until fa.length()).map { val f = fa.getJSONObject(it); SourceFileRef(f.optString("name"), f.optLong("size"), f.optLong("lastModified"), f.optString("type")) } } ?: emptyList()
            val uris = s.optJSONArray("androidUris")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
            sources[k] = SourceRef(s.optString("id", k), s.optString("kind", "video"), s.optString("name"), files, ParamJson.paramsFromJson(s.optJSONObject("options")),
                s.optString("md5").ifEmpty { null }, s.optString("sha1").ifEmpty { null }, s.optString("sha256").ifEmpty { null }, uris)
        } }
        val ci = o.optJSONObject("caseInfo")
        val bms = o.optJSONArray("bookmarks")?.let { a -> (0 until a.length()).map { val b = a.getJSONObject(it); Bookmark(b.optString("id"), b.optString("chainId"), b.optInt("frame"), b.optString("note")) } } ?: emptyList()
        return ProjectDoc(o.optString("name", "Untitled"), chains, sources,
            CaseInfo(ci?.optString("caseNumber") ?: "", ci?.optString("examiner") ?: "", ci?.optString("agency") ?: "", ci?.optString("exhibit") ?: "", ci?.optString("notes") ?: ""),
            bms, o.optString("created", Instant.now().toString()), o.optString("modified", Instant.now().toString()), PROJECT_SCHEMA)
    }
}
