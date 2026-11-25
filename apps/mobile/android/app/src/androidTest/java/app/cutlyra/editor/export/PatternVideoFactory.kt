package app.cutlyra.editor.export

import android.graphics.Bitmap
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import java.io.File

/**
 * Deterministic high-contrast striped source. Blur is measurable: sharp
 * vertical stripes have high per-pixel luminance change, a blurred copy of the
 * same stripes has much lower change, and the average stays mid-grey (so a
 * black letterbox bar can be told apart from a blurred backdrop).
 */
object PatternVideoFactory {
    /** Stripe width in source pixels (alternating black / white). */
    const val STRIPE_WIDTH = 20

    fun create(
        output: File,
        width: Int = 320,
        height: Int = 240,
        durationUs: Long = 2_000_000L,
        fps: Int = 30,
    ): File {
        require(width % 2 == 0 && height % 2 == 0)
        val mime = MediaFormat.MIMETYPE_VIDEO_AVC
        val format = MediaFormat.createVideoFormat(mime, width, height).apply {
            setInteger(
                MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible,
            )
            setInteger(MediaFormat.KEY_BIT_RATE, 6_000_000)
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
        }
        val codec = MediaCodec.createEncoderByType(mime)
        val muxer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        var started = false
        var track = -1
        val info = MediaCodec.BufferInfo()

        fun drain(waitUs: Long): Boolean {
            while (true) {
                val index = codec.dequeueOutputBuffer(info, waitUs)
                when {
                    index == MediaCodec.INFO_TRY_AGAIN_LATER -> return false
                    index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        track = muxer.addTrack(codec.outputFormat)
                        muxer.start()
                        started = true
                    }
                    index >= 0 -> {
                        if (info.size > 0) {
                            val buffer = codec.getOutputBuffer(index)!!
                            buffer.position(info.offset)
                            buffer.limit(info.offset + info.size)
                            muxer.writeSampleData(track, buffer, info)
                        }
                        codec.releaseOutputBuffer(index, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return true
                    }
                }
            }
        }

        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            val frameCount = (durationUs * fps / 1_000_000L).toInt()
            var frame = 0
            while (frame < frameCount) {
                val inputIndex = codec.dequeueInputBuffer(10_000L)
                if (inputIndex >= 0) {
                    fill(codec, inputIndex, width, height)
                    codec.queueInputBuffer(
                        inputIndex,
                        0,
                        width * height * 3 / 2,
                        frame * 1_000_000L / fps,
                        0,
                    )
                    frame++
                }
                drain(0L)
            }
            val eos = codec.dequeueInputBuffer(10_000L)
            check(eos >= 0)
            codec.queueInputBuffer(
                eos,
                0,
                0,
                frameCount * 1_000_000L / fps,
                MediaCodec.BUFFER_FLAG_END_OF_STREAM,
            )
            while (!drain(10_000L)) { /* drain to EOS */ }
        } finally {
            runCatching { codec.stop() }
            codec.release()
            if (started) runCatching { muxer.stop() }
            muxer.release()
        }
        check(output.length() > 0)
        return output
    }

    private fun fill(codec: MediaCodec, inputIndex: Int, width: Int, height: Int) {
        fun luma(x: Int): Int = if ((x / STRIPE_WIDTH) % 2 == 0) 235 else 16

        val image = codec.getInputImage(inputIndex)
        if (image != null) {
            val yPlane = image.planes[0]
            for (row in 0 until height) {
                for (col in 0 until width) {
                    yPlane.buffer.put(
                        row * yPlane.rowStride + col * yPlane.pixelStride,
                        luma(col).toByte(),
                    )
                }
            }
            val uPlane = image.planes[1]
            val vPlane = image.planes[2]
            for (row in 0 until height / 2) {
                for (col in 0 until width / 2) {
                    uPlane.buffer.put(row * uPlane.rowStride + col * uPlane.pixelStride, 128.toByte())
                    vPlane.buffer.put(row * vPlane.rowStride + col * vPlane.pixelStride, 128.toByte())
                }
            }
            return
        }
        val buffer = codec.getInputBuffer(inputIndex)!!
        buffer.clear()
        val ySize = width * height
        val bytes = ByteArray(ySize + ySize / 2)
        for (row in 0 until height) {
            for (col in 0 until width) {
                bytes[row * width + col] = luma(col).toByte()
            }
        }
        bytes.fill(128.toByte(), ySize)
        buffer.put(bytes)
    }

    fun frameAt(file: File, atUs: Long): Bitmap {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            return requireNotNull(
                retriever.getFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST),
            ) { "no decodable frame at ${atUs}us" }
        } finally {
            retriever.release()
        }
    }

    /**
     * Mean absolute luminance change between horizontally adjacent pixels over
     * `[x0, x1)` at row [yFraction]. Sharp stripes score high, a blurred copy
     * of the same stripes scores low.
     */
    fun edgeEnergy(
        frame: Bitmap,
        yFraction: Double,
        x0Fraction: Double,
        x1Fraction: Double,
    ): Double {
        val y = (frame.height * yFraction).toInt().coerceIn(0, frame.height - 1)
        val x0 = (frame.width * x0Fraction).toInt().coerceIn(0, frame.width - 1)
        val x1 = (frame.width * x1Fraction).toInt().coerceIn(x0 + 1, frame.width)
        var total = 0.0
        var count = 0
        for (x in x0 until x1 - 1) {
            val a = luma(frame.getPixel(x, y))
            val b = luma(frame.getPixel(x + 1, y))
            total += kotlin.math.abs(b - a).toDouble()
            count++
        }
        return if (count == 0) 0.0 else total / count
    }

    fun meanLuma(
        frame: Bitmap,
        yFraction: Double,
        x0Fraction: Double,
        x1Fraction: Double,
    ): Double {
        val y = (frame.height * yFraction).toInt().coerceIn(0, frame.height - 1)
        val x0 = (frame.width * x0Fraction).toInt().coerceIn(0, frame.width - 1)
        val x1 = (frame.width * x1Fraction).toInt().coerceIn(x0 + 1, frame.width)
        var total = 0.0
        for (x in x0 until x1) total += luma(frame.getPixel(x, y))
        return total / (x1 - x0)
    }

    private fun luma(color: Int): Int {
        val r = (color shr 16) and 0xFF
        val g = (color shr 8) and 0xFF
        val b = color and 0xFF
        return ((r * 299 + g * 587 + b * 114) / 1000)
    }
}
