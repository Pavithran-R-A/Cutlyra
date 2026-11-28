package app.cutlyra.editor.media

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction

/**
 * Decoding and validation for subtitle documents picked through SAF.
 *
 * Plain JVM (no Android framework), so the rules are unit-tested rather than
 * only exercised by a physical pick: a picked file may be UTF-8, UTF-8 with a
 * BOM, or UTF-16 with a BOM, and anything else is reported as unreadable text
 * instead of being silently decoded with U+FFFD replacement characters. A
 * mis-decoded subtitle would import as garbled cues and look successful until
 * the exported video was watched.
 *
 * Content is also validated, because SAF providers can ignore a MIME filter:
 * a picked README (or a video, decoded as bytes) has no `-->` timing lines and
 * is refused before it reaches the shared subtitle parser.
 */
object SubtitleFileCodec {
    /** Hard cap for a picked subtitle document. */
    const val MAX_BYTES: Int = 2 * 1024 * 1024

    private val SUPPORTED_EXTENSIONS = listOf(".srt", ".vtt", ".txt")

    class InvalidSubtitleFileException(message: String) : Exception(message)

    /**
     * Strictly decodes a document. Returns the text with the chosen BOM
     * removed; throws for empty bytes, malformed sequences and unmappable
     * characters.
     */
    fun decode(bytes: ByteArray): String {
        if (bytes.isEmpty()) {
            throw InvalidSubtitleFileException("The selected file is empty")
        }

        val offset: Int
        val length: Int
        val charset: Charset
        when {
            bytes.size >= 3 &&
                bytes[0] == 0xEF.toByte() &&
                bytes[1] == 0xBB.toByte() &&
                bytes[2] == 0xBF.toByte() -> {
                offset = 3
                length = bytes.size - 3
                charset = Charsets.UTF_8
            }
            bytes.size >= 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xFE.toByte() -> {
                offset = 2
                length = bytes.size - 2
                charset = Charsets.UTF_16LE
            }
            bytes.size >= 2 && bytes[0] == 0xFE.toByte() && bytes[1] == 0xFF.toByte() -> {
                offset = 2
                length = bytes.size - 2
                charset = Charsets.UTF_16BE
            }
            else -> {
                offset = 0
                length = bytes.size
                charset = Charsets.UTF_8
            }
        }

        val decoder = charset.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        return try {
            decoder.decode(ByteBuffer.wrap(bytes, offset, length)).toString()
        } catch (_: CharacterCodingException) {
            throw InvalidSubtitleFileException(
                "This file is not valid ${charset.name()} text. Save it as UTF-8 and try again.",
            )
        }
    }

    /**
     * Validates a picked document's display name. A missing name is accepted:
     * some providers hand back anonymous documents, and [validateContent] then
     * decides from the bytes alone.
     */
    fun validateExtension(name: String?) {
        val lower = name?.lowercase() ?: return
        if (SUPPORTED_EXTENSIONS.none { lower.endsWith(it) }) {
            throw InvalidSubtitleFileException(
                "$name is not a subtitle file. Choose an .srt or .vtt file.",
            )
        }
    }

    /** Refuses text with no cue timing at all. */
    fun validateContent(text: String) {
        if (!text.contains("-->")) {
            throw InvalidSubtitleFileException(
                "No timed subtitle cues in this file. Choose an SRT or WebVTT file with --> timing lines.",
            )
        }
    }

    /** Content wins over extension: a `.txt` holding WebVTT is still WebVTT. */
    fun detectFormat(text: String): String =
        if (text.trimStart('\uFEFF').startsWith("WEBVTT")) "vtt" else "srt"
}
