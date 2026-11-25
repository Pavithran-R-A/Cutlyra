package app.cutlyra.editor.media

import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import java.io.File
import java.util.UUID

/**
 * Freeze Frame capture: extracts ONE source frame and writes it as a real PNG
 * inside media custody.
 *
 * Why the source frame (not a composited canvas grab): the frozen still is an
 * ordinary image asset that composites over/under everything else, so
 * overlays, captions and stickers that overlap the held interval stay live and
 * editable. Baking them into a canvas image would freeze them permanently.
 *
 * Why `MediaMetadataRetriever` with `OPTION_CLOSEST`: this repo's decoder
 * architecture is Media3/MediaCodec for playback and export, which exposes no
 * "decode exactly one frame at timestamp" entry point; Transformer's frame
 * extraction is not part of the public API. `MediaMetadataRetriever` is the
 * platform's single-frame extractor and already used by the export tests. It
 * is asked for the CLOSEST frame (never `OPTION_CLOSEST_SYNC`, which would
 * silently hand back the preceding KEYFRAME — exactly the wrong-frame bug this
 * feature must not have).
 *
 * Accuracy contract: the requested instant must lie inside the PROBED source
 * duration, or this refuses with `CAPTURE_OUT_OF_RANGE`. It never falls back
 * to frame 0 (the old placeholder behaviour) and never substitutes a keyframe.
 * On a variable-frame-rate file the closest DISPLAYED frame to the requested
 * instant is returned — that is the frame the user was looking at, not an
 * arbitrary earlier one.
 *
 * Files live under `<custodyRoot>/freeze/`, are custody-relative in the
 * project metadata, and are pruned by [pruneUnreferenced] so replaced or
 * removed freezes do not accumulate. Source media is never touched.
 */
object FreezeFrameCapture {

    class CaptureException(val code: String, message: String, cause: Throwable? = null) :
        RuntimeException(message, cause)

    data class CapturedFrame(
        val relativePath: String,
        val file: File,
        val width: Int,
        val height: Int,
        val timestampMicros: Long,
    )

    /** Directory (custody-relative prefix) that holds generated freeze stills. */
    const val FREEZE_SUBDIR = "freeze"

    /**
     * Slack for container duration rounding: a request for the final frame of
     * a 3.000s file can report 3.002s from the probe.
     */
    private const val DURATION_TOLERANCE_MICROS = 50_000L

    /** Pure guard: is [timestampMicros] a real instant of a source of
     *  [durationMillis]? A zero/unknown duration defers to the decoder. */
    fun isTimestampInsideSource(timestampMicros: Long, durationMillis: Long): Boolean {
        if (timestampMicros < 0) return false
        if (durationMillis <= 0) return true
        return timestampMicros <= durationMillis * 1000L + DURATION_TOLERANCE_MICROS
    }

    /**
     * Extracts the source frame at [timestampMicros] and writes it as a PNG.
     * Throws [CaptureException] with `CAPTURE_OUT_OF_RANGE`, `CAPTURE_FAILED`
     * or `IO_ERROR`; there is no silent fallback.
     */
    fun capture(
        sourceFile: File,
        timestampMicros: Long,
        custodyRoot: File,
    ): CapturedFrame {
        if (!sourceFile.isFile) {
            throw CaptureException(
                "CAPTURE_FAILED",
                "Source media is not readable: ${sourceFile.absolutePath}",
            )
        }
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(sourceFile.absolutePath)
            val durationMs = retriever
                .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull()
                ?: 0L
            if (!isTimestampInsideSource(timestampMicros, durationMs)) {
                throw CaptureException(
                    "CAPTURE_OUT_OF_RANGE",
                    "No frame at ${timestampMicros}us: the source is ${durationMs}ms long",
                )
            }
            val bitmap = retriever.getFrameAtTime(
                timestampMicros,
                MediaMetadataRetriever.OPTION_CLOSEST,
            ) ?: throw CaptureException(
                "CAPTURE_FAILED",
                "The decoder returned no frame at ${timestampMicros}us",
            )
            val width = bitmap.width
            val height = bitmap.height
            val directory = File(custodyRoot, FREEZE_SUBDIR)
            if (!directory.exists() && !directory.mkdirs()) {
                bitmap.recycle()
                throw CaptureException(
                    "IO_ERROR",
                    "Could not create the freeze-frame directory ${directory.absolutePath}",
                )
            }
            val file = File(directory, "freeze-${UUID.randomUUID()}.png")
            try {
                file.outputStream().use { out ->
                    if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) {
                        throw CaptureException(
                            "IO_ERROR",
                            "Could not encode the captured frame to ${file.absolutePath}",
                        )
                    }
                }
            } finally {
                bitmap.recycle()
            }
            return CapturedFrame(
                relativePath = "$FREEZE_SUBDIR/${file.name}",
                file = file,
                width = width,
                height = height,
                timestampMicros = timestampMicros,
            )
        } catch (e: CaptureException) {
            throw e
        } catch (e: Exception) {
            throw CaptureException("CAPTURE_FAILED", "freeze-frame capture failed: ${e.message}", e)
        } finally {
            retriever.release()
        }
    }

    /**
     * Deletes generated freeze stills under `<custodyRoot>/freeze/` that the
     * project no longer references. ONLY that directory is touched, so source
     * media and other generated assets (proxies, GIF frames) are never at risk.
     */
    fun pruneUnreferenced(
        custodyRoot: File,
        referencedPaths: Collection<String>,
    ): List<String> {
        val directory = File(custodyRoot, FREEZE_SUBDIR)
        if (!directory.isDirectory) return emptyList()
        val keep = referencedPaths.map { it.replace('\\', '/') }.toSet()
        val removed = mutableListOf<String>()
        for (child in directory.listFiles().orEmpty()) {
            if (!child.isFile) continue
            val relativePath = "$FREEZE_SUBDIR/${child.name}"
            if (relativePath in keep) continue
            // Only ever delete files this feature generated.
            if (!child.name.startsWith("freeze-") || !child.name.endsWith(".png")) continue
            if (child.delete()) removed.add(relativePath)
        }
        return removed
    }
}
