package app.cutlyra.editor.media.gif

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * The GIF export preflight's refusals that need no decoder, on the JVM:
 *
 *  - a GIF with no frames is a caller error, not an empty success;
 *  - a frame the project referenced but custody no longer has is a HARD
 *    failure naming the path (never a skipped frame or a substituted still);
 *  - a negative/absent delay is a caller error.
 *
 * The decode-based refusals (unreadable PNG, mismatched dimensions, and the
 * happy path's measured width/height/duration) live in
 * `GifExportPreflightInstrumentedTest`, because they need a real bitmap
 * decoder.
 */
class GifExportPreflightTest {

    private lateinit var custodyRoot: File

    @Before
    fun setUp() {
        custodyRoot = Files.createTempDirectory("gif-preflight").toFile()
    }

    @After
    fun tearDown() {
        custodyRoot.deleteRecursively()
    }

    private fun refusalOf(block: () -> Unit): GifExportPreflight.Refusal {
        val error = runCatching(block).exceptionOrNull()
        assertTrue("expected a Refusal, got $error", error is GifExportPreflight.Refusal)
        return error as GifExportPreflight.Refusal
    }

    @Test
    fun refusesAnEmptyFrameList() {
        val refusal = refusalOf { GifExportPreflight.verify(custodyRoot, emptyList()) }
        assertEquals("INVALID_ARGS", refusal.code)
    }

    @Test
    fun namesEveryMissingFrame() {
        val refusal = refusalOf {
            GifExportPreflight.verify(
                custodyRoot,
                listOf(
                    GifExportPreflight.FrameRef("gif/a/frame-000.png", 90),
                    GifExportPreflight.FrameRef("gif/a/frame-001.png", 210),
                ),
            )
        }
        assertEquals("GIF_FRAMES_MISSING", refusal.code)
        assertTrue(refusal.message!!.contains("gif/a/frame-000.png"))
        assertTrue(refusal.message!!.contains("gif/a/frame-001.png"))
    }

    @Test
    fun refusesABlankPath() {
        val refusal = refusalOf {
            GifExportPreflight.verify(custodyRoot, listOf(GifExportPreflight.FrameRef("  ", 100)))
        }
        assertEquals("INVALID_ARGS", refusal.code)
    }

    @Test
    fun refusesANegativeDelayInsteadOfGuessingOne() {
        File(custodyRoot, "gif/a").mkdirs()
        File(custodyRoot, "gif/a/frame-000.png").writeBytes(byteArrayOf(1, 2, 3))
        val refusal = refusalOf {
            GifExportPreflight.verify(
                custodyRoot,
                listOf(GifExportPreflight.FrameRef("gif/a/frame-000.png", -1)),
            )
        }
        assertEquals("INVALID_ARGS", refusal.code)
        assertTrue(refusal.message!!.contains("gif/a/frame-000.png"))
    }
}
