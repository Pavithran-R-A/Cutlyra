package app.cutlyra.editor.export

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cutlyra.editor.media.gif.GifAssetPreparer
import app.cutlyra.editor.media.gif.GifExportPreflight
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The GIF export preflight against REAL decoded frames.
 *
 * `GifAssetPreparer` decodes a generated GIF into custody PNGs exactly as the
 * importer does; `GifExportPreflight.verify` then re-opens every frame the way
 * the export button does. These assertions are what stop a corrupt or
 * inconsistent frame from reaching Media3 as a mid-export "asset loader
 * error", and what stop a partial frame list from being reported ready.
 */
@RunWith(AndroidJUnit4::class)
class GifExportPreflightInstrumentedTest {
    private lateinit var context: Context
    private lateinit var workDir: File

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        workDir = File(context.cacheDir, "gif_preflight_${System.nanoTime()}").apply { mkdirs() }
    }

    @After
    fun tearDown() {
        workDir.deleteRecursively()
    }

    /** A real 3-frame GIF decoded into custody, with non-uniform delays. */
    private fun preparedFrames(): Pair<GifAssetPreparer.PreparedGif, List<GifExportPreflight.FrameRef>> {
        val bytes = TestGifEncoder.encodeSolidFrames(
            width = 96,
            height = 64,
            framePaletteIndices = listOf(0, 1, 2),
            frameDelaysMs = listOf(90, 210, 400),
            loopCount = 0,
        )
        val gifFile = File(workDir, "fixture.gif").apply { writeBytes(bytes) }
        val prepared = GifAssetPreparer.prepareFromFile(
            gifFile = gifFile,
            outputRoot = workDir,
            assetId = "gif-preflight",
        )
        val refs = prepared.frames.map { frame ->
            GifExportPreflight.FrameRef(frame.relativePath, frame.delayMs.toLong())
        }
        return prepared to refs
    }

    private fun refusalOf(block: () -> Unit): GifExportPreflight.Refusal {
        val error = runCatching(block).exceptionOrNull()
        assertTrue("expected a Refusal, got $error", error is GifExportPreflight.Refusal)
        return error as GifExportPreflight.Refusal
    }

    @Test
    fun reportsTheRealFrameShapeAndTotalDuration() {
        val (prepared, refs) = preparedFrames()

        val report = GifExportPreflight.verify(workDir, refs)

        assertEquals(prepared.frames.size, report.frameCount)
        assertEquals(prepared.width, report.width)
        assertEquals(prepared.height, report.height)
        assertEquals(prepared.totalDurationMs.toLong(), report.totalDurationMs)
        // Non-uniform source delays must survive untouched.
        assertEquals(700L, report.totalDurationMs)
    }

    @Test
    fun refusesATruncatedFrameInsteadOfLettingTheEncoderFail() {
        val (prepared, refs) = preparedFrames()
        val victim = File(workDir, prepared.frames[1].relativePath)
        // Keep the PNG signature so a pure "is it a file?" check would pass.
        victim.writeBytes(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))

        val refusal = refusalOf { GifExportPreflight.verify(workDir, refs) }

        assertEquals("GIF_FRAME_UNREADABLE", refusal.code)
        assertTrue(refusal.message!!.contains(prepared.frames[1].relativePath))
    }

    @Test
    fun refusesMissingFramesByPath() {
        val (prepared, refs) = preparedFrames()
        File(workDir, prepared.frames.last().relativePath).delete()

        val refusal = refusalOf { GifExportPreflight.verify(workDir, refs) }

        assertEquals("GIF_FRAMES_MISSING", refusal.code)
        assertTrue(refusal.message!!.contains(prepared.frames.last().relativePath))
    }

    @Test
    fun refusesAFrameWhoseDimensionsDisagreeWithTheFirst() {
        val (_, refs) = preparedFrames()
        // A real, decodable PNG of a different size (the decoded-bounds trap).
        val other = File(workDir, "other.png")
        val bitmap = android.graphics.Bitmap.createBitmap(64, 64, android.graphics.Bitmap.Config.ARGB_8888)
        try {
            other.outputStream().use { out ->
                bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)
            }
        } finally {
            bitmap.recycle()
        }
        val swapped = refs.toMutableList()
        swapped[2] = swapped[2].copy(relativePath = "other.png")

        val refusal = refusalOf { GifExportPreflight.verify(workDir, swapped) }

        assertEquals("GIF_FRAME_DIMENSION_MISMATCH", refusal.code)
    }
}
