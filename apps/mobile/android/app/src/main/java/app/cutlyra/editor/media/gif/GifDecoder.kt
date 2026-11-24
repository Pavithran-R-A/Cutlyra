package app.cutlyra.editor.media.gif

/**
 * Android-side animated GIF decoder.
 *
 * Mirrors `packages/editor-core/src/media/gif-decoder.ts` frame-for-frame — the
 * same disposal handling, the same delay normalisation and the same loop-count
 * reading — so the native import path and the shared renderer agree about what
 * frame is on screen at a given time. Android exposes no frame-index API for
 * animated GIFs (`ImageDecoder` only yields an `AnimatedImageDrawable`), so this
 * is a real decoder, not a wrapper.
 *
 * Pure Kotlin (no Android types) so it runs as a plain JVM unit test.
 */
data class DecodedGifFrame(
    /** Full logical-screen ARGB pixels (width * height). */
    val pixels: IntArray,
    /** Normalized delay in milliseconds. */
    val delayMs: Int,
    /** Frame delay exactly as stored (centiseconds * 10), before clamping. */
    val rawDelayMs: Int,
)

data class DecodedGif(
    val width: Int,
    val height: Int,
    /** Netscape loop count: 0 = forever, N = play N times. */
    val loopCount: Int,
    val frames: List<DecodedGifFrame>,
) {
    val totalDurationMs: Int get() = frames.sumOf { it.delayMs }
}

class GifDecodeException(message: String) : Exception(message)

object GifDecoder {
    private const val DEFAULT_DELAY_MS = 100

    fun decode(bytes: ByteArray): DecodedGif {
        if (bytes.size < 13) throw GifDecodeException("GIF is too short")
        val signature = String(bytes, 0, 3, Charsets.US_ASCII)
        if (signature != "GIF") throw GifDecodeException("Not a GIF")
        val version = String(bytes, 3, 3, Charsets.US_ASCII)
        if (version != "87a" && version != "89a") {
            throw GifDecodeException("Unsupported GIF version $version")
        }

        var pos = 6
        val width = readU16(bytes, pos); pos += 2
        val height = readU16(bytes, pos); pos += 2
        if (width <= 0 || height <= 0) throw GifDecodeException("GIF has no logical screen")
        val packed = bytes[pos].toInt() and 0xFF; pos += 1
        val bgIndex = bytes[pos].toInt() and 0xFF; pos += 1
        pos += 1 // aspect ratio

        val hasGct = (packed and 0x80) != 0
        val gctSize = if (hasGct) 1 shl ((packed and 0x07) + 1) else 0
        val gct = if (hasGct) {
            val table = IntArray(gctSize)
            for (i in 0 until gctSize) {
                table[i] = 0xFF000000.toInt() or
                    ((bytes[pos].toInt() and 0xFF) shl 16) or
                    ((bytes[pos + 1].toInt() and 0xFF) shl 8) or
                    (bytes[pos + 2].toInt() and 0xFF)
                pos += 3
            }
            table
        } else {
            null
        }

        var loopCount = 0
        val rawFrames = mutableListOf<RawFrame>()
        var delayCs = 0
        var disposal = 0
        var transparentIndex: Int? = null
        var hasTransparent = false

        while (pos < bytes.size) {
            val block = bytes[pos].toInt() and 0xFF
            if (block == 0x3B) break // trailer
            if (block == 0x21) {
                if (pos + 1 >= bytes.size) break
                val label = bytes[pos + 1].toInt() and 0xFF
                if (label == 0xF9) {
                    pos += 2
                    pos += 1 // block size
                    val gcePacked = bytes[pos].toInt() and 0xFF; pos += 1
                    delayCs = readU16(bytes, pos); pos += 2
                    transparentIndex = bytes[pos].toInt() and 0xFF; pos += 1
                    hasTransparent = (gcePacked and 0x01) != 0
                    disposal = (gcePacked shr 2) and 0x07
                    pos += 1 // terminator
                } else if (label == 0xFF) {
                    pos += 2
                    val blockSize = bytes[pos].toInt() and 0xFF; pos += 1
                    val app = String(bytes, pos, blockSize, Charsets.US_ASCII)
                    pos += blockSize
                    val sub = parseSubBlocks(bytes, pos)
                    if (app.startsWith("NETSCAPE")) {
                        if (sub.data.size >= 3 && (sub.data[0].toInt() and 0xFF) == 0x01) {
                            loopCount = (sub.data[1].toInt() and 0xFF) or
                                ((sub.data[2].toInt() and 0xFF) shl 8)
                        }
                    }
                    pos = sub.end
                } else {
                    pos += 2
                    val sub = parseSubBlocks(bytes, pos)
                    pos = sub.end
                }
            } else if (block == 0x2C) {
                pos += 1
                val left = readU16(bytes, pos); pos += 2
                val top = readU16(bytes, pos); pos += 2
                val frameWidth = readU16(bytes, pos); pos += 2
                val frameHeight = readU16(bytes, pos); pos += 2
                val imgPacked = bytes[pos].toInt() and 0xFF; pos += 1
                val hasLct = (imgPacked and 0x80) != 0
                val interlace = (imgPacked and 0x40) != 0
                val lctSize = if (hasLct) 1 shl ((imgPacked and 0x07) + 1) else 0
                val lct = if (hasLct) {
                    val table = IntArray(lctSize)
                    for (i in 0 until lctSize) {
                        table[i] = 0xFF000000.toInt() or
                            ((bytes[pos].toInt() and 0xFF) shl 16) or
                            ((bytes[pos + 1].toInt() and 0xFF) shl 8) or
                            (bytes[pos + 2].toInt() and 0xFF)
                        pos += 3
                    }
                    table
                } else {
                    null
                }
                val minCodeSize = bytes[pos].toInt() and 0xFF; pos += 1
                val sub = parseSubBlocks(bytes, pos)
                pos = sub.end

                rawFrames.add(
                    RawFrame(
                        left = left,
                        top = top,
                        width = frameWidth,
                        height = frameHeight,
                        colorTable = lct ?: gct,
                        interlace = interlace,
                        minCodeSize = minCodeSize,
                        imageData = sub.data,
                        delayCs = delayCs,
                        disposal = disposal,
                        transparentIndex = if (hasTransparent) transparentIndex else null,
                        hasTransparent = hasTransparent,
                    ),
                )

                delayCs = 0
                disposal = 0
                transparentIndex = null
                hasTransparent = false
            } else {
                pos++
            }
        }

        if (rawFrames.isEmpty()) throw GifDecodeException("GIF has no frames")

        var bgColor = 0xFF000000.toInt()
        if (gct != null && bgIndex < gct.size) bgColor = gct[bgIndex]

        val screen = IntArray(width * height) { bgColor }
        val frames = mutableListOf<DecodedGifFrame>()
        var cursor = 0

        for (raw in rawFrames) {
            val savedPrev = if (raw.disposal == 3) screen.copyOf() else null

            val indices = lzwDecode(raw.imageData, raw.minCodeSize, raw.width * raw.height)
            val ordered = if (raw.interlace) deinterlace(raw, indices) else indices

            for (y in 0 until raw.height) {
                for (x in 0 until raw.width) {
                    val sx = raw.left + x
                    val sy = raw.top + y
                    if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue
                    val index = ordered[y * raw.width + x].toInt() and 0xFF
                    val offset = sy * width + sx
                    if (raw.hasTransparent && raw.transparentIndex == index) {
                        screen[offset] = 0x00000000
                        continue
                    }
                    val table = raw.colorTable
                    screen[offset] = if (table != null && index < table.size) {
                        table[index]
                    } else {
                        0xFF000000.toInt()
                    }
                }
            }

            val rawDelayMs = raw.delayCs * 10
            val delayMs = normalizeDelay(rawDelayMs)
            frames.add(
                DecodedGifFrame(
                    pixels = screen.copyOf(),
                    delayMs = delayMs,
                    rawDelayMs = rawDelayMs,
                ),
            )
            cursor += delayMs

            if (raw.disposal == 2) {
                for (y in 0 until raw.height) {
                    for (x in 0 until raw.width) {
                        val sx = raw.left + x
                        val sy = raw.top + y
                        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue
                        screen[sy * width + sx] = bgColor
                    }
                }
            } else if (raw.disposal == 3 && savedPrev != null) {
                System.arraycopy(savedPrev, 0, screen, 0, screen.size)
            }
        }

        return DecodedGif(
            width = width,
            height = height,
            loopCount = loopCount,
            frames = frames,
        )
    }

    /** Same policy as `normalizeGifFrameDelay` in the shared engine. */
    fun normalizeDelay(rawDelayMs: Int): Int {
        if (rawDelayMs <= 10) return DEFAULT_DELAY_MS
        if (rawDelayMs < 20) return 20
        return rawDelayMs
    }

    private fun deinterlace(frame: RawFrame, indices: ByteArray): ByteArray {
        val ordered = ByteArray(frame.width * frame.height)
        val passes = intArrayOf(0, 4, 2, 1) // start rows
        val steps = intArrayOf(8, 8, 4, 2)
        var srcRow = 0
        for (pass in passes.indices) {
            var y = passes[pass]
            while (y < frame.height) {
                for (x in 0 until frame.width) {
                    ordered[y * frame.width + x] = indices[srcRow * frame.width + x]
                }
                srcRow++
                y += steps[pass]
            }
        }
        return ordered
    }

    private data class RawFrame(
        val left: Int,
        val top: Int,
        val width: Int,
        val height: Int,
        val colorTable: IntArray?,
        val interlace: Boolean,
        val minCodeSize: Int,
        val imageData: ByteArray,
        val delayCs: Int,
        val disposal: Int,
        val transparentIndex: Int?,
        val hasTransparent: Boolean,
    )

    private class SubBlocks(val data: ByteArray, val end: Int)

    private fun parseSubBlocks(bytes: ByteArray, start: Int): SubBlocks {
        val chunks = java.io.ByteArrayOutputStream()
        var i = start
        while (i < bytes.size) {
            val size = bytes[i].toInt() and 0xFF
            if (size == 0) {
                i++
                break
            }
            i++
            val available = minOf(size, bytes.size - i)
            chunks.write(bytes, i, available)
            i += size
        }
        return SubBlocks(chunks.toByteArray(), i)
    }

    private fun lzwDecode(data: ByteArray, minCodeSize: Int, expectedPixels: Int): ByteArray {
        val clearCode = 1 shl minCodeSize
        val endCode = clearCode + 1
        var codeSize = minCodeSize + 1
        var nextCode = endCode + 1
        val maxCode = 1 shl 12

        val table = ArrayList<IntArray>(4096)
        fun resetTable() {
            table.clear()
            for (i in 0 until clearCode) table.add(intArrayOf(i))
            table.add(IntArray(0)) // clear
            table.add(IntArray(0)) // end
            nextCode = endCode + 1
            codeSize = minCodeSize + 1
        }
        resetTable()

        val output = ByteArray(expectedPixels)
        var outIndex = 0
        var bitPos = 0

        fun readCode(): Int {
            var code = 0
            for (i in 0 until codeSize) {
                val byteIndex = (bitPos + i) shr 3
                val bitIndex = (bitPos + i) and 7
                if (byteIndex < data.size) {
                    if (((data[byteIndex].toInt() and 0xFF) shr bitIndex) and 1 == 1) {
                        code = code or (1 shl i)
                    }
                }
            }
            bitPos += codeSize
            return code
        }

        var prevCode = -1
        while (outIndex < expectedPixels) {
            val code = readCode()
            if (code == clearCode) {
                resetTable()
                prevCode = -1
                continue
            }
            if (code == endCode) break

            val entry: IntArray = when {
                code < table.size && table[code].isNotEmpty() -> table[code]
                code == nextCode && prevCode >= 0 && table[prevCode].isNotEmpty() ->
                    table[prevCode] + table[prevCode][0]
                else -> break // malformed stream
            }

            var i = 0
            while (i < entry.size && outIndex < expectedPixels) {
                output[outIndex++] = entry[i].toByte()
                i++
            }

            if (prevCode >= 0 && prevCode != clearCode && table[prevCode].isNotEmpty()) {
                if (nextCode < maxCode) {
                    val prev = table[prevCode]
                    val appended = IntArray(prev.size + 1)
                    System.arraycopy(prev, 0, appended, 0, prev.size)
                    appended[prev.size] = entry[0]
                    table.add(appended)
                    nextCode++
                    if (nextCode == (1 shl codeSize) && codeSize < 12) codeSize++
                }
            }
            prevCode = code
        }
        return output
    }

    private fun readU16(bytes: ByteArray, offset: Int): Int =
        (bytes[offset].toInt() and 0xFF) or ((bytes[offset + 1].toInt() and 0xFF) shl 8)
}
