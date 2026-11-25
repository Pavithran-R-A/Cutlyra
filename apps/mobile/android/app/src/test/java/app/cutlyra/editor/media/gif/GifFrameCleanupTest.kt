package app.cutlyra.editor.media.gif

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * The generated-media cleanup rule, on the JVM: frame PNGs the project no
 * longer references are removed; every referenced one survives. This is what
 * keeps a re-imported GIF (or one whose decode produced fewer frames) from
 * leaving dead PNGs in custody forever.
 */
class GifFrameCleanupTest {

    private lateinit var custodyRoot: File

    @Before
    fun setUp() {
        custodyRoot = Files.createTempDirectory("gif-frame-cleanup").toFile()
    }

    @After
    fun tearDown() {
        custodyRoot.deleteRecursively()
    }

    private fun frame(assetId: String, index: Int): String {
        val dir = File(custodyRoot, "gif/$assetId").apply { mkdirs() }
        val name = "frame-%03d.png".format(index)
        File(dir, name).writeBytes(byteArrayOf(0x89.toByte(), 0x50, index.toByte()))
        return "gif/$assetId/$name"
    }

    @Test
    fun removesOnlyFramesTheProjectNoLongerReferences() {
        val keep = frame("asset", 0)
        val stale = frame("asset", 1)
        frame("asset", 2)

        val removed = GifFrameCleanup.pruneAssetFrames(
            custodyRoot = custodyRoot,
            assetId = "asset",
            referencedPaths = listOf(keep),
        )

        assertEquals(listOf(stale, "gif/asset/frame-002.png"), removed.sorted())
        assertTrue("referenced frame must survive", File(custodyRoot, keep).isFile)
        assertFalse(File(custodyRoot, stale).exists())
    }

    @Test
    fun keepsEveryReferencedFrameAndTheDirectory() {
        val frames = (0 until 3).map { frame("asset", it) }

        val removed = GifFrameCleanup.pruneAssetFrames(
            custodyRoot = custodyRoot,
            assetId = "asset",
            referencedPaths = frames,
        )

        assertTrue(removed.isEmpty())
        frames.forEach { assertTrue(it, File(custodyRoot, it).isFile) }
        assertTrue(File(custodyRoot, "gif/asset").isDirectory)
    }

    @Test
    fun neverTouchesAnotherAssetsFrames() {
        val mine = frame("asset", 0)
        val other = frame("other", 0)
        frame("other", 1)

        GifFrameCleanup.pruneAssetFrames(custodyRoot, "asset", listOf(mine))

        assertTrue(File(custodyRoot, other).isFile)
        assertTrue(File(custodyRoot, "gif/other/frame-001.png").isFile)
    }

    @Test
    fun removesTheDirectoryOnceNothingIsReferenced() {
        frame("asset", 0)
        frame("asset", 1)

        val removed = GifFrameCleanup.pruneAssetFrames(custodyRoot, "asset", emptyList())

        assertEquals(2, removed.size)
        assertFalse(File(custodyRoot, "gif/asset").exists())
    }

    @Test
    fun ignoresAnAssetWithNoDecodedFrames() {
        assertTrue(GifFrameCleanup.pruneAssetFrames(custodyRoot, "missing", emptyList()).isEmpty())
        assertTrue(GifFrameCleanup.pruneAssetFrames(custodyRoot, "", emptyList()).isEmpty())
    }
}
