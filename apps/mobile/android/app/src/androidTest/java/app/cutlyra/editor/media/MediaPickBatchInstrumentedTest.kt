package app.cutlyra.editor.media

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.cutlyra.editor.test.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Multi-select import through the picker's REAL result path.
 *
 * What is real here: a multi-item `ClipData` built from actual custody-bound
 * documents, `MediaPickBatch.urisFrom` reading it, and `MediaPickBatch.importUris`
 * copying each pick into app custody, probing it, and emitting the same
 * `pickProgress` stages the plugin forwards to JS. The mixed batch is a real
 * video (the instrumentation `test_clip.mp4` fixture) and a generated JPEG, so
 * the video/photo interleaving and ordering are exercised, not simulated.
 *
 * What is stubbed: the system picker ACTIVITY (CI cannot tap through a system
 * UI) and Capacitor's `PluginCall` promise resolution. The plugin callback body
 * between the `ActivityResult` and that promise is this code, unchanged.
 */
@RunWith(AndroidJUnit4::class)
class MediaPickBatchInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val targetContext = instrumentation.targetContext
    private val testContext = instrumentation.context

    private fun stageFile(name: String, bytes: ByteArray): Uri {
        val dir = File(targetContext.cacheDir, "camera-capture").apply { mkdirs() }
        val file = File(dir, name)
        file.writeBytes(bytes)
        return FileProvider.getUriForFile(
            targetContext,
            "${targetContext.packageName}.fileprovider",
            file,
        )
    }

    private fun rawBytes(): ByteArray =
        testContext.resources.openRawResource(R.raw.test_clip).use { it.readBytes() }

    private fun jpegBytes(): ByteArray {
        val bitmap = Bitmap.createBitmap(240, 180, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(Color.rgb(30, 140, 220))
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)
        bitmap.recycle()
        return out.toByteArray()
    }

    private fun resultWith(uris: List<Uri>): ActivityResult {
        val first = uris.firstOrNull() ?: return ActivityResult(Activity.RESULT_OK, Intent())
        val clip = ClipData.newUri(targetContext.contentResolver, "picked", first)
        for (uri in uris.drop(1)) {
            clip.addItem(ClipData.Item(uri))
        }
        return ActivityResult(Activity.RESULT_OK, Intent().apply { clipData = clip })
    }

    @Test
    fun mixedVideoAndPhotoPickKeepsClipDataOrder() {
        val video = stageFile("pick-video.mp4", rawBytes())
        val photo = stageFile("pick-photo.jpg", jpegBytes())
        val secondVideo = stageFile("pick-video-2.mp4", rawBytes())
        val result = resultWith(listOf(video, photo, secondVideo))

        val uris = MediaPickBatch.urisFrom(result)
        assertEquals(listOf(video, photo, secondVideo), uris)

        val progress = mutableListOf<String>()
        val handles = MediaPickBatch.importUris(targetContext, uris) { _, _, stage, _, _ ->
            progress.add(stage)
        }

        assertEquals(3, handles.length())
        val kinds = (0 until handles.length()).map { handles.getJSONObject(it).getString("kind") }
        assertEquals(listOf("video", "image", "video"), kinds)
        val names = (0 until handles.length()).map { handles.getJSONObject(it).getString("fileName") }
        assertEquals(
            listOf("pick-video.mp4", "pick-photo.jpg", "pick-video-2.mp4"),
            names,
        )

        // Every handle points at a file this app OWNS in custody, not at the
        // provider URI (which is only readable for the returning call).
        for (index in 0 until handles.length()) {
            val uri = Uri.parse(handles.getJSONObject(index).getString("uri"))
            val copied = File(requireNotNull(uri.path))
            assertTrue("custody copy missing for handle $index", copied.exists())
            assertTrue("custody copy is empty for handle $index", copied.length() > 0)
        }

        // loading + loaded for each item, in pick order.
        assertEquals(
            listOf("loading", "loaded", "loading", "loaded", "loading", "loaded"),
            progress,
        )
    }

    @Test
    fun cancelledPickerYieldsNoUris() {
        val cancelled = ActivityResult(Activity.RESULT_CANCELED, null)
        assertEquals(emptyList<Uri>(), MediaPickBatch.urisFrom(cancelled))
        assertEquals(0, MediaPickBatch.importUris(targetContext, emptyList()) { _, _, _, _, _ -> }.length())
    }

    @Test
    fun unreadableItemDoesNotLoseTheBatch() {
        val video = stageFile("batch-video.mp4", rawBytes())
        val photo = stageFile("batch-photo.jpg", jpegBytes())
        val missing = Uri.parse(
            "content://${targetContext.packageName}.fileprovider/camera_capture/missing.mp4",
        )
        val result = resultWith(listOf(video, missing, photo))

        val uris = MediaPickBatch.urisFrom(result)
        assertEquals(3, uris.size)
        val progress = mutableListOf<Pair<Int, String>>()
        val handles = MediaPickBatch.importUris(targetContext, uris) { index, _, stage, _, _ ->
            progress.add(index to stage)
        }

        assertEquals(2, handles.length())
        assertEquals(
            listOf(0 to "video", 1 to "image"),
            (0 until handles.length()).map { it to handles.getJSONObject(it).getString("kind") },
        )
        assertTrue("the missing item must report an error stage", progress.any { it == 1 to "error" })
        // The failing index does not abort the item after it.
        assertEquals(2 to "loaded", progress.last())
    }
}
