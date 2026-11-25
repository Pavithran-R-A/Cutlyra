package app.cutlyra.editor.media.gif

import android.graphics.BitmapFactory
import java.io.File

/**
 * Export preflight for a GIF asset: proves every frame the EDL is about to
 * reference decodes into real pixels BEFORE Media3 starts encoding.
 *
 * Media3 feeds the decoded per-frame PNGs straight into the composition, so a
 * missing or corrupt frame used to surface only as a generic "Asset loader
 * error" part-way through an export. Checking that the paths merely EXIST was
 * not enough either — a truncated PNG passes that and fails the encoder. This
 * decodes each file and compares its size with the first frame, so a refusal
 * names the exact file and a typed reason.
 *
 * Refusals (never a silent skip, never a substituted frame):
 *  - `INVALID_ARGS` — a blank path or a negative delay;
 *  - `GIF_FRAMES_MISSING` — one or more custody files are gone;
 *  - `GIF_FRAME_UNREADABLE` — the file is not a decodable image;
 *  - `GIF_FRAME_DIMENSION_MISMATCH` — a frame disagrees with the first frame.
 */
object GifExportPreflight {

    class Refusal(val code: String, message: String) : RuntimeException(message)

    data class FrameRef(val relativePath: String, val delayMs: Long)

    data class Report(
        val frameCount: Int,
        val width: Int,
        val height: Int,
        val totalDurationMs: Long,
    )

    /**
     * Decodes every frame under [custodyRoot] and returns its shape and total
     * duration. Throws [Refusal] — with the offending path in the message —
     * the moment anything cannot be exported faithfully.
     */
    fun verify(custodyRoot: File, frames: List<FrameRef>): Report {
        if (frames.isEmpty()) {
            throw Refusal("INVALID_ARGS", "a GIF export needs at least one decoded frame")
        }
        val missing = mutableListOf<String>()
        var width = 0
        var height = 0
        var totalDelayMs = 0L

        for (frame in frames) {
            val relativePath = frame.relativePath.trim()
            if (relativePath.isEmpty()) {
                throw Refusal("INVALID_ARGS", "a GIF frame has no custody path")
            }
            if (frame.delayMs < 0L) {
                throw Refusal(
                    "INVALID_ARGS",
                    "GIF frame $relativePath has a negative delay (${frame.delayMs}ms)",
                )
            }
            val file = File(custodyRoot, relativePath)
            if (!file.isFile) {
                missing.add(relativePath)
                continue
            }
            val bitmap = try {
                BitmapFactory.decodeFile(file.absolutePath)
            } catch (e: Exception) {
                null
            }
            if (bitmap == null) {
                throw Refusal("GIF_FRAME_UNREADABLE", "Decoded GIF frame is unreadable: $relativePath")
            }
            val frameWidth = bitmap.width
            val frameHeight = bitmap.height
            bitmap.recycle()
            if (frameWidth <= 0 || frameHeight <= 0) {
                throw Refusal(
                    "GIF_FRAME_UNREADABLE",
                    "Decoded GIF frame has no pixels: $relativePath",
                )
            }
            if (width == 0) {
                width = frameWidth
                height = frameHeight
            } else if (frameWidth != width || frameHeight != height) {
                throw Refusal(
                    "GIF_FRAME_DIMENSION_MISMATCH",
                    "Decoded GIF frame $relativePath is ${frameWidth}x$frameHeight, " +
                        "expected ${width}x$height",
                )
            }
            totalDelayMs += frame.delayMs
        }

        if (missing.isNotEmpty()) {
            throw Refusal(
                "GIF_FRAMES_MISSING",
                "Missing decoded GIF frame(s): ${missing.joinToString()}",
            )
        }
        return Report(
            frameCount = frames.size,
            width = width,
            height = height,
            totalDurationMs = totalDelayMs,
        )
    }
}
