package app.cutlyra.editor.media.reverse

import android.graphics.Bitmap
import android.graphics.Matrix
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import java.io.File
import java.util.UUID

/**
 * Bounded reverse-media generation.
 *
 * Reversing a clip by flipping a playback flag cannot work here: the retime
 * engine only accepts positive rates, the WASM preview compositor and the
 * Media3 exporter both decode forwards, and negative-rate player support is
 * not something a VideoFrameProcessor can provide. So Reverse generates ONE
 * ordinary forward-playing file whose frames are the clip's source frames in
 * reverse order, then the clip is retargeted at it. Preview and native export
 * need no new code path: they play a normal MP4.
 *
 * Why this design:
 *  - it respects the clip's trim boundaries because the caller passes the
 *    exact source range the element plays;
 *  - it preserves duration because the file covers exactly that range and the
 *    element keeps its retime rate;
 *  - it preserves rotation/crop/framing/transform because those stay on the
 *    element and are applied on top of the reversed pixels;
 *  - memory stays bounded: one decoded bitmap and one YUV frame are alive at a
 *    time, never the whole clip;
 *  - audio policy is explicit: the generated file has NO audio track, so the
 *    reversed clip is silent and the UI says so.
 *
 * Frames are sampled by [sourceTimestampMsForOutputFrame] with
 * `OPTION_CLOSEST` (never `OPTION_CLOSEST_SYNC`, which would return an
 * unrelated earlier keyframe). Cancellation is checked between frames, and a
 * cancelled run deletes its partial file.
 */
object ReverseMediaGenerator {
    const val REVERSE_SUBDIR = "reverse"
    const val MIN_FPS = 1
    const val MAX_FPS = 60

    private const val TIMEOUT_US = 10_000L
    private const val DURATION_TOLERANCE_MS = 50L

    class ReverseException(val code: String, message: String, cause: Throwable? = null) :
        RuntimeException(message, cause)

    data class GeneratedMedia(
        val relativePath: String,
        val file: File,
        val width: Int,
        val height: Int,
        val durationMs: Long,
        val frameCount: Int,
        val hasAudio: Boolean = false,
    )

    /** Output frame count for a source span. Pure, so it is unit-tested. */
    fun frameCount(startMs: Long, endMs: Long, fps: Int): Int {
        val span = endMs - startMs
        if (span <= 0L) return 0
        val safeFps = fps.coerceIn(MIN_FPS, MAX_FPS)
        return maxOf(1, Math.ceil(span.toDouble() * safeFps / 1000.0).toInt())
    }

    /**
     * Source instant (ms) that the [index]th OUTPUT frame samples. Output runs
     * last -> first, and each output frame samples the CENTRE of its source
     * bucket, so a reversed run is the exact mirror of the forward play order
     * and never re-reads either boundary.
     */
    fun sourceTimestampMsForOutputFrame(
        index: Int,
        frameCount: Int,
        startMs: Long,
        endMs: Long,
    ): Long {
        require(frameCount > 0) { "frameCount must be > 0" }
        require(index in 0 until frameCount) { "index $index outside 0..<$frameCount" }
        require(endMs > startMs) { "endMs must be after startMs" }
        val span = (endMs - startMs).toDouble()
        val bucket = frameCount - 1 - index
        val instant = startMs + (bucket + 0.5) * span / frameCount
        return minOf(endMs - 1, maxOf(startMs, Math.round(instant)))
    }

    /**
     * Deletes generated reverse files under `<custodyRoot>/reverse/` that the
     * project no longer references. Only `reverse-*.mp4` is ever touched, so
     * source media and other generated assets are safe.
     */
    fun pruneUnreferenced(
        custodyRoot: File,
        referencedPaths: Collection<String>,
    ): List<String> {
        val directory = File(custodyRoot, REVERSE_SUBDIR)
        if (!directory.isDirectory) return emptyList()
        val keep = referencedPaths.map { it.replace('\\', '/') }.toSet()
        val removed = mutableListOf<String>()
        for (child in directory.listFiles().orEmpty()) {
            if (!child.isFile) continue
            val relativePath = "$REVERSE_SUBDIR/${child.name}"
            if (relativePath in keep) continue
            if (!child.name.startsWith("reverse-") || !child.name.endsWith(".mp4")) continue
            if (child.delete()) removed.add(relativePath)
        }
        return removed
    }

    fun generate(
        sourceFile: File,
        startMs: Long,
        endMs: Long,
        fps: Int,
        custodyRoot: File,
        isCancelled: () -> Boolean = { false },
        onProgress: (done: Int, total: Int) -> Unit = { _, _ -> },
    ): GeneratedMedia {
        if (!sourceFile.isFile) {
            throw ReverseException(
                "SOURCE_UNREADABLE",
                "Source media is not readable: ${sourceFile.absolutePath}",
            )
        }
        if (startMs < 0L || endMs <= startMs) {
            throw ReverseException("INVALID_RANGE", "Source range $startMs..$endMs ms is empty")
        }
        val safeFps = fps.coerceIn(MIN_FPS, MAX_FPS)
        val retriever = MediaMetadataRetriever()
        var encoder: MediaCodec? = null
        var muxer: MediaMuxer? = null
        var outputFile: File? = null
        var muxerStarted = false
        try {
            retriever.setDataSource(sourceFile.absolutePath)
            val probedDurationMs = retriever
                .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull()
                ?: 0L
            val effectiveEnd = if (probedDurationMs > 0L) {
                if (endMs > probedDurationMs + DURATION_TOLERANCE_MS) {
                    throw ReverseException(
                        "RANGE_OUT_OF_BOUNDS",
                        "Source range ends at ${endMs}ms but the source is ${probedDurationMs}ms long",
                    )
                }
                minOf(endMs, probedDurationMs)
            } else {
                endMs
            }
            if (effectiveEnd <= startMs) {
                throw ReverseException(
                    "INVALID_RANGE",
                    "Source range $startMs..$endMs ms contains no frames",
                )
            }
            val rotation = retriever
                .extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
                ?.toIntOrNull()
                ?: 0
            val frameCount = frameCount(startMs, effectiveEnd, safeFps)
            if (frameCount <= 0) {
                throw ReverseException("INVALID_RANGE", "The source range produced no frames")
            }

            // First frame decides the output geometry, and is reused as frame 0.
            var bitmap = decodeFrame(
                retriever = retriever,
                timestampMs = sourceTimestampMsForOutputFrame(0, frameCount, startMs, effectiveEnd),
            )
            var normalized = normalizeFrame(bitmap, rotation)
            // `normalizeFrame` may return the SAME bitmap (no rotation, even
            // dimensions); only the original is recycled when a new one exists.
            if (normalized !== bitmap) bitmap.recycle()
            val width = normalized.width
            val height = normalized.height
            if (width < 2 || height < 2) {
                normalized.recycle()
                throw ReverseException(
                    "UNSUPPORTED_DIMENSIONS",
                    "The source frame is too small to encode (${width}x$height)",
                )
            }

            val directory = File(custodyRoot, REVERSE_SUBDIR)
            if (!directory.exists() && !directory.mkdirs()) {
                normalized.recycle()
                throw ReverseException(
                    "IO_ERROR",
                    "Could not create the reverse directory ${directory.absolutePath}",
                )
            }
            val file = File(directory, "reverse-${UUID.randomUUID()}.mp4")
            outputFile = file

            val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height)
            format.setInteger(
                MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible,
            )
            format.setInteger(MediaFormat.KEY_BIT_RATE, bitrateFor(width, height, safeFps))
            format.setInteger(MediaFormat.KEY_FRAME_RATE, safeFps)
            format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)

            val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            encoder = codec
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            val outMuxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            muxer = outMuxer
            val info = MediaCodec.BufferInfo()
            var trackIndex = -1

            fun drain(waitUs: Long): Boolean {
                while (true) {
                    val outputIndex = codec.dequeueOutputBuffer(info, waitUs)
                    when {
                        outputIndex == MediaCodec.INFO_TRY_AGAIN_LATER -> return false
                        outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                            trackIndex = outMuxer.addTrack(codec.outputFormat)
                            outMuxer.start()
                            muxerStarted = true
                        }
                        outputIndex >= 0 -> {
                            if (info.size > 0) {
                                check(trackIndex >= 0) { "encoder emitted samples before its format" }
                                val encoded = codec.getOutputBuffer(outputIndex)
                                    ?: error("encoder returned a null output buffer")
                                encoded.position(info.offset)
                                encoded.limit(info.offset + info.size)
                                outMuxer.writeSampleData(trackIndex, encoded, info)
                            }
                            codec.releaseOutputBuffer(outputIndex, false)
                            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return true
                        }
                    }
                }
            }

            for (index in 0 until frameCount) {
                if (isCancelled()) {
                    throw ReverseException("CANCELLED", "Reverse generation was cancelled")
                }
                val frame = if (index == 0) {
                    normalized
                } else {
                    val sourceMs = sourceTimestampMsForOutputFrame(
                        index,
                        frameCount,
                        startMs,
                        effectiveEnd,
                    )
                    val decoded = decodeFrame(retriever, sourceMs)
                    val adapted = normalizeFrame(decoded, rotation)
                    // Same ownership rule as the first frame: `normalizeFrame`
                    // returns the input untouched when no rotation/crop is needed.
                    if (adapted !== decoded) decoded.recycle()
                    adapted
                }
                try {
                    var queued = false
                    while (!queued) {
                        if (isCancelled()) {
                            throw ReverseException("CANCELLED", "Reverse generation was cancelled")
                        }
                        val inputIndex = codec.dequeueInputBuffer(TIMEOUT_US)
                        if (inputIndex >= 0) {
                            fillInput(codec, inputIndex, frame, width, height)
                            codec.queueInputBuffer(
                                inputIndex,
                                0,
                                width * height * 3 / 2,
                                index * 1_000_000L / safeFps,
                                0,
                            )
                            queued = true
                        }
                        drain(0L)
                    }
                } finally {
                    if (index > 0) frame.recycle()
                }
                drain(0L)
                onProgress(index + 1, frameCount)
            }

            val eosIndex = codec.dequeueInputBuffer(10_000L)
            check(eosIndex >= 0) { "encoder never accepted the end-of-stream marker" }
            codec.queueInputBuffer(
                eosIndex,
                0,
                0,
                frameCount * 1_000_000L / safeFps,
                MediaCodec.BUFFER_FLAG_END_OF_STREAM,
            )
            while (!drain(TIMEOUT_US)) {
                if (isCancelled()) {
                    throw ReverseException("CANCELLED", "Reverse generation was cancelled")
                }
            }

            return GeneratedMedia(
                relativePath = "$REVERSE_SUBDIR/${file.name}",
                file = file,
                width = width,
                height = height,
                durationMs = effectiveEnd - startMs,
                frameCount = frameCount,
            )
        } catch (e: ReverseException) {
            outputFile?.delete()
            throw e
        } catch (e: Exception) {
            outputFile?.delete()
            throw ReverseException("REVERSE_FAILED", "reverse generation failed: ${e.message}", e)
        } finally {
            runCatching { encoder?.stop() }
            runCatching { encoder?.release() }
            if (muxerStarted) {
                runCatching { muxer?.stop() }
            }
            runCatching { muxer?.release() }
            retriever.release()
        }
    }

    private fun decodeFrame(retriever: MediaMetadataRetriever, timestampMs: Long): Bitmap =
        retriever.getFrameAtTime(
            timestampMs * 1000L,
            MediaMetadataRetriever.OPTION_CLOSEST,
        ) ?: throw ReverseException(
            "FRAME_UNAVAILABLE",
            "The decoder returned no frame at ${timestampMs}ms",
        )

    /**
     * Applies the container's display rotation and crops odd edges, which
     * YUV420 encoders cannot represent. Rotation is applied here (not left in
     * metadata) so the generated file is upright at rotation 0 and every
     * downstream mapper treats it as an ordinary landscape/portrait source.
     */
    private fun normalizeFrame(source: Bitmap, rotationDegrees: Int): Bitmap {
        val rotated = when (rotationDegrees) {
            90, 180, 270 -> {
                val matrix = Matrix().apply { postRotate(rotationDegrees.toFloat()) }
                Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
            }
            else -> source
        }
        val evenWidth = rotated.width - (rotated.width % 2)
        val evenHeight = rotated.height - (rotated.height % 2)
        if (evenWidth == rotated.width && evenHeight == rotated.height) return rotated
        val cropped = Bitmap.createBitmap(rotated, 0, 0, evenWidth, evenHeight)
        if (cropped !== rotated) rotated.recycle()
        return cropped
    }

    private fun fillInput(
        codec: MediaCodec,
        inputIndex: Int,
        bitmap: Bitmap,
        width: Int,
        height: Int,
    ) {
        val pixels = IntArray(width * height)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
        val image = codec.getInputImage(inputIndex)
        if (image != null) {
            val yPlane = image.planes[0]
            val uPlane = image.planes[1]
            val vPlane = image.planes[2]
            for (row in 0 until height) {
                for (col in 0 until width) {
                    val (r, g, b) = rgb(pixels[row * width + col])
                    yPlane.buffer.put(
                        row * yPlane.rowStride + col * yPlane.pixelStride,
                        clampToByte(yOf(r, g, b)),
                    )
                }
            }
            val chromaWidth = width / 2
            val chromaHeight = height / 2
            for (row in 0 until chromaHeight) {
                for (col in 0 until chromaWidth) {
                    val (r, g, b) = averageChroma(pixels, width, col * 2, row * 2)
                    val u = clampToByte(uOf(r, g, b))
                    val v = clampToByte(vOf(r, g, b))
                    uPlane.buffer.put(
                        row * uPlane.rowStride + col * uPlane.pixelStride,
                        u,
                    )
                    vPlane.buffer.put(
                        row * vPlane.rowStride + col * vPlane.pixelStride,
                        v,
                    )
                }
            }
            return
        }

        // Fallback for encoders that expose no input Image: planar YUV420.
        val buffer = codec.getInputBuffer(inputIndex)
            ?: error("encoder returned neither an input image nor an input buffer")
        buffer.clear()
        val ySize = width * height
        val uSize = ySize / 4
        val bytes = ByteArray(ySize + 2 * uSize)
        for (row in 0 until height) {
            for (col in 0 until width) {
                val (r, g, b) = rgb(pixels[row * width + col])
                bytes[row * width + col] = clampToByte(yOf(r, g, b))
            }
        }
        var index = ySize
        for (row in 0 until height / 2) {
            for (col in 0 until width / 2) {
                val (r, g, b) = averageChroma(pixels, width, col * 2, row * 2)
                bytes[index++] = clampToByte(uOf(r, g, b))
            }
        }
        for (row in 0 until height / 2) {
            for (col in 0 until width / 2) {
                val (r, g, b) = averageChroma(pixels, width, col * 2, row * 2)
                bytes[index++] = clampToByte(vOf(r, g, b))
            }
        }
        buffer.put(bytes)
    }

    private fun averageChroma(
        pixels: IntArray,
        width: Int,
        x: Int,
        y: Int,
    ): Triple<Int, Int, Int> {
        var r = 0
        var g = 0
        var b = 0
        var count = 0
        for (dy in 0..1) {
            for (dx in 0..1) {
                val px = x + dx
                val py = y + dy
                if (px >= width) continue
                val index = py * width + px
                if (index >= pixels.size) continue
                val (pr, pg, pb) = rgb(pixels[index])
                r += pr
                g += pg
                b += pb
                count++
            }
        }
        if (count == 0) return Triple(0, 0, 0)
        return Triple(r / count, g / count, b / count)
    }

    private fun rgb(color: Int): Triple<Int, Int, Int> =
        Triple((color shr 16) and 0xFF, (color shr 8) and 0xFF, color and 0xFF)

    private fun yOf(r: Int, g: Int, b: Int): Int = ((66 * r + 129 * g + 25 * b + 128) shr 8) + 16

    private fun uOf(r: Int, g: Int, b: Int): Int = ((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128

    private fun vOf(r: Int, g: Int, b: Int): Int = ((112 * r - 94 * g - 18 * b + 128) shr 8) + 128

    private fun clampToByte(value: Int): Byte = value.coerceIn(0, 255).toByte()

    private fun bitrateFor(width: Int, height: Int, fps: Int): Int {
        val bitsPerSecond = width.toLong() * height.toLong() * fps.toLong() / 4L
        return bitsPerSecond.coerceIn(1_000_000L, 40_000_000L).toInt()
    }
}
