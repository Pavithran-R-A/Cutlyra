package app.cutlyra.editor.export

import android.content.Context
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cutlyra.editor.media.reverse.ReverseMediaGenerator
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Deterministic Reverse Video verification on decoded pixels.
 *
 * The source is a generated red -> green -> blue video (one second each, 30fps).
 * Reversing it must produce blue -> green -> red at the same duration, and the
 * generated file must be silent (Reverse's stated audio policy: the reversed
 * clip is muted, the original keeps its own bytes and audio).
 *
 * Frame order is judged by decoding the generated MP4 at three instants with
 * `MediaMetadataRetriever` — the same reader every export test uses — not by
 * checking that a flag was set.
 */
@RunWith(AndroidJUnit4::class)
class ReverseVideoInstrumentedTest {
    private lateinit var context: Context
    private lateinit var custody: File
    private lateinit var source: File

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        custody = File(context.cacheDir, "reverse_custody_${System.nanoTime()}").apply { mkdirs() }
        source = File(context.cacheDir, "reverse_src_${System.nanoTime()}.mp4")
    }

    @After
    fun tearDown() {
        source.delete()
        custody.deleteRecursively()
    }

    private fun createSource(width: Int = 320, height: Int = 240): File =
        SolidColorVideoFactory.create(
            output = source,
            segments = listOf(
                SolidColorVideoFactory.RED,
                SolidColorVideoFactory.GREEN,
                SolidColorVideoFactory.BLUE,
            ),
            width = width,
            height = height,
            segmentDurationUs = 1_000_000L,
            fps = 30,
        )

    private fun probeDurationMs(file: File): Long {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            return retriever
                .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull()
                ?: 0L
        } finally {
            retriever.release()
        }
    }

    private fun audioTrackCount(file: File): Int {
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(file.absolutePath)
            return (0 until extractor.trackCount).count { index ->
                extractor.getTrackFormat(index)
                    .getString(MediaFormat.KEY_MIME)
                    ?.startsWith("audio/") == true
            }
        } finally {
            extractor.release()
        }
    }

    @Test
    fun reversesTheWholeClipAndKeepsDurationOrientationAndSilence() {
        createSource()
        val generated = ReverseMediaGenerator.generate(
            sourceFile = source,
            startMs = 0,
            endMs = 3_000,
            fps = 30,
            custodyRoot = custody,
        )
        try {
            assertEquals(90, generated.frameCount)
            assertEquals(320, generated.width)
            assertEquals(240, generated.height)
            assertFalse("reversed media must be video-only", generated.hasAudio)
            assertTrue(
                "generated duration was ${generated.durationMs}ms",
                generated.durationMs in 2_900..3_100,
            )
            assertTrue(
                "encoded duration was ${probeDurationMs(generated.file)}ms",
                probeDurationMs(generated.file) in 2_900..3_200,
            )
            assertEquals("generated file must have no audio track", 0, audioTrackCount(generated.file))

            // Source is red@0-1s, green@1-2s, blue@2-3s; reversed output must
            // therefore be blue@0-1s, green@1-2s, red@2-3s.
            SolidColorVideoFactory.assertSolidColor(generated.file, 250_000L, "blue")
            SolidColorVideoFactory.assertSolidColor(generated.file, 1_500_000L, "green")
            SolidColorVideoFactory.assertSolidColor(generated.file, 2_750_000L, "red")
        } finally {
            generated.file.delete()
        }
    }

    @Test
    fun respectsTheTrimmedSourceRange() {
        createSource()
        // Source 1s..3s is green then blue; reversed: blue first, green last.
        val generated = ReverseMediaGenerator.generate(
            sourceFile = source,
            startMs = 1_000,
            endMs = 3_000,
            fps = 30,
            custodyRoot = custody,
        )
        try {
            assertEquals(60, generated.frameCount)
            assertTrue(generated.durationMs in 1_900..2_100)
            SolidColorVideoFactory.assertSolidColor(generated.file, 250_000L, "blue")
            SolidColorVideoFactory.assertSolidColor(generated.file, 1_750_000L, "green")
        } finally {
            generated.file.delete()
        }
    }

    @Test
    fun portraitSourceKeepsItsOrientation() {
        createSource(width = 240, height = 320)
        val generated = ReverseMediaGenerator.generate(
            sourceFile = source,
            startMs = 0,
            endMs = 3_000,
            fps = 30,
            custodyRoot = custody,
        )
        try {
            assertEquals(240, generated.width)
            assertEquals(320, generated.height)
            // Portrait source is red -> green -> blue, so reversed starts blue.
            SolidColorVideoFactory.assertSolidColor(generated.file, 250_000L, "blue")
        } finally {
            generated.file.delete()
        }
    }

    @Test
    fun cancellationLeavesNoPartialFile() {
        createSource()
        val directory = File(custody, ReverseMediaGenerator.REVERSE_SUBDIR)
        val error = runCatching {
            ReverseMediaGenerator.generate(
                sourceFile = source,
                startMs = 0,
                endMs = 3_000,
                fps = 30,
                custodyRoot = custody,
                isCancelled = { true },
            )
        }.exceptionOrNull()

        assertTrue("expected a ReverseException, got $error", error is ReverseMediaGenerator.ReverseException)
        assertEquals("CANCELLED", (error as ReverseMediaGenerator.ReverseException).code)
        val leftovers = directory.listFiles().orEmpty()
        assertTrue("cancelled run left files behind: ${leftovers.map { it.name }}", leftovers.isEmpty())
    }

    @Test
    fun refusesARangePastTheEndOfTheSource() {
        createSource()
        val error = runCatching {
            ReverseMediaGenerator.generate(
                sourceFile = source,
                startMs = 0,
                endMs = 10_000,
                fps = 30,
                custodyRoot = custody,
            )
        }.exceptionOrNull()
        assertTrue(error is ReverseMediaGenerator.ReverseException)
        assertEquals("RANGE_OUT_OF_BOUNDS", (error as ReverseMediaGenerator.ReverseException).code)
    }
}
