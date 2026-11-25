package app.cutlyra.editor.media.reverse

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * Pure half of Reverse Video: the frame count, the reversed sample mapping and
 * the generated-file cleanup. The encoder path itself is covered by
 * `ReverseVideoInstrumentedTest`, which decodes the generated MP4.
 */
class ReverseMediaGeneratorTest {

    @Test
    fun frameCountCoversTheWholeSpan() {
        assertEquals(90, ReverseMediaGenerator.frameCount(0, 3000, 30))
        assertEquals(1, ReverseMediaGenerator.frameCount(0, 10, 30))
        assertEquals(0, ReverseMediaGenerator.frameCount(500, 500, 30))
        assertEquals(0, ReverseMediaGenerator.frameCount(900, 500, 30))
        // The rate is clamped rather than used raw.
        assertEquals(60, ReverseMediaGenerator.frameCount(0, 1000, 1000))
    }

    @Test
    fun outputRunsBackwardsThroughTheSourceRange() {
        val times = (0 until 3).map {
            ReverseMediaGenerator.sourceTimestampMsForOutputFrame(it, 3, 0, 3000)
        }
        assertEquals(listOf(2500L, 1500L, 500L), times)
        // Strictly decreasing, so frame order really is reversed.
        assertTrue(times[0] > times[1] && times[1] > times[2])
    }

    @Test
    fun mappingRespectsTrimAndStaysInsideTheRange() {
        val times = (0 until 4).map {
            ReverseMediaGenerator.sourceTimestampMsForOutputFrame(it, 4, 2000, 3000)
        }
        assertEquals(listOf(2875L, 2625L, 2375L, 2125L), times)
        assertTrue(times.all { it in 2000..2999 })
        // No output frame may sample the exclusive end.
        assertFalse(times.contains(3000L))
    }

    @Test
    fun cleanupOnlyDeletesUnreferencedGeneratedFiles() {
        val root = Files.createTempDirectory("reverse-cleanup").toFile()
        try {
            val dir = File(root, ReverseMediaGenerator.REVERSE_SUBDIR)
            dir.mkdirs()
            val keep = File(dir, "reverse-keep.mp4").apply { writeBytes(byteArrayOf(1)) }
            val stale = File(dir, "reverse-stale.mp4").apply { writeBytes(byteArrayOf(1)) }
            val foreign = File(dir, "not-ours.mp4").apply { writeBytes(byteArrayOf(1)) }

            val removed = ReverseMediaGenerator.pruneUnreferenced(
                custodyRoot = root,
                referencedPaths = listOf("reverse/${keep.name}"),
            )

            assertEquals(listOf("reverse/${stale.name}"), removed)
            assertTrue(keep.isFile)
            assertFalse(stale.isFile)
            // A file this feature did not generate is never touched.
            assertTrue(foreign.isFile)
        } finally {
            root.deleteRecursively()
        }
    }
}
