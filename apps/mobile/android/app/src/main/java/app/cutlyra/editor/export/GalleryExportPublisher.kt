package app.cutlyra.editor.export

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.IOException
import java.util.UUID

/**
 * Publish a verified native export into the USER'S Movies/Cutlyra library,
 * rather than returning an inaccessible noBackupFilesDir file:// handle.
 *
 * API 29+ (this app's minSdk) supports scoped MediaStore inserts without
 * broad storage or READ_MEDIA_VIDEO permissions. The item stays pending
 * until every byte is copied; a failure removes the pending item and leaves
 * the original private file in place for diagnosis/retry.
 */
object GalleryExportPublisher {
    fun publish(context: Context, source: File): Uri {
        require(source.isFile && source.length() > 0L) {
            "cannot publish an empty or missing export"
        }

        val extension = source.extension.lowercase()
        require(extension == "mp4" || extension == "webm") {
            "unsupported video export extension: $extension"
        }
        val mimeType = if (extension == "webm") "video/webm" else "video/mp4"
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, "Cutlyra-${UUID.randomUUID()}.$extension")
            put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
            put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_MOVIES}/Cutlyra")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
            ?: throw IOException("MediaStore rejected the Cutlyra export")

        try {
            val output = resolver.openOutputStream(uri, "w")
                ?: throw IOException("MediaStore failed to open the export destination")
            output.use { stream ->
                source.inputStream().use { input -> input.copyTo(stream) }
                stream.flush()
            }
            val complete = ContentValues().apply {
                put(MediaStore.MediaColumns.IS_PENDING, 0)
            }
            if (resolver.update(uri, complete, null, null) != 1) {
                throw IOException("MediaStore could not finalize the Cutlyra export")
            }
        } catch (error: Exception) {
            try {
                resolver.delete(uri, null, null)
            } catch (_: Exception) {
                // Preserve the original cause. A pending item stays hidden.
            }
            throw error
        }
        return uri
    }
}
