package com.clearufo.forensics.engine

import org.json.JSONArray
import org.json.JSONObject

data class Pt(val x: Double, val y: Double)
data class RectP(val x: Double, val y: Double, val w: Double, val h: Double)

/**
 * Filter parameter values, keyed like the browser workbench (so .lfp projects open in both):
 * Double (numbers), Boolean, String, Pt, RectP, List<Pt> (points, curves and 2-point lines), List<String>
 * (chain lists), or null.
 */
typealias Params = Map<String, Any?>

fun Params.num(k: String, def: Double = 0.0): Double = when (val v = this[k]) {
    is Number -> v.toDouble()
    is Boolean -> if (v) 1.0 else 0.0
    is String -> v.toDoubleOrNull() ?: def
    else -> def
}

/** JavaScript `value | 0` (truncation toward zero). */
fun Params.int(k: String, def: Int = 0): Int = when (val v = this[k]) {
    is Number -> v.toDouble().let { if (it.isNaN()) 0 else it.toLong().toInt() }
    is Boolean -> if (v) 1 else 0
    is String -> v.toDoubleOrNull()?.toLong()?.toInt() ?: def
    else -> def
}

/** JavaScript truthiness. */
fun Params.bool(k: String): Boolean = when (val v = this[k]) {
    null -> false
    is Boolean -> v
    is Number -> v.toDouble() != 0.0 && !v.toDouble().isNaN()
    is String -> v.isNotEmpty()
    else -> true
}

fun Params.str(k: String, def: String = ""): String = when (val v = this[k]) {
    null -> def
    is Double -> if (v == Math.floor(v) && !v.isInfinite() && kotlin.math.abs(v) < 1e15) v.toLong().toString() else v.toString()
    else -> v.toString()
}

fun Params.pt(k: String): Pt? = this[k] as? Pt
fun Params.rect(k: String): RectP? = this[k] as? RectP
@Suppress("UNCHECKED_CAST")
fun Params.pts(k: String): List<Pt> = (this[k] as? List<*>)?.filterIsInstance<Pt>() ?: emptyList()
fun Params.line(k: String): Pair<Pt, Pt>? { val l = pts(k); return if (l.size >= 2) l[0] to l[1] else null }
fun Params.strs(k: String): List<String> = (this[k] as? List<*>)?.filterIsInstance<String>() ?: emptyList()

// ---------------------------------------------------------------- JSON (same shapes as the browser project files)
object ParamJson {
    fun toJson(v: Any?): Any = when (v) {
        null -> JSONObject.NULL
        is Pt -> JSONObject().put("x", v.x).put("y", v.y)
        is RectP -> JSONObject().put("x", v.x).put("y", v.y).put("w", v.w).put("h", v.h)
        is List<*> -> JSONArray().also { a -> v.forEach { a.put(toJson(it)) } }
        is Map<*, *> -> JSONObject().also { o -> v.forEach { (k, x) -> o.put(k.toString(), toJson(x)) } }
        is Double -> if (v.isNaN() || v.isInfinite()) JSONObject.NULL else v
        is Float -> v.toDouble()
        is Int -> v.toDouble()
        is Long -> v.toDouble()
        else -> v
    }

    fun fromJson(v: Any?): Any? = when (v) {
        null, JSONObject.NULL -> null
        is Boolean -> v
        is Number -> v.toDouble()
        is String -> v
        is JSONObject -> {
            val keys = v.keys().asSequence().toSet()
            if (keys == setOf("x", "y", "w", "h")) RectP(v.optDouble("x"), v.optDouble("y"), v.optDouble("w"), v.optDouble("h"))
            else if (keys == setOf("x", "y")) Pt(v.optDouble("x"), v.optDouble("y"))
            else keys.associateWith { fromJson(v.opt(it)) }
        }
        is JSONArray -> (0 until v.length()).map { fromJson(v.opt(it)) }
        else -> v.toString()
    }

    fun paramsToJson(p: Params): JSONObject = JSONObject().also { o -> p.forEach { (k, v) -> o.put(k, toJson(v)) } }
    fun paramsFromJson(o: JSONObject?): MutableMap<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        if (o == null) return out
        for (k in o.keys()) out[k] = fromJson(o.opt(k))
        return out
    }

    /** Stable text of the values (sorted keys, transient "_" keys skipped): part of the processing cache keys. */
    fun stable(v: Any?): String = when (v) {
        null -> "null"
        is String -> JSONObject.quote(v)
        is Double -> if (v == Math.floor(v) && kotlin.math.abs(v) < 1e15) v.toLong().toString() else v.toString()
        is Number -> v.toString()
        is Boolean -> v.toString()
        is Pt -> "{x:${stable(v.x)},y:${stable(v.y)}}"
        is RectP -> "{h:${stable(v.h)},w:${stable(v.w)},x:${stable(v.x)},y:${stable(v.y)}}"
        is List<*> -> v.joinToString(",", "[", "]") { stable(it) }
        is Map<*, *> -> v.keys.map { it.toString() }.filter { !it.startsWith("_") }.sorted().joinToString(",", "{", "}") { "${JSONObject.quote(it)}:${stable(v[it])}" }
        else -> JSONObject.quote(v.toString())
    }
}

// ---------------------------------------------------------------- parameter definitions
sealed class ParamDef(val key: String, val label: String) {
    var tab: String? = null
    var help: String? = null
    var show: ((Params) -> Boolean)? = null
    var overlayIf: ((Params) -> Boolean)? = null
    /** Value assumed when a saved filter lacks this parameter (older project), when it differs from the default. */
    var legacy: Any? = null
    abstract val default: Any?
    fun visible(p: Params) = show?.invoke(p) ?: true
    val isOverlay: Boolean get() = this is RectParam || this is PointParam || this is PointsParam || this is LineParam
}

class NumberParam(key: String, label: String, val min: Double, val max: Double, override val default: Double, val isInt: Boolean,
                  val decimals: Int = if (isInt) 0 else 2, val step: Double? = null, val slider: Boolean = true, val log: Boolean = false, val unit: String? = null) : ParamDef(key, label)
class SelectParam(key: String, label: String, val options: List<Pair<String, String>>, override val default: String) : ParamDef(key, label)
class BoolParam(key: String, label: String, override val default: Boolean) : ParamDef(key, label)
class ColorParam(key: String, label: String, override val default: String) : ParamDef(key, label)
class TextParam(key: String, label: String, override val default: String, val multiline: Boolean = false) : ParamDef(key, label)
class RectParam(key: String, label: String) : ParamDef(key, label) { override val default: Any? = null }
class PointParam(key: String, label: String, override val default: Pt?) : ParamDef(key, label)
class PointsParam(key: String, label: String, val minPoints: Int = 0, val maxPoints: Int = 1000, val closed: Boolean = false, val polyline: Boolean = false) : ParamDef(key, label) { override val default: Any = emptyList<Pt>() }
class LineParam(key: String, label: String) : ParamDef(key, label) { override val default: Any? = null }
class ChainParam(key: String, label: String) : ParamDef(key, label) { override val default: Any = "" }
class ChainsParam(key: String, label: String) : ParamDef(key, label) { override val default: Any = emptyList<String>() }
class FrameParam(key: String, label: String, override val default: Double, val allowLast: Boolean = false) : ParamDef(key, label)
class CurveParam(key: String, label: String, override val default: List<Pt>) : ParamDef(key, label)
class SourceParam(key: String, label: String) : ParamDef(key, label) { override val default: Any = "" }
class ImageParam(key: String, label: String) : ParamDef(key, label) { override val default: Any = "" }
class ActionParam(key: String, label: String, val action: String) : ParamDef(key, label) { override val default: Any? = null }
class PsfParam(key: String, label: String) : ParamDef(key, label) { override val default: Any? = null }
class FileInfoParam(key: String, label: String) : ParamDef(key, label) { override val default: Any? = null }

/** Parameters that hold no value (buttons and read-only panels). */
val ParamDef.transient: Boolean get() = this is ActionParam || this is PsfParam || this is FileInfoParam

fun ParamDef.format(v: Any?, chainName: (String) -> String = { it }): String {
    if (v == null || v == "") return "—"
    return when (this) {
        is NumberParam -> if (isInt) Math.round((v as? Number)?.toDouble() ?: 0.0).toString() else "%.${decimals}f".format((v as? Number)?.toDouble() ?: 0.0)
        is BoolParam -> if (v == true) "Yes" else "No"
        is SelectParam -> options.firstOrNull { it.first == v }?.second ?: v.toString()
        is RectParam -> (v as? RectP)?.let { "x=${jsRound(it.x)}, y=${jsRound(it.y)}, w=${jsRound(it.w)}, h=${jsRound(it.h)}" } ?: "—"
        is PointParam -> (v as? Pt)?.let { "(%.1f, %.1f)".format(it.x, it.y) } ?: "—"
        is PointsParam -> (v as? List<*>)?.filterIsInstance<Pt>()?.joinToString(" ") { "(%.1f, %.1f)".format(it.x, it.y) }?.ifEmpty { "—" } ?: "—"
        is LineParam -> (v as? List<*>)?.filterIsInstance<Pt>()?.takeIf { it.size >= 2 }?.let { "(%.1f, %.1f) → (%.1f, %.1f)".format(it[0].x, it[0].y, it[1].x, it[1].y) } ?: "—"
        is CurveParam -> (v as? List<*>)?.filterIsInstance<Pt>()?.joinToString(", ") { "${Math.round(it.x)}→${Math.round(it.y)}" } ?: "—"
        is ChainParam -> chainName(v.toString())
        is ChainsParam -> (v as? List<*>)?.joinToString(", ") { chainName(it.toString()) }?.ifEmpty { "—" } ?: "—"
        is FrameParam -> if ((v as? Number)?.toDouble() == -1.0) "Last" else Math.round((v as? Number)?.toDouble() ?: 0.0).toString()
        else -> v.toString()
    }
}
