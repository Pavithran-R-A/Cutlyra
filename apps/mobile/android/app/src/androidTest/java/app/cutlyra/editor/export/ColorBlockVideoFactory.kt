package app.cutlyra.editor.export

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File

/**
 * Deterministic two-colour video fixture for chroma-key export tests.
 *
 * A solid [background] frame with one solid [block] rectangle in its centre.
 * Both regions are far larger than H.264's 4:2:0 chroma grid, so decoding the
 * exported MP4 and sampling the middle of each region reads an unambiguous
 * colour — the same "decoded pixels, not unit-test math" contract the mask
 * fixtures use.
 */
object ColorBlockVideoFactory {
    fun create(
        output: File,
        background: Triple<Int, Int, Int>,
        block: Triple<Int, Int, Int>,
        width: Int = 320,
        height: Int = 320,
        durationUs: Long = 1_200_000L,
        fps: Int = 30,
        blockLeft: Int = width * 3 / 10,
        blockRight: Int = width * 7 / 10,
        blockTop: Int = height * 3 / 10,
        blockBottom: Int = height * 7 / 10,
    ): File {
        require(width % 2 == 0 && height % 2 == 0)
        require(blockLeft % 2 == 0 && blockRight % 2 == 0)
        require(blockLeft >= 0 && blockRight <= width && blockTop >= 0 && blockBottom <= height)

        fun colorAt(x: Int, y: Int): Triple<Int, Int, Int> =
            if (x in blockLeft until blockRight && y in blockTop until blockBottom) block else background

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

        fun luma(rgb: Triple<Int, Int, Int>): Int =
            (0.2126 * rgb.first + 0.7152 * rgb.second + 0.0722 * rgb.third).toInt()

        fun cb(rgb: Triple<Int, Int, Int>): Int =
            (128 + (rgb.third - luma(rgb)) / 1.8556).toInt().coerceIn(0, 255)

        fun cr(rgb: Triple<Int, Int, Int>): Int =
            (128 + (rgb.first - luma(rgb)) / 1.5748).toInt().coerceIn(0, 255)

        fun fill(codec: MediaCodec, inputIndex: Int) {
            val image = codec.getInputImage(inputIndex)
            if (image != null) {
                val yPlane = image.planes[0]
                val uPlane = image.planes[1]
                val vPlane = image.planes[2]
                for (row in 0 until height) {
                    for (col in 0 until width) {
                        yPlane.buffer.put(
                            row * yPlane.rowStride + col * yPlane.pixelStride,
                            luma(colorAt(col, row)).toByte(),
                        )
                    }
                }
                for (row in 0 until height / 2) {
                    for (col in 0 until width / 2) {
                        val rgb = colorAt(col * 2, row * 2)
                        uPlane.buffer.put(
                            row * uPlane.rowStride + col * uPlane.pixelStride,
                            cb(rgb).toByte(),
                        )
                        vPlane.buffer.put(
                            row * vPlane.rowStride + col * vPlane.pixelStride,
                            cr(rgb).toByte(),
                        )
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
                    bytes[row * width + col] = luma(colorAt(col, row)).toByte()
                }
            }
            for (row in 0 until height / 2) {
                for (col in 0 until width / 2) {
                    val rgb = colorAt(col * 2, row * 2)
                    bytes[ySize + row * (width / 2) + col] = cb(rgb).toByte()
                    bytes[ySize + ySize / 4 + row * (width / 2) + col] = cr(rgb).toByte()
                }
            }
            buffer.put(bytes)
        }

        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            val frameCount = (durationUs * fps / 1_000_000L).toInt()
            var frame = 0
            while (frame < frameCount) {
                val inputIndex = codec.dequeueInputBuffer(10_000L)
                if (inputIndex >= 0) {
                    fill(codec, inputIndex)
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
}
