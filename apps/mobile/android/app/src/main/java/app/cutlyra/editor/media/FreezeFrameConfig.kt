package app.cutlyra.editor.media

import org.json.JSONObject

/**
 * Pure-logic model for a Freeze Frame operation (M10 sprint).
 *
 * A freeze frame holds a single source frame of an element for [holdDurationMicros]
 * and is fully reversible: applying it never mutates the source media, and
 * `reversible` records whether the operation can be undone (always true for a
 * freshly captured freeze; older persisted configs may carry false for legacy
 * reasons).
 *
 * All logic here is android-framework-free so it can be unit-tested on the JVM
 * without Robolectric/emulator.
 */
data class FreezeFrameConfig(
    val id: String,
    val sourceElementId: String,
    val sourceFrameTimestampMicros: Long,
    val holdDurationMicros: Long,
    val targetElementId: String,
    val reversible: Boolean = true,
) {
    init {
        require(id.isNotBlank()) { "id must not be blank" }
        require(sourceElementId.isNotBlank()) { "sourceElementId must not be blank" }
        require(targetElementId.isNotBlank()) { "targetElementId must not be blank" }
        require(holdDurationMicros >= 0) { "holdDurationMicros must be >= 0" }
        require(sourceFrameTimestampMicros >= 0) { "sourceFrameTimestampMicros must be >= 0" }
    }

    /** Serializes to a stable JSON object for project persistence / migration. */
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("sourceElementId", sourceElementId)
        put("sourceFrameTimestampMicros", sourceFrameTimestampMicros)
        put("holdDurationMicros", holdDurationMicros)
        put("targetElementId", targetElementId)
        put("reversible", reversible)
    }

    /** Returns a copy with a new hold duration (idempotent edit). */
    fun withHoldDuration(micros: Long): FreezeFrameConfig {
        require(micros >= 0) { "holdDurationMicros must be >= 0" }
        return copy(holdDurationMicros = micros)
    }

    /** Returns true when two configs describe the same freeze (idempotency key). */
    fun sameFreeze(other: FreezeFrameConfig): Boolean =
        sourceElementId == other.sourceElementId &&
            sourceFrameTimestampMicros == other.sourceFrameTimestampMicros &&
            targetElementId == other.targetElementId

    companion object {
        fun fromJson(json: JSONObject): FreezeFrameConfig = FreezeFrameConfig(
            id = json.getString("id"),
            sourceElementId = json.getString("sourceElementId"),
            sourceFrameTimestampMicros = json.getLong("sourceFrameTimestampMicros"),
            holdDurationMicros = json.getLong("holdDurationMicros"),
            targetElementId = json.getString("targetElementId"),
            reversible = json.optBoolean("reversible", true),
        )

        /** Builds a new config with a fresh id derived from the inputs. */
        fun create(
            sourceElementId: String,
            sourceFrameTimestampMicros: Long,
            holdDurationMicros: Long,
            targetElementId: String,
        ): FreezeFrameConfig = FreezeFrameConfig(
            id = "ff-${sourceElementId}-${sourceFrameTimestampMicros}",
            sourceElementId = sourceElementId,
            sourceFrameTimestampMicros = sourceFrameTimestampMicros,
            holdDurationMicros = holdDurationMicros,
            targetElementId = targetElementId,
            reversible = true,
        )
    }
}

/**
 * Pure helper for idempotent apply/undo of freeze-frame configs against a list.
 */
object FreezeFrameOps {
    /** Returns a list with [config] appended unless an identical freeze already
     *  exists (idempotent apply). */
    fun apply(list: List<FreezeFrameConfig>, config: FreezeFrameConfig): List<FreezeFrameConfig> {
        if (list.any { it.sameFreeze(config) }) return list
        return list + config
    }

    /** Removes the freeze with the given id (undo). Returns the new list. */
    fun undo(list: List<FreezeFrameConfig>, id: String): List<FreezeFrameConfig> =
        list.filterNot { it.id == id }

    /** Serializes a list to a JSON array string for persistence. */
    fun serialize(list: List<FreezeFrameConfig>): String {
        val arr = org.json.JSONArray()
        list.forEach { arr.put(it.toJson()) }
        return arr.toString()
    }

    /** Deserializes a list from a JSON array string (migration-safe: skips
     *  malformed entries). */
    fun deserialize(raw: String?): List<FreezeFrameConfig> {
        if (raw.isNullOrBlank()) return emptyList()
        return try {
            val arr = org.json.JSONArray(raw)
            (0 until arr.length()).mapNotNull { i ->
                try { FreezeFrameConfig.fromJson(arr.getJSONObject(i)) } catch (_: Exception) { null }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }
}