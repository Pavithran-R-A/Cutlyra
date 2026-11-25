package app.cutlyra.editor.media

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * The Freeze Frame guards and cleanup rule, on the JVM.
 *
 * The capture itself needs a device decoder, but the two decisions that keep
 * it honest are pure: (a) an instant outside the probed source is REFUSED
 * rather than clamped to some other frame, and (b) pruning only ever deletes
 * generated `freeze/freeze-*.png` files the project no longer references, so
 * source media and other assets can't be lost.
 */
class FreezeFrameCaptureTest {

    private lateinit var custodyRoot: File

    @Before
    fun setUp() {
        custodyRoot = Files.createTempDirectory("freeze-capture").toFile()
    }

    @After
    fun tearDown() {
        custodyRoot.deleteRecursively()
    }

    @Test
    fun acceptsInstantsInsideTheProbedSource() {
        assertTrue(FreezeFrameCapture.isTimestampInsideSource(0L, 3_000L))
        assertTrue(FreezeFrameCapture.isTimestampInsideSource(1_500_000L, 3_000L))
        // The final frame's reported timestamp can round past the container's
        // duration; that tolerance is deliberate.
        assertTrue(FreezeFrameCapture.isTimestampInsideSource(3_020_000L, 3_000L))
    }

    @Test
    fun refusesInstantsOutsideTheSource() {
        assertFalse(FreezeFrameCapture.isTimestampInsideSource(-1L, 3_000L))
        assertFalse(FreezeFrameCapture.isTimestampInsideSource(4_000_000L, 3_000L))
    }

    @Test
    fun defersToTheDecoderWhenTheProbeReportsNoDuration() {
        assertTrue(FreezeFrameCapture.isTimestampInsideSource(9_000_000L, 0L))
    }

    private fun still(name: String): String {
        val dir = File(custodyRoot, FreezeFrameCapture.FREEZE_SUBDIR).apply { mkdirs() }
        File(dir, name).writeBytes(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47))
        return "${FreezeFrameCapture.FREEZE_SUBDIR}/$name"
    }

    @Test
    fun prunesOnlyUnreferencedGeneratedStills() {
        val keep = still("freeze-keep.png")
        val stale = still("freeze-stale.png")

        val removed = FreezeFrameCapture.pruneUnreferenced(custodyRoot, listOf(keep))

        assertEquals(listOf(stale), removed)
        assertTrue(File(custodyRoot, keep).isFile)
        assertFalse(File(custodyRoot, stale).exists())
    }

    @Test
    fun neverDeletesSourceMediaOrForeignFiles() {
        val keep = still("freeze-keep.png")
        // A user's own media imported into custody, and a generated proxy.
        val source = File(custodyRoot, "media/source.mp4").apply {
            parentFile?.mkdirs()
            writeBytes(byteArrayOf(1, 2, 3))
        }
        val proxy = File(custodyRoot, "proxy/source.mp4").apply {
            parentFile?.mkdirs()
            writeBytes(byteArrayOf(4, 5, 6))
        }
        val oddFile = File(custodyRoot, "${FreezeFrameCapture.FREEZE_SUBDIR}/notes.txt").apply {
            writeText("not ours")
        }

        val removed = FreezeFrameCapture.pruneUnreferenced(custodyRoot, listOf(keep))

        assertTrue(removed.isEmpty())
        assertTrue(source.isFile)
        assertTrue(proxy.isFile)
        assertTrue(oddFile.isFile)
    }

    @Test
    fun toleratesAMissingFreezeDirectory() {
        assertTrue(FreezeFrameCapture.pruneUnreferenced(custodyRoot, emptyList()).isEmpty())
    }
}
