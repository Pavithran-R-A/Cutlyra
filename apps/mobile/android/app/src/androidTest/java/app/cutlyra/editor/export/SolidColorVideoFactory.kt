package app.cutlyra.editor.export

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import java.io.File

/**
 * Builds a deterministic source video whose temporal segments are solid,
 * distinguishable colors. This gives Freeze Frame export tests an actual
 * expected pixel (e.g. "the frame at 500ms is RED"), instead of the weaker
 * "decodes to something non-black" check that cannot tell a correct capture
 * apart from an unrelated keyframe.
 *
 * The file is encoded on-device with [MediaCodec] (AVC, YUV420 flexible input)
 * and muxed with [MediaMuxer] — no binary fixture needed.
 */
object SolidColorVideoFactory {
    data class Segment(val colorName: String, val y: Int, val u: Int, val v: Int)

    val RED = Segment("red", y = 81, u = 90, v = 240)
    val GREEN = Segment("green", y = 145, u = 54, v = 34)
    val BLUE = Segment("blue", y = 41, u = 240, v = 110)

    /**
     * Encodes [segments], each held for [segmentDurationUs], at [fps].
     * Returns the written file.
     */
    fun create(
        output: File,
        segments: List<Segment>,
        width: Int = 320,
        height: Int = 240,
        segmentDurationUs: Long = 1_000_000L,
        fps: Int = 30,
    ): File {
        require(segments.isNotEmpty()) { "at least one segment is required" }
        require(width % 2 == 0 && height % 2 == 0) { "dimensions must be even" }

        val mime = MediaFormat.MIMETYPE_VIDEO_AVC
        val format = MediaFormat.createVideoFormat(mime, width, height).apply {
            setInteger(
                MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible,
            )
            setInteger(MediaFormat.KEY_BIT_RATE, 2_000_000)
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
        }

        val codec = MediaCodec.createEncoderByType(mime)
        val muxer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        var muxerStarted = false
        var trackIndex = -1
        val info = MediaCodec.BufferInfo()

        fun drainOutput(waitUs: Long): Boolean {
            while (true) {
                val outputIndex = codec.dequeueOutputBuffer(info, waitUs)
                when {
                    outputIndex == MediaCodec.INFO_TRY_AGAIN_LATER -> return false
                    outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        trackIndex = muxer.addTrack(codec.outputFormat)
                        muxer.start()
                        muxerStarted = true
                    }
                    outputIndex >= 0 -> {
                        if (info.size > 0) {
                            check(trackIndex >= 0) { "encoder emitted samples before its format" }
                            val encoded = codec.getOutputBuffer(outputIndex)
                                ?: error("encoder returned a null output buffer")
                            encoded.position(info.offset)
                            encoded.limit(info.offset + info.size)
                            muxer.writeSampleData(trackIndex, encoded, info)
                        }
                        codec.releaseOutputBuffer(outputIndex, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                            return true
                        }
                    }
                }
            }
        }

        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()

            val frameDurationUs = 1_000_000L / fps
            val framesPerSegment = (segmentDurationUs / frameDurationUs).toInt()
            val totalFrames = segments.size * framesPerSegment
            var frameIndex = 0

            while (frameIndex < totalFrames) {
                val inputIndex = codec.dequeueInputBuffer(10_000L)
                if (inputIndex >= 0) {
                    val segmentIndex = (frameIndex / framesPerSegment).coerceAtMost(segments.lastIndex)
                    fillInput(codec, inputIndex, segments[segmentIndex], width, height)
                    codec.queueInputBuffer(
                        inputIndex,
                        0,
                        width * height * 3 / 2,
                        frameIndex * frameDurationUs,
                        0,
                    )
                    frameIndex++
                }
                drainOutput(waitUs = 0L)
            }

            val eosIndex = codec.dequeueInputBuffer(10_000L)
            check(eosIndex >= 0) { "encoder never accepted the end-of-stream marker" }
            codec.queueInputBuffer(
                eosIndex,
                0,
                0,
                totalFrames * frameDurationUs,
                MediaCodec.BUFFER_FLAG_END_OF_STREAM,
            )
            while (!drainOutput(waitUs = 10_000L)) {
                // Keep draining until the encoder reports end-of-stream.
            }
        } finally {
            runCatching { codec.stop() }
            codec.release()
            if (muxerStarted) {
                runCatching { muxer.stop() }
            }
            muxer.release()
        }

        assertTrue("generated source must not be empty", output.length() > 0)
        return output
    }

    private fun fillInput(
        codec: MediaCodec,
        inputIndex: Int,
        segment: Segment,
        width: Int,
        height: Int,
    ) {
        val image = codec.getInputImage(inputIndex)
        if (image != null) {
            image.planes.forEachIndexed { planeIndex, plane ->
                val buffer = plane.buffer
                val value = when (planeIndex) {
                    0 -> segment.y
                    1 -> segment.u
                    else -> segment.v
                }
                val rowStride = plane.rowStride
                val pixelStride = plane.pixelStride
                val planeWidth = if (planeIndex == 0) width else width / 2
                val planeHeight = if (planeIndex == 0) height else height / 2
                for (row in 0 until planeHeight) {
                    for (col in 0 until planeWidth) {
                        buffer.put(row * rowStride + col * pixelStride, value.toByte())
                    }
                }
            }
            return
        }

        // Fallback for encoders that expose no input Image: planar YUV420.
        val buffer = codec.getInputBuffer(inputIndex)
            ?: error("encoder returned neither an input image nor an input buffer")
        buffer.clear()
        val ySize = width * height
        val uvSize = ySize / 4
        val bytes = ByteArray(ySize + 2 * uvSize)
        bytes.fill(segment.y.toByte(), 0, ySize)
        bytes.fill(segment.u.toByte(), ySize, ySize + uvSize)
        bytes.fill(segment.v.toByte(), ySize + uvSize, bytes.size)
        buffer.put(bytes)
    }

    /** Decodes the dominant channel of the center pixel at [atUs]. */
    fun dominantChannelAt(file: File, atUs: Long): String {
        val (r, g, b) = centerPixelAt(file, atUs)
        return when {
            r > g + 30 && r > b + 30 -> "red"
            g > r + 30 && g > b + 30 -> "green"
            b > r + 30 && b > g + 30 -> "blue"
            else -> "mixed($r,$g,$b)"
        }
    }

    /** Decodes the center pixel at [atUs] as RGB (for assertions/messages). */
    fun centerPixelAt(file: File, atUs: Long): Triple<Int, Int, Int> {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            val frame = retriever.getFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST)
            assertNotNull("expected a decodable frame at ${atUs}us", frame)
            val pixel = frame!!.getPixel(frame.width / 2, frame.height / 2)
            frame.recycle()
            return Triple((pixel shr 16) and 0xFF, (pixel shr 8) and 0xFF, pixel and 0xFF)
        } finally {
            retriever.release()
        }
    }

    fun assertSolidColor(file: File, atUs: Long, expected: String) {
        val actual = dominantChannelAt(file, atUs)
        assertTrue(
            "frame at ${atUs}us should be $expected, dominant channel was $actual " +
                "(${centerPixelAt(file, atUs)})",
            actual == expected,
        )
    }
}
