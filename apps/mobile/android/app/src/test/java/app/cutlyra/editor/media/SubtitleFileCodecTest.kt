package app.cutlyra.editor.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * SAF subtitle import rules, exercised on the JVM:
 * valid encodings decode, a BOM never reaches the parser, non-text bytes are
 * refused rather than replaced, and a picked non-subtitle is refused before it
 * can import zero cues.
 */
class SubtitleFileCodecTest {
    private val sample = "1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n"

    @Test
    fun `plain UTF-8 decodes unchanged`() {
        assertEquals(sample, SubtitleFileCodec.decode(sample.toByteArray(Charsets.UTF_8)))
    }

    @Test
    fun `UTF-8 BOM is stripped`() {
        val bytes = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) +
            sample.toByteArray(Charsets.UTF_8)
        assertEquals(sample, SubtitleFileCodec.decode(bytes))
    }

    @Test
    fun `UTF-16LE with BOM is decoded and the BOM removed`() {
        val bytes = byteArrayOf(0xFF.toByte(), 0xFE.toByte()) +
            sample.toByteArray(Charsets.UTF_16LE)
        assertEquals(sample, SubtitleFileCodec.decode(bytes))
    }

    @Test
    fun `UTF-16BE with BOM is decoded and the BOM removed`() {
        val bytes = byteArrayOf(0xFE.toByte(), 0xFF.toByte()) +
            sample.toByteArray(Charsets.UTF_16BE)
        assertEquals(sample, SubtitleFileCodec.decode(bytes))
    }

    @Test
    fun `invalid UTF-8 is refused instead of silently replaced`() {
        val bytes = byteArrayOf(0xC3.toByte(), 0x28) // malformed two-byte sequence
        assertThrows(SubtitleFileCodec.InvalidSubtitleFileException::class.java) {
            SubtitleFileCodec.decode(bytes)
        }
    }

    @Test
    fun `empty file is refused`() {
        assertThrows(SubtitleFileCodec.InvalidSubtitleFileException::class.java) {
            SubtitleFileCodec.decode(ByteArray(0))
        }
    }

    @Test
    fun `supported extensions are accepted case-insensitively`() {
        SubtitleFileCodec.validateExtension("captions.SRT")
        SubtitleFileCodec.validateExtension("captions.vtt")
        SubtitleFileCodec.validateExtension("captions.txt")
        SubtitleFileCodec.validateExtension(null)
    }

    @Test
    fun `a non-subtitle extension is refused`() {
        assertThrows(SubtitleFileCodec.InvalidSubtitleFileException::class.java) {
            SubtitleFileCodec.validateExtension("holiday.mp4")
        }
    }

    @Test
    fun `content without timing lines is refused`() {
        assertThrows(SubtitleFileCodec.InvalidSubtitleFileException::class.java) {
            SubtitleFileCodec.validateContent("just a README\nno captions here\n")
        }
    }

    @Test
    fun `format is detected from content, not the file extension`() {
        assertEquals("vtt", SubtitleFileCodec.detectFormat("WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n"))
        assertEquals("srt", SubtitleFileCodec.detectFormat(sample))
        assertTrue(SubtitleFileCodec.detectFormat("\uFEFFWEBVTT\n").startsWith("vtt"))
    }
}
