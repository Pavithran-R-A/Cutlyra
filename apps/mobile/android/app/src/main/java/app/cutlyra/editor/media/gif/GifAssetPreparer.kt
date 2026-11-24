package app.cutlyra.editor.media.gif

import android.graphics.Bitmap
import java.io.File

/**
 * Turns an imported GIF into the two things the native pipeline needs:
 * its timing metadata (what the shared renderer uses to pick a frame) and one
 * PNG per decoded frame (what the Media3 exporter feeds into the EDL).
 *
 * Frames are written under the media custody root so the paths persist across
 * save/reopen and are readable by the exporter:
 * `<root>/gif/<assetId>/frame-000.png`.
 */
object GifAssetPreparer {
    data class PreparedFrame(
        val relativePath: String,
        val delayMs: Int,
    )

    data class PreparedGif(
        val width: Int,
        val height: Int,
        val loopCount: Int,
        val totalDurationMs: Int,
        val frames: List<PreparedFrame>,
    )

    fun prepare(
        gifBytes: ByteArray,
        outputRoot: File,
        assetId: String,
    ): PreparedGif {
        require(assetId.isNotBlank()) { "assetId must not be blank" }
        val decoded = GifDecoder.decode(gifBytes)
        val relativeDir = "gif/${sanitize(assetId)}"
        val directory = File(outputRoot, relativeDir)
        check(directory.exists() || directory.mkdirs()) {
            "Could not create the GIF frame directory ${directory.absolutePath}"
        }

        val frames = decoded.frames.mapIndexed { index, frame ->
            val fileName = "frame-%03d.png".format(index)
            val bitmap = Bitmap.createBitmap(
                frame.pixels,
                decoded.width,
                decoded.height,
                Bitmap.Config.ARGB_8888,
            )
            try {
                File(directory, fileName).outputStream().use { out ->
                    check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) {
                        "Could not encode GIF frame $index"
                    }
                }
            } finally {
                bitmap.recycle()
            }
            PreparedFrame(
                relativePath = "$relativeDir/$fileName",
                delayMs = frame.delayMs,
            )
        }

        return PreparedGif(
            width = decoded.width,
            height = decoded.height,
            loopCount = decoded.loopCount,
            totalDurationMs = decoded.totalDurationMs,
            frames = frames,
        )
    }

    fun prepareFromFile(
        gifFile: File,
        outputRoot: File,
        assetId: String,
    ): PreparedGif {
        check(gifFile.isFile) { "GIF file does not exist: ${gifFile.absolutePath}" }
        return prepare(gifFile.readBytes(), outputRoot, assetId)
    }

    fun isGifFile(file: File): Boolean {
        if (!file.isFile) return false
        if (file.extension.equals("gif", ignoreCase = true)) return true
        val header = ByteArray(3)
        val read = file.inputStream().use { it.read(header) }
        return read == 3 && String(header, Charsets.US_ASCII) == "GIF"
    }

    private fun sanitize(assetId: String): String =
        assetId.replace(Regex("[^A-Za-z0-9._-]"), "_")
}
