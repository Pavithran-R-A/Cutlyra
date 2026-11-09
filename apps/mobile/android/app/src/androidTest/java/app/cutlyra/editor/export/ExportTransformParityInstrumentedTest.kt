package app.cutlyra.editor.export

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.opengl.EGL14
import android.opengl.EGLConfig
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
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.max

/**
 * Real export parity for mobile rotate/mirror (#50). Exports MP4s through the
 * actual Media3/EDL pipeline, decodes frames, and asserts pixel geometry of an
 * asymmetric marker fixture. This is the proof gate for EdlTransformEffect's
 * unverified GL/Media3 conventions.
 *
 * Marker source (decoded bitmap, top-left origin): TL quadrant RED with a CYAN
 * origin block at (0,0); TR GREEN; BL BLUE; BR YELLOW. Corner sampling (inset
 * past the cyan block) proves which source corner landed where after transform.
 * Positive rotateDegrees = clockwise in editor/preview (Canvas2D convention).
 */
@RunWith(AndroidJUnit4::class)
class ExportTransformParityInstrumentedTest {
    private lateinit var context: Context
    private val ticksPerSecond = 120_000L
    private val srcW = 320
    private val srcH = 240
    private val marker = 48
    private val tempFiles = mutableListOf<File>()

    private val RED = 0xFFFF0000.toInt()
    private val GREEN = 0xFF00FF00.toInt()
    private val BLUE = 0xFF0000FF.toInt()
    private val YELLOW = 0xFFFFFF00.toInt()
    private val CYAN = 0xFF00FFFF.toInt()

    @Before fun setUp() { context = ApplicationProvider.getApplicationContext() }
    @After fun tearDown() { tempFiles.forEach { it.delete() } }

    private fun tmp(name: String, ext: String = "mp4"): File =
        File(context.cacheDir, "xf_${name}_${System.nanoTime()}.$ext").also { tempFiles += it }

    private data class Corners(val tl: Int, val tr: Int, val bl: Int, val br: Int)

    private fun near(a: Int, b: Int, tol: Int = 80): Boolean {
        fun ch(p: Int, s: Int) = (p shr s) and 0xFF
        return max(max(abs(ch(a, 16) - ch(b, 16)), abs(ch(a, 8) - ch(b, 8))), abs(ch(a, 0) - ch(b, 0))) <= tol
    }

    private fun sampleCorners(file: File, atUs: Long = 200_000L, inset: Int = 18): Corners {
        val r = MediaMetadataRetriever()
        try {
            r.setDataSource(file.absolutePath)
            val frame = r.getFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                ?: error("no frame at ${atUs}us for ${file.name}")
            val bmp = frame.copy(Bitmap.Config.ARGB_8888, false) ?: error("bitmap copy failed")
            val x1 = inset.coerceIn(0, bmp.width - 1)
            val x2 = (bmp.width - 1 - inset).coerceIn(0, bmp.width - 1)
            val y1 = inset.coerceIn(0, bmp.height - 1)
            val y2 = (bmp.height - 1 - inset).coerceIn(0, bmp.height - 1)
            val c = Corners(bmp.getPixel(x1, y1), bmp.getPixel(x2, y1), bmp.getPixel(x1, y2), bmp.getPixel(x2, y2))
            bmp.recycle(); frame.recycle()
            return c
        } finally { r.release() }
    }

    private fun hex(i: Int) = String.format("#%08X", i)

    private fun assertCorners(label: String, actual: Corners, tl: Int, tr: Int, bl: Int, br: Int) {
        val ok = near(actual.tl, tl) && near(actual.tr, tr) && near(actual.bl, bl) && near(actual.br, br)
        assertTrue(
            "$label corners mismatch\n expected tl=${hex(tl)} tr=${hex(tr)} bl=${hex(bl)} br=${hex(br)}" +
                "\n actual   tl=${hex(actual.tl)} tr=${hex(actual.tr)} bl=${hex(actual.bl)} br=${hex(actual.br)}",
            ok,
        )
    }

    /** Asymmetric marker in GL coords (y-up). Decoded bitmap is top-left origin. */
    private fun drawMarkerFrame(w: Int, h: Int) {
        fun q(x: Int, y: Int, qw: Int, qh: Int, argb: Int) {
            GLES20.glScissor(x, y, qw, qh)
            GLES20.glClearColor(((argb shr 16) and 0xFF) / 255f, ((argb shr 8) and 0xFF) / 255f, (argb and 0xFF) / 255f, 1f)
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
        }
        GLES20.glEnable(GLES20.GL_SCISSOR_TEST)
        val hw = w / 2; val hh = h / 2
        q(0, hh, hw, h - hh, RED)
        q(hw, hh, w - hw, h - hh, GREEN)
        q(0, 0, hw, hh, BLUE)
        q(hw, 0, w - hw, hh, YELLOW)
        q(0, h - marker, marker, marker, CYAN)
        GLES20.glDisable(GLES20.GL_SCISSOR_TEST)
    }

    private fun createMarkerVideo(target: File, w: Int = srcW, h: Int = srcH, seconds: Double = 0.8, fps: Int = 30): File {
        val frameCount = (seconds * fps).toInt().coerceAtLeast(12)
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, 4_000_000)
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
        }
        val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val inputSurface = encoder.createInputSurface()
        encoder.start()
        val muxer = MediaMuxer(target.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        var muxerStarted = false; var trackIndex = -1
        val bufferInfo = MediaCodec.BufferInfo()
        val eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        check(EGL14.eglInitialize(eglDisplay, null, 0, null, 0)) { "eglInitialize failed" }
        val configAttribs = intArrayOf(
            EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT, 0x3142, 1, EGL14.EGL_NONE,
        )
        val configs = arrayOfNulls<EGLConfig>(1); val numConfigs = IntArray(1)
        check(EGL14.eglChooseConfig(eglDisplay, configAttribs, 0, configs, 0, 1, numConfigs, 0)) { "eglChooseConfig failed" }
        val config = checkNotNull(configs[0])
        val eglContext = EGL14.eglCreateContext(eglDisplay, config, EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
        val eglSurface = EGL14.eglCreateWindowSurface(eglDisplay, config, inputSurface, intArrayOf(EGL14.EGL_NONE), 0)
        check(EGL14.eglMakeCurrent(eglDisplay, eglSurface, eglSurface, eglContext)) { "eglMakeCurrent failed" }
        fun drain(endOfStream: Boolean) {
            val timeoutUs = if (endOfStream) 10_000L else 0L
            while (true) {
                val index = encoder.dequeueOutputBuffer(bufferInfo, timeoutUs)
                when {
                    index == MediaCodec.INFO_TRY_AGAIN_LATER -> if (!endOfStream) return
                    index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> { trackIndex = muxer.addTrack(encoder.outputFormat); muxer.start(); muxerStarted = true }
                    index >= 0 -> {
                        val encoded = checkNotNull(encoder.getOutputBuffer(index))
                        if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) bufferInfo.size = 0
                        if (bufferInfo.size > 0 && muxerStarted) {
                            encoded.position(bufferInfo.offset); encoded.limit(bufferInfo.offset + bufferInfo.size)
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
            for (i in 0 until frameCount) {
                drawMarkerFrame(w, h)
                EGLExt.eglPresentationTimeANDROID(eglDisplay, eglSurface, ptsNs)
                EGL14.eglSwapBuffers(eglDisplay, eglSurface)
                drain(false)
                ptsNs += 1_000_000_000L / fps
            }
            encoder.signalEndOfInputStream(); drain(true)
        } finally {
            EGL14.eglMakeCurrent(eglDisplay, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
            EGL14.eglDestroySurface(eglDisplay, eglSurface); EGL14.eglDestroyContext(eglDisplay, eglContext); EGL14.eglTerminate(eglDisplay)
            encoder.stop(); encoder.release(); if (muxerStarted) muxer.stop(); muxer.release(); inputSurface.release()
        }
        assertTrue("marker video not written", target.exists() && target.length() > 0)
        return target
    }

    private fun createMarkerImage(target: File, w: Int = srcW, h: Int = srcH): File {
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp); val p = Paint(Paint.ANTI_ALIAS_FLAG)
        fun rect(l: Int, t: Int, r: Int, b: Int, c: Int) { p.color = c; canvas.drawRect(l.toFloat(), t.toFloat(), r.toFloat(), b.toFloat(), p) }
        val hw = w / 2; val hh = h / 2
        rect(0, 0, hw, hh, Color.RED); rect(hw, 0, w, hh, Color.GREEN)
        rect(0, hh, hw, h, Color.BLUE); rect(hw, hh, w, h, Color.YELLOW)
        rect(0, 0, marker, marker, Color.CYAN)
        target.outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bmp.recycle()
        assertTrue("marker image not written", target.exists() && target.length() > 0)
        return target
    }

    private fun export(edl: Edl, name: String): File {
        val out = tmp(name)
        val latch = CountDownLatch(1)
        val events = mutableListOf<Media3Exporter.Event>()
        Media3Exporter.start(context, edl, out) { event ->
            events.add(event)
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) latch.countDown()
        }
        assertTrue("export '$name' timeout: $events", latch.await(150, TimeUnit.SECONDS))
        val terminal = events.lastOrNull()
        assertTrue("export '$name' failed: $terminal", terminal is Media3Exporter.Event.Done)
        assertTrue("export '$name' empty", out.exists() && out.length() > 0)
        return out
    }

    private fun edlFor(
        source: File, kind: EdlAssetKind, assetW: Int, assetH: Int, assetRotation: Int,
        canvasW: Int, canvasH: Int, framing: String, transform: EdlTransform, hasAudio: Boolean,
    ): Edl {
        val clipTicks = ticksPerSecond / 2
        val assetTicks = if (kind == EdlAssetKind.IMAGE) clipTicks else ticksPerSecond
        val asset = EdlAsset("asset-1", kind, source.name, source.toURI().toString(), null, assetW, assetH, assetTicks, assetRotation, hasAudio)
        val clip = EdlClip(
            clipId = "clip-a", kind = kind.name.lowercase(), assetId = "asset-1", name = "a",
            startTicks = 0, durationTicks = clipTicks, sourceStartTicks = 0, sourceEndTicks = clipTicks,
            speed = EdlRational(1, 1), maintainPitch = false, volumeDb = 0.0, muted = !hasAudio, hidden = false,
            transform = transform, opacity = 1.0, framing = framing, effects = emptyList(), hasMasks = false,
            animations = emptyList(), params = mapOf("framing" to framing),
        )
        val track = EdlTrack("track-main", EdlTrackKind.MAIN, EdlTrackType.VIDEO, "Main", 0, false, false, listOf(clip))
        return Edl(
            meta = EdlMeta(1, "cutlyra-transform-parity", ticksPerSecond, EdlRational(30, 1), canvasW, canvasH, "proj-xf", "Transform", "s1", "S1", clipTicks),
            assets = listOf(asset), tracks = listOf(track), transitions = emptyList(), overlays = emptyList(),
            output = EdlOutput("mp4", "avc1", "mp4a", 4_000_000, EdlRational(30, 1), canvasW, canvasH, hasAudio),
        )
    }

    private fun t(r: Double = 0.0, sx: Double = 1.0, sy: Double = 1.0) = EdlTransform(0.0, 0.0, sx, sy, r)

    @Test fun identity_preservesMarkerCorners() {
        val src = createMarkerVideo(tmp("src_id"))
        val out = export(edlFor(src, EdlAssetKind.VIDEO, srcW, srcH, 0, srcW, srcH, "fill", t(), true), "id")
        assertCorners("identity", sampleCorners(out, inset = marker + 8), RED, GREEN, BLUE, YELLOW)
    }

    @Test fun rotate90Clockwise_mapsCorners() {
        val src = createMarkerVideo(tmp("src_r90"))
        val out = export(edlFor(src, EdlAssetKind.VIDEO, srcW, srcH, 0, srcW, srcH, "fill", t(r = 90.0), true), "r90")
        assertCorners("rotate+90cw", sampleCorners(out, inset = marker + 8), BLUE, RED, YELLOW, GREEN)
    }

    @Test fun rotateMinus90_mapsCorners() {
        val src = createMarkerVideo(tmp("src_rm90"))
        val out = export(edlFor(src, EdlAssetKind.VIDEO, srcW, srcH, 0, srcW, srcH, "fill", t(r = -90.0), true), "rm90")
        assertCorners("rotate-90", sampleCorners(out, inset = marker + 8), GREEN, YELLOW, RED, BLUE)
    }

    @Test fun rotate180_mapsCorners() {
        val src = createMarkerVideo(tmp("src_r180"))
        val out = export(edlFor(src, EdlAssetKind.VIDEO, srcW, srcH, 0, srcW, srcH, "fill", t(r = 180.0), true), "r180")
        assertCorners("rotate180", sampleCorners(out, inset = marker + 8), YELLOW, BLUE, GREEN, RED)
    }

    @Test fun flipHorizontal_mapsCorners() {
        val src = createMarkerVideo(tmp("src_fh"))
        val out = export(edlFor(src, EdlAssetKind.VIDEO, srcW, srcH, 0, srcW, srcH, "fill", t(sx = -1.0), true), "fh")
        assertCorners("flipH", sampleCorners(out, inset = marker + 8), GREEN, RED, YELLOW, BLUE)
    }

    @Test fun flipVertical_mapsCorners() {
        val src = createMarkerVideo(tmp("src_fv"))
        val out = export(edlFor(src, EdlAssetKind.VIDEO, srcW, srcH, 0, srcW, srcH, "fill", t(sy = -1.0), true), "fv")
        assertCorners("flipV", sampleCorners(out, inset = marker + 8), BLUE, YELLOW, RED, GREEN)
    }

    @Test fun rotate90_plusHorizontalFlip_mapsCorners() {
        val src = createMarkerVideo(tmp("src_r90fh"))
        val out = export(edlFor(src, EdlAssetKind.VIDEO, srcW, srcH, 0, srcW, srcH, "fill", t(sx = -1.0, r = 90.0), true), "r90fh")
        assertCorners("rotate90+flipH", sampleCorners(out, inset = marker + 8), YELLOW, GREEN, BLUE, RED)
    }

    @Test fun rotate90_plusVerticalFlip_mapsCorners() {
        val src = createMarkerVideo(tmp("src_r90fv"))
        val out = export(edlFor(src, EdlAssetKind.VIDEO, srcW, srcH, 0, srcW, srcH, "fill", t(sy = -1.0, r = 90.0), true), "r90fv")
        assertCorners("rotate90+flipV", sampleCorners(out, inset = marker + 8), RED, BLUE, GREEN, YELLOW)
    }

    @Test fun fitMismatchedCanvas_preservesPictureWithBars() {
        val src = createMarkerVideo(tmp("src_fit"))
        val out = export(edlFor(src, EdlAssetKind.VIDEO, srcW, srcH, 0, 1080, 1920, "fit", t(r = 90.0), true), "fit90")
        val mr = MediaMetadataRetriever()
        try {
            mr.setDataSource(out.absolutePath)
            val frame = mr.getFrameAtTime(200_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC) ?: error("no frame")
            val bmp = frame.copy(Bitmap.Config.ARGB_8888, false) ?: error("no bmp")
            fun lum(p: Int) = max(max((p shr 16) and 0xFF, (p shr 8) and 0xFF), p and 0xFF)
            val mid = bmp.getPixel(bmp.width / 2, bmp.height / 2)
            assertTrue("fit+90 center should contain picture: ${hex(mid)}", lum(mid) >= 35)
            val w = mr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toInt() ?: 0
            val h = mr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toInt() ?: 0
            assertTrue("portrait 9:16 output, got ${w}x${h}", w in 1070..1090 && h in 1910..1930)
            bmp.recycle(); frame.recycle()
        } finally { mr.release() }
    }

    @Test fun fillMismatchedCanvas_coversCanvas() {
        val src = createMarkerVideo(tmp("src_fill"))
        val out = export(edlFor(src, EdlAssetKind.VIDEO, srcW, srcH, 0, 1080, 1920, "fill", t(r = 90.0), true), "fill90")
        val mr = MediaMetadataRetriever()
        try {
            mr.setDataSource(out.absolutePath)
            val frame = mr.getFrameAtTime(200_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC) ?: error("no frame")
            val bmp = frame.copy(Bitmap.Config.ARGB_8888, false) ?: error("no bmp")
            fun lum(p: Int) = max(max((p shr 16) and 0xFF, (p shr 8) and 0xFF), p and 0xFF)
            val corners = listOf(bmp.getPixel(24, 24), bmp.getPixel(bmp.width - 25, 24), bmp.getPixel(24, bmp.height - 25), bmp.getPixel(bmp.width - 25, bmp.height - 25))
            val bright = corners.count { lum(it) >= 35 }
            assertTrue("fill+90 should cover canvas (bright corners=$bright): ${corners.map(::hex)}", bright >= 3)
            bmp.recycle(); frame.recycle()
        } finally { mr.release() }
    }

    @Test fun sourceRotationMetadata_identityTransform_exportsWithoutCrash() {
        val src = createMarkerVideo(tmp("src_meta"))
        val out = export(edlFor(src, EdlAssetKind.VIDEO, srcW, srcH, 90, srcW, srcH, "fill", t(), true), "meta90")
        val mr = MediaMetadataRetriever()
        try {
            mr.setDataSource(out.absolutePath)
            val w = mr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toInt() ?: 0
            val h = mr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toInt() ?: 0
            assertTrue("metadata export has valid dimensions: ${w}x${h}", w > 0 && h > 0)
        } finally { mr.release() }
    }

    @Test fun imageClip_rotate90_exportsTransformedImage() {
        val src = createMarkerImage(tmp("src_img", "png"))
        val out = export(edlFor(src, EdlAssetKind.IMAGE, srcW, srcH, 0, srcW, srcH, "fill", t(r = 90.0), false), "img90")
        assertCorners("image rotate+90cw", sampleCorners(out, inset = marker + 8), BLUE, RED, YELLOW, GREEN)
    }
}
