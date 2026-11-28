package app.cutlyra.editor.media

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.json.JSONObject
import java.util.UUID

/**
 * The library-picker result path, separated from the Capacitor plugin call so
 * it can be driven by an instrumented test with a real multi-item `ClipData`.
 *
 * Two responsibilities, both direct consequences of Android picker behaviour:
 *
 *  1. `urisFrom` reads the picker's `ClipData` in ITS ORDER. The photo picker
 *     returns one URI per selected item and a single-item pick returns the
 *     result `data` instead, so both shapes are handled here. Cancellation is
 *     an empty list (the plugin maps that to `USER_CANCELLED`; the JS layer
 *     treats it as a no-op).
 *     It takes the result code and Intent rather than an `ActivityResult`:
 *     the R8 test variant strips that holder's public constructor (app code
 *     never calls it, Capacitor does), which made a test that constructed one
 *     fail only under minification.
 *
 *  2. `importUris` copies each pick into custody and probes it, one item at a
 *     time, preserving that order — a fast photo must not overtake a slow
 *     video. Per-item failure isolation is deliberate: one unreadable pick is
 *     reported through `onProgress(stage = "error")` without losing the rest
 *     of the batch or leaking the partially copied file.
 */
object MediaPickBatch {
    /** The picked document URIs, in the picker's order. */
    fun urisFrom(resultCode: Int, data: Intent?): List<Uri> {
        if (resultCode != Activity.RESULT_OK) return emptyList()
        if (data == null) return emptyList()
        val uris = mutableListOf<Uri>()
        val clipData = data.clipData
        if (clipData != null) {
            for (index in 0 until clipData.itemCount) {
                clipData.getItemAt(index).uri?.let { uris.add(it) }
            }
        } else {
            data.data?.let { uris.add(it) }
        }
        return uris
    }

    /**
     * Copies and probes every URI in order, returning the handle JSON array the
     * bridge resolves with. `onProgress` matches the `pickProgress` event
     * payload (index, total, stage, fraction, error).
     */
    fun importUris(
        context: Context,
        uris: List<Uri>,
        onProgress: (index: Int, total: Int, stage: String, fraction: Double, error: String?) -> Unit,
    ): JSArray {
        val handles = JSArray()
        for ((index, uri) in uris.withIndex()) {
            onProgress(index, uris.size, "loading", 0.0, null)
            try {
                val imported = MediaImporter.importInto(context, uri)
                try {
                    val probed = MediaProbe.probe(imported.file, imported.mimeType)
                    handles.put(handleToJson(imported, probed))
                    onProgress(index, uris.size, "loaded", 1.0, null)
                } catch (error: Exception) {
                    // The copy succeeded but the probe rejected the file;
                    // delete it so a failed pick does not accumulate custody.
                    MediaImporter.delete(imported.file)
                    throw error
                }
            } catch (error: Exception) {
                onProgress(
                    index,
                    uris.size,
                    "error",
                    1.0,
                    error.message ?: "media import failed",
                )
            }
        }
        return handles
    }

    private fun handleToJson(
        imported: MediaImporter.ImportedFile,
        probed: MediaProbe.ProbedMedia,
    ): JSObject {
        val json = JSObject()
        json.put("id", UUID.randomUUID().toString())
        // A native app-sandbox file path, never a blob: URL — the exact
        // contract `MediaHandle.uri` documents (packages/native-bridge/src/
        // types.ts).
        json.put("uri", Uri.fromFile(imported.file).toString())
        json.put("kind", probed.kind)
        json.put("fileName", imported.fileName)
        json.put("sizeBytes", imported.sizeBytes)
        json.put("durationMicros", probed.durationMicros)
        json.put("width", probed.width)
        json.put("height", probed.height)
        json.put("rotationDegrees", probed.rotationDegrees)
        json.put("hasAudio", probed.hasAudio)
        json.put("codec", probed.codec)
        val frameRate = probed.frameRate
        if (frameRate != null) {
            val frameRateJson = JSObject()
            frameRateJson.put("numerator", frameRate.numerator)
            frameRateJson.put("denominator", frameRate.denominator)
            json.put("frameRate", frameRateJson)
        } else {
            json.put("frameRate", JSONObject.NULL)
        }
        return json
    }
}
