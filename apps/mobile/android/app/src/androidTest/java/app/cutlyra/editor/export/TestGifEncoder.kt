package app.cutlyra.editor.export

import java.io.ByteArrayOutputStream

/**
 * Writes a real, spec-valid animated GIF whose frames are solid palette
 * colours. Used to prove the native import/export pipeline against a known
 * timeline instead of an opaque fixture: each frame's colour and delay are
 * declared by the test, so the exported MP4 can be checked frame by frame.
 *
 * LZW is deliberately simple (a CLEAR before every literal pixel). That is
 * valid GIF data — the decoder resets its table on every clear — and keeps the
 * encoder small enough to audit.
 */
object TestGifEncoder {
    // Palette indices used by the tests.
    const val RED = 0
    const val GREEN = 1
    const val BLUE = 2
    const val WHITE = 3

    val PALETTE: List<Int> = listOf(
        0xFFFF0000.toInt(),
        0xFF00FF00.toInt(),
        0xFF0000FF.toInt(),
        0xFFFFFFFF.toInt(),
    )

    fun encodeSolidFrames(
        width: Int,
        height: Int,
        framePaletteIndices: List<Int>,
        frameDelaysMs: List<Int>,
        loopCount: Int,
    ): ByteArray {
        require(framePaletteIndices.isNotEmpty()) { "at least one frame is required" }
        require(framePaletteIndices.size == frameDelaysMs.size) { "one delay per frame" }

        val out = ByteArrayOutputStream()
        out.write("GIF89a".toByteArray(Charsets.US_ASCII))
        writeU16(out, width)
        writeU16(out, height)
        // Global colour table present (0x80), colour resolution 8 bits (0x70),
        // table size 2^(1+1) = 4 entries.
        out.write(0x80 or 0x70 or 0x01)
        out.write(0x00) // background colour index
        out.write(0x00) // pixel aspect ratio
        for (color in PALETTE) {
            out.write((color shr 16) and 0xFF)
            out.write((color shr 8) and 0xFF)
            out.write(color and 0xFF)
        }

        writeNetscapeLoop(out, loopCount)

        for (index in framePaletteIndices.indices) {
            val delayCs = (frameDelaysMs[index] / 10).coerceAtLeast(1)
            // Graphic control extension: no transparency, disposal = 1 (keep).
            out.write(0x21)
            out.write(0xF9)
            out.write(0x04)
            out.write(0x04)
            writeU16(out, delayCs)
            out.write(0x00) // transparent colour index (unused)
            out.write(0x00) // block terminator

            // Image descriptor: full logical screen, no local table, no interlace.
            out.write(0x2C)
            writeU16(out, 0)
            writeU16(out, 0)
            writeU16(out, width)
            writeU16(out, height)
            out.write(0x00)

            out.write(0x02) // LZW minimum code size for a 4-entry table
            val pixelCount = width * height
            writeSubBlocks(out, lzwData(pixelCount, framePaletteIndices[index]))
        }

        out.write(0x3B) // trailer
        return out.toByteArray()
    }

    private fun writeNetscapeLoop(out: ByteArrayOutputStream, loopCount: Int) {
        out.write(0x21)
        out.write(0xFF)
        out.write(0x0B)
        out.write("NETSCAPE2.0".toByteArray(Charsets.US_ASCII))
        out.write(0x03)
        out.write(0x01)
        writeU16(out, loopCount.coerceAtLeast(0))
        out.write(0x00)
    }

    /** CLEAR + literal for every pixel, then END — always 3-bit codes. */
    private fun lzwData(pixelCount: Int, paletteIndex: Int): ByteArray {
        val clearCode = 4
        val endCode = 5
        val codeSize = 3
        val bits = ArrayList<Int>(pixelCount * codeSize * 2)

        fun push(code: Int) {
            for (bit in 0 until codeSize) bits.add((code shr bit) and 1)
        }

        for (i in 0 until pixelCount) {
            push(clearCode)
            push(paletteIndex)
        }
        push(endCode)

        val bytes = ByteArray((bits.size + 7) / 8)
        for (i in bits.indices) {
            if (bits[i] == 1) {
                bytes[i / 8] = (bytes[i / 8].toInt() or (1 shl (i % 8))).toByte()
            }
        }
        return bytes
    }

    private fun writeSubBlocks(out: ByteArrayOutputStream, data: ByteArray) {
        var offset = 0
        while (offset < data.size) {
            val size = minOf(255, data.size - offset)
            out.write(size)
            out.write(data, offset, size)
            offset += size
        }
        out.write(0x00) // block terminator
    }

    private fun writeU16(out: ByteArrayOutputStream, value: Int) {
        out.write(value and 0xFF)
        out.write((value shr 8) and 0xFF)
    }
}
