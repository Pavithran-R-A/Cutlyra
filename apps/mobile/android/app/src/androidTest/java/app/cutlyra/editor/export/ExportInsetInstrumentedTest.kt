package app.cutlyra.editor.export

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.opengl.EGL14
import android.opengl.EGLExt
import android.opengl.GLES20
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cutlyra.editor.edl.Edl
import app.cutlyra.editor.edl.EdlAsset
import app.cutlyra.editor.edl.EdlAssetKind
import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlMeta
import app.cutlyra.editor.edl.EdlOutput
import app.cutlyra.editor.edl.EdlRational
import app.cutlyra.editor.edl.EdlTrack
import app.cutlyra.editor.edl.EdlTrackKind
import app.cutlyra.editor.edl.EdlTrackType
import app.cutlyra.editor.edl.EdlTransform
import app.cutlyra.editor.edl.EdlTransition
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * GitHub #29 / Linear PAV-82 — "every export renders the picture ~0.7%
 * smaller than the frame".
 *
 * The container box, SAR and DAR are all correct (that is what
 * [ExportGeometryInstrumentedTest] gates); the defect is INSIDE the frame:
 * the picture is uniformly scaled down by ~0.9926 and centred, leaving a thin
 * black border on all four sides. Mean-absolute-difference gates cannot see it
 * because a 7 px shift of real footage barely moves any pixel, so this test
 * uses the one fixture where the defect is unambiguous: a FLAT WHITE source
 * whose aspect ratio exactly matches the export, composited through the real
 * [Media3Exporter]. Any black pixel at the picture edge is introduced padding.
 *
 * Measured on the POCO M4 Pro 5G (Stage-6 requalification, build `b1cd6a2`):
 *
 * | export | frame | border introduced |
 * | --- | --- | --- |
 * | 1080p | 1920x1080 | 7 / 7 / 3-4 / 3-4 px |
 * | 720p  | 1280x720  | 5 / 5 / 2 / 2 px |
 * | portrait | 1080x1920 | 3 / 3 / 6 / 6 px |
 *
 * All three imply a single uniform scale of 1080/1088 = 0.99265, i.e. a
 * 16-aligned intermediate frame that a later scale-to-fit pass shrinks into
 * the real output box. Only ONE normalization pass may size the picture.
 *
 * Tolerance: 1 px per side. Encoder ringing at the outermost row/column is a
 * real sampling artifact of H.264 in some colour pipelines, but a 3-7 px
 * uniform border is not — pre-fix numbers fail this gate by 3x.
 */
@RunWith(AndroidJUnit4::class)
class ExportInsetInstrumentedTest {
    private lateinit var context: Context
    private val ticksPerSecond = 120_000L

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
    }

    @After
    fun tearDown() {
        // Fixtures/exports live in cacheDir and are deleted per test.
    }

    /** Border introduced by the export, in pixels, per side. */
    private data class Border(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        val max: Int get() = maxOf(left, top, right, bottom)
        override fun toString(): String = "left=$left top=$top right=$right bottom=$bottom"
    }

    private fun identityTransform() = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0)

    private fun buildEdl(
        source: File,
        sourceWidth: Int,
        sourceHeight: Int,
        outputWidth: Int,
        outputHeight: Int,
        clipTicks: Long,
        withCrossfade: Boolean,
    ): Edl {
        val asset = EdlAsset(
            assetId = "asset-white",
            kind = EdlAssetKind.VIDEO,
            name = source.name,
            sourceUri = source.toURI().toString(),
            codec = null,
            width = sourceWidth,
            height = sourceHeight,
            durationTicks = 2 * ticksPerSecond,
            rotationDegrees = 0,
            hasAudio = false,
        )
        fun clip(clipId: String, startTicks: Long) = EdlClip(
            clipId = clipId,
            kind = "video",
            assetId = "asset-white",
            name = clipId,
            startTicks = startTicks,
            durationTicks = clipTicks,
            sourceStartTicks = 0,
            sourceEndTicks = clipTicks,
            speed = EdlRational(1, 1),
            maintainPitch = false,
            volumeDb = 0.0,
            muted = false,
            hidden = false,
            transform = identityTransform(),
            opacity = 1.0,
            effects = emptyList(),
            hasMasks = false,
            animations = emptyList(),
            params = emptyMap(),
        )
        val transitionTicks = ticksPerSecond / 10 // 100 ms
        val clips = if (withCrossfade) {
            // Two clips overlapping by `transitionTicks` so the compositor
            // (multi-input path) is exercised, not the single-input graph.
            listOf(clip("clip-a", 0), clip("clip-b", clipTicks - transitionTicks))
        } else {
            listOf(clip("clip-a", 0))
        }
        val mainTrack = EdlTrack(
            trackId = "track-main",
            kind = EdlTrackKind.MAIN,
            trackType = EdlTrackType.VIDEO,
            name = "Main",
            zIndex = 0,
            muted = false,
            hidden = false,
            clips = clips,
        )
        val transitions = if (withCrossfade) {
            listOf(
                EdlTransition(
                    transitionId = "t-1",
                    afterClipId = "clip-a",
                    kind = "crossfade",
                    durationTicks = transitionTicks,
                ),
            )
        } else {
            emptyList()
        }
        return Edl(
            meta = EdlMeta(
                edlVersion = 1,
                generator = "cutlyra-inset-test",
                ticksPerSecond = ticksPerSecond,
                frameRate = EdlRational(30, 1),
                canvasWidth = outputWidth,
                canvasHeight = outputHeight,
                projectId = "proj-inset",
                projectName = "Inset Fixture",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = clips.maxOf { it.startTicks + it.durationTicks },
            ),
            assets = listOf(asset),
            tracks = listOf(mainTrack),
            transitions = transitions,
            overlays = emptyList(),
            output = EdlOutput(
                container = "mp4",
                videoCodec = "avc1",
                audioCodec = "mp4a",
                bitrate = 8_000_000,
                fps = EdlRational(30, 1),
                resolutionWidth = outputWidth,
                resolutionHeight = outputHeight,
                includeAudio = false,
            ),
        )
    }

    private fun export(edl: Edl, name: String): File {
        val out = File(context.cacheDir, "inset_${name}_${System.nanoTime()}.mp4")
        out.delete()
        val latch = CountDownLatch(1)
        val events = mutableListOf<Media3Exporter.Event>()
        Media3Exporter.start(context, edl, out) { event ->
            events.add(event)
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                latch.countDown()
            }
        }
        assertTrue(
            "export '$name' did not terminate within 180s: $events",
            latch.await(180, TimeUnit.SECONDS),
        )
        val terminal = events.lastOrNull()
        assertTrue("export '$name' failed: $terminal", terminal is Media3Exporter.Event.Done)
        assertTrue("export '$name' wrote no file", out.exists() && out.length() > 0)
        return out
    }

    /**
     * Measures the white picture's bounding box in the decoded frame. The
     * fixture is flat white (luma ~235 in limited range); a pixel counts as
     * picture when all three channels are >= [threshold]. With a 1 px margin
     * to the encoded edge, any padding reads as a black band.
     */
    private fun measureBorder(file: File): Border {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            val frame = retriever.getFrameAtTime(
                400_000L,
                MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
            ) ?: throw AssertionError("undecodable export: no frame at 400 ms in ${file.name}")
            val bmp = frame.copy(Bitmap.Config.ARGB_8888, false)
                ?: throw AssertionError("could not convert frame of ${file.name}")
            val px = IntArray(bmp.width * bmp.height)
            bmp.getPixels(px, 0, bmp.width, 0, 0, bmp.width, bmp.height)
            var left = bmp.width
            var right = -1
            var top = bmp.height
            var bottom = -1
            for (y in 0 until bmp.height) {
                val row = y * bmp.width
                for (x in 0 until bmp.width) {
                    val p = px[row + x]
                    val r = (p shr 16) and 0xFF
                    val g = (p shr 8) and 0xFF
                    val b = p and 0xFF
                    if (r >= 128 && g >= 128 && b >= 128) {
                        if (x < left) left = x
                        if (x > right) right = x
                        if (y < top) top = y
                        if (y > bottom) bottom = y
                    }
                }
            }
            val w = bmp.width
            val h = bmp.height
            bmp.recycle()
            frame.recycle()
            if (right < 0) {
                throw AssertionError(
                    "export ${file.name} (${w}x$h) has no white picture at all — " +
                        "the fixture did not reach the encoder",
                )
            }
            return Border(
                left = left,
                top = top,
                right = (w - 1) - right,
                bottom = (h - 1) - bottom,
            )
        } finally {
            retriever.release()
        }
    }

    private fun assertNoIntroducedBorder(file: File, label: String) {
        val border = measureBorder(file)
        assertTrue(
            "$label introduced a ${border.max}px border ($border) — the exported picture must " +
                "fill the frame (GitHub #29: a uniform 1080/1088 scale shows up here)",
            border.max <= 1,
        )
    }

    @Test
    fun export_1080p_from_same_aspect_source_has_no_introduced_border() {
        val source = createSolidClip(width = 640, height = 360)
        val out = export(
            buildEdl(source, 640, 360, 1920, 1080, clipTicks = ticksPerSecond / 2, withCrossfade = false),
            "1080p-plain",
        )
        try {
            assertNoIntroducedBorder(out, "1080p export")
        } finally {
            out.delete()
            source.delete()
        }
    }

    @Test
    fun export_720p_from_same_aspect_source_has_no_introduced_border() {
        val source = createSolidClip(width = 640, height = 360)
        val out = export(
            buildEdl(source, 640, 360, 1280, 720, clipTicks = ticksPerSecond / 2, withCrossfade = false),
            "720p-plain",
        )
        try {
            assertNoIntroducedBorder(out, "720p export")
        } finally {
            out.delete()
            source.delete()
        }
    }

    @Test
    fun export_portrait_from_same_aspect_source_has_no_introduced_border() {
        val source = createSolidClip(width = 360, height = 640)
        val out = export(
            buildEdl(source, 360, 640, 1080, 1920, clipTicks = ticksPerSecond / 2, withCrossfade = false),
            "portrait-plain",
        )
        try {
            assertNoIntroducedBorder(out, "portrait export")
        } finally {
            out.delete()
            source.delete()
        }
    }

    /** The multi-input (compositor) path must not add padding either. */
    @Test
    fun export_1080p_through_a_crossfade_has_no_introduced_border() {
        val source = createSolidClip(width = 640, height = 360)
        val out = export(
            buildEdl(source, 640, 360, 1920, 1080, clipTicks = ticksPerSecond / 2, withCrossfade = true),
            "1080p-crossfade",
        )
        try {
            assertNoIntroducedBorder(out, "1080p crossfade export")
        } finally {
            out.delete()
            source.delete()
        }
    }

    // -- flat white fixture ---------------------------------------------------
    // AVC surface encoder fed by an EGL window surface cleared to white, the
    // same technique as ExportCrossfadeGeometryProbeInstrumentedTest. The
    // fixture must FILL its own frame so any border in the export is padding
    // introduced by the export pipeline, not letterboxing.

    private fun createSolidClip(width: Int, height: Int, seconds: Double = 1.0): File {
        val fps = 30
        val frameCount = (seconds * fps).toInt()
        val target = File(context.cacheDir, "inset_white_${width}x$height.mp4")
        target.delete()

        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height)
            .apply {
                setInteger(
                    MediaFormat.KEY_COLOR_FORMAT,
                    MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface,
                )
                setInteger(MediaFormat.KEY_BIT_RATE, 8_000_000)
                setInteger(MediaFormat.KEY_FRAME_RATE, fps)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
            }

        val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val inputSurface = encoder.createInputSurface()
        encoder.start()

        val muxer = MediaMuxer(target.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        var muxerStarted = false
        var trackIndex = -1
        val bufferInfo = MediaCodec.BufferInfo()

        val eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        check(EGL14.eglInitialize(eglDisplay, null, 0, null, 0)) { "eglInitialize failed" }
        val configAttribs = intArrayOf(
            EGL14.EGL_RED_SIZE, 8,
            EGL14.EGL_GREEN_SIZE, 8,
            EGL14.EGL_BLUE_SIZE, 8,
            EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
            0x3142 /* EGL_RECORDABLE_ANDROID */, 1,
            EGL14.EGL_NONE,
        )
        val configs = arrayOfNulls<android.opengl.EGLConfig>(1)
        val numConfigs = IntArray(1)
        check(EGL14.eglChooseConfig(eglDisplay, configAttribs, 0, configs, 0, 1, numConfigs, 0)) {
            "eglChooseConfig failed"
        }
        val config = checkNotNull(configs[0]) { "no EGL config" }
        val eglContext = EGL14.eglCreateContext(
            eglDisplay,
            config,
            EGL14.EGL_NO_CONTEXT,
            intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE),
            0,
        )
        val eglSurface = EGL14.eglCreateWindowSurface(
            eglDisplay,
            config,
            inputSurface,
            intArrayOf(EGL14.EGL_NONE),
            0,
        )
        check(EGL14.eglMakeCurrent(eglDisplay, eglSurface, eglSurface, eglContext)) {
            "eglMakeCurrent failed"
        }

        fun drainEncoder(endOfStream: Boolean) {
            val timeoutUs = if (endOfStream) 10_000L else 0L
            while (true) {
                val index = encoder.dequeueOutputBuffer(bufferInfo, timeoutUs)
                when {
                    index == MediaCodec.INFO_TRY_AGAIN_LATER -> if (!endOfStream) return
                    index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        trackIndex = muxer.addTrack(encoder.outputFormat)
                        muxer.start()
                        muxerStarted = true
                    }
                    index >= 0 -> {
                        val encoded = checkNotNull(encoder.getOutputBuffer(index))
                        if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                            bufferInfo.size = 0
                        }
                        if (bufferInfo.size > 0 && muxerStarted) {
                            encoded.position(bufferInfo.offset)
                            encoded.limit(bufferInfo.offset + bufferInfo.size)
                            muxer.writeSampleData(trackIndex, encoded, bufferInfo)
                        }
                        val eos = bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                        encoder.releaseOutputBuffer(index, false)
                        if (eos) return
                    }
                }
            }
        }

        try {
            var ptsNs = 0L
            for (frameIndex in 0 until frameCount) {
                GLES20.glClearColor(1f, 1f, 1f, 1f)
                GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
                EGLExt.eglPresentationTimeANDROID(eglDisplay, eglSurface, ptsNs)
                check(GLES20.glGetError() == GLES20.GL_NO_ERROR) { "GL error before drain" }
                EGL14.eglSwapBuffers(eglDisplay, eglSurface)
                drainEncoder(false)
                ptsNs += 1_000_000_000L / fps
            }
            encoder.signalEndOfInputStream()
            drainEncoder(true)
        } finally {
            EGL14.eglMakeCurrent(
                eglDisplay,
                EGL14.EGL_NO_SURFACE,
                EGL14.EGL_NO_SURFACE,
                EGL14.EGL_NO_CONTEXT,
            )
            EGL14.eglDestroySurface(eglDisplay, eglSurface)
            EGL14.eglDestroyContext(eglDisplay, eglContext)
            EGL14.eglTerminate(eglDisplay)
            encoder.stop()
            encoder.release()
            if (muxerStarted) muxer.stop()
            muxer.release()
        }
        assertTrue("fixture ${target.name} not written", target.exists() && target.length() > 0)
        // Sanity: the fixture itself must be white edge-to-edge, otherwise the
        // export measurement would be measuring the fixture instead.
        assertNoIntroducedBorder(target, "flat white fixture ${target.name}")
        return target
    }
}
