package app.cutlyra.editor.media.gif

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The decoder materialises every frame's full logical screen before the
 * caller writes PNGs, so a tiny file can describe a huge allocation. These
 * tests pin that the budget check refuses such a file with a typed
 * `GifDecodeException` instead of letting the process die on an OOM.
 */
class GifDecoderBudgetTest {

    /** Valid 1x1 GIF89a: one global colour-table entry pair, 100 ms delay,
     *  one 1x1 frame (LZW clear/index/end), trailer. */
    private fun tinyGif(): ByteArray = intArrayOf(
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
        0x01, 0x00, 0x01, 0x00, // logical screen 1x1
        0x80, 0x00, 0x00, // GCT flag, 2 entries, bg 0, aspect 0
        0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, // global colour table
        0x21, 0xF9, 0x04, 0x00, 0x0A, 0x00, 0x00, 0x00, // GCE, 100 ms
        0x2C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // image 1x1
        0x02, 0x02, 0x04, 0x01, 0x00, // min code size 2 + LZW data
        0x3B, // trailer
    ).map { it.toByte() }.toByteArray()

    @Test
    fun decodesTheBaselineFile() {
        val decoded = GifDecoder.decode(tinyGif())
        assertEquals(1, decoded.width)
        assertEquals(1, decoded.height)
        assertEquals(1, decoded.frames.size)
        assertEquals(100, decoded.frames[0].delayMs)
    }

    @Test
    fun refusesAFileAboveTheDecodedMemoryBudget() {
        val bytes = tinyGif()
        // 65535x65535 logical screen = ~17 GB of decoded RGBA for one frame.
        bytes[6] = 0xFF.toByte()
        bytes[7] = 0xFF.toByte()
        bytes[8] = 0xFF.toByte()
        bytes[9] = 0xFF.toByte()

        val error = runCatching { GifDecoder.decode(bytes) }.exceptionOrNull()

        assertTrue("expected a GifDecodeException, got $error", error is GifDecodeException)
        assertTrue(
            "message should name the decoder limit, was: ${error?.message}",
            error?.message.orEmpty().contains("decoder limit"),
        )
    }
}
