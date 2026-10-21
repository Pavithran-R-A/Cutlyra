package app.cutlyra.editor.export

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLExt
import android.opengl.GLES20
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.OverlaySettings
import androidx.media3.common.util.Size
import androidx.media3.effect.StaticOverlaySettings
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Transformer
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Stage 7 round-4 diagnostic for GitHub #20 / Linear PAV-70.
 *
 * Round 1-3 established:
 *   - raw pipeline, equal small size, no effects      -> CORRECT (f ~ 1)
 *   - same pipeline upscaled to 1920x1080             -> head under-contributes
 *   - real exporter at native size                    -> CORRECT
 *   - real exporter upscaled                          -> head at ~3-7% of correct
 *   - Stage-6 physical export (1920x1080 == source)   -> incoming weight 0.245*a
 *
 * The Stage-6 solve implies the incoming layer covers ~0.24 of the frame AREA
 * (y/(1-x) is constant ~0.24 at every window frame), while the upscale case
 * implies ~0.037 = 320*240 / (1920*1080) — i.e. both look like the head is
 * composited at a SMALLER geometry than the output frame, not dimmed by alpha.
 *
 * This probe measures the head layer's actual SPATIAL footprint (bbox +
 * coverage of blue-dominant pixels) with the base held invisible
 * (baseAlphaScale = 0), across:
 *
 *   Q1 equal 1920x1080, production item-Presentation asymmetry
 *      (base has Presentation, head has none, composition Presentation present)
 *   Q2 Q1 + head given the same Presentation            (fix candidate)
 *   Q3 upscale 320x240 -> 1920x1080, same asymmetry     (P7 shape)
 *   Q4 Q3 + head given the same Presentation            (fix candidate)
 *
 * Then the REAL production pipeline end-to-end (Media3Exporter +
 * EdlToComposition) at both geometries, with the app's real ramp:
 *
 *   R1 Stage-6 exact shape: 1920x1080 fixtures, canvas+output 1920x1080
 *   R2 P7 shape: 320x240 fixtures, output 1920x1080
 *
 * Every measurement is appended to cache/geom_probe_results.txt for host-side
 * pull (survives logcat wraparound); the exports themselves are kept too.
 */
@RunWith(AndroidJUnit4::class)
class ExportCrossfadeGeometryProbeInstrumentedTest {
    private lateinit var context: Context
    private lateinit var redSmall: File
    private lateinit var blueSmall: File
    private lateinit var redBig: File
    private lateinit var blueBig: File
    private lateinit var results: File
    private val outputs = mutableListOf<File>()

    private val smallW = 320
    private val smallH = 240
    private val bigW = 1920
    private val bigH = 1080
    private val fps = 30
    private val totalSec = 4.0
    private val windowStartSec = 3.5
    private val windowEndSec = 4.0

    // Stage-6 fixture colours (identical to pav70.py's red/blue pair).
    private val red = floatArrayOf(221f / 255f, 60f / 255f, 43f / 255f)
    private val blue = floatArrayOf(15f / 255f, 111f / 255f, 211f / 255f)

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        results = File(context.cacheDir, "geom_probe_results.txt")
        // APPEND across test methods — truncating here in round 4 destroyed the
        // Q-matrix lines when the R test's setUp ran.
        results.appendText("\n=== ${javaClass.simpleName} setUp @${System.currentTimeMillis()} ===\n")
        redSmall = File(context.cacheDir, "geom_red_s_${System.nanoTime()}.mp4")
        blueSmall = File(context.cacheDir, "geom_blue_s_${System.nanoTime()}.mp4")
        redBig = File(context.cacheDir, "geom_red_b_${System.nanoTime()}.mp4")
        blueBig = File(context.cacheDir, "geom_blue_b_${System.nanoTime()}.mp4")
        createSolidColorClip(redSmall, smallW, smallH, red)
        createSolidColorClip(blueSmall, smallW, smallH, blue)
        createSolidColorClip(redBig, bigW, bigH, red)
        createSolidColorClip(blueBig, bigW, bigH, blue)
    }

    @After
    fun tearDown() {
        for (f in listOf(redSmall, blueSmall, redBig, blueBig)) f.delete()
        // Exports + results file are KEPT for host-side pull
        // (`run-as app.cutlyra.editor cat cache/geom_probe_results.txt`).
    }

    private fun log(line: String) {
        results.appendText(line + "\n")
        println("XFADE-GEOM $line")
        android.util.Log.i("XFADE-GEOM", line)
    }

    // -- probe compositor settings -------------------------------------------

    private class ProbeSettings(
        private val baseAlphaAtUs: (Long) -> Float,
        private val headAlphaScale: Float,
        private val outputSize: Size,
    ) : androidx.media3.common.VideoCompositorSettings {
        override fun getOutputSize(inputSizes: MutableList<Size>): Size = outputSize

        override fun getOverlaySettings(
            inputIndex: Int,
            presentationTimeUs: Long,
        ): OverlaySettings {
            val alpha =
                if (inputIndex == 0) baseAlphaAtUs(presentationTimeUs) else headAlphaScale
            return StaticOverlaySettings.Builder().setAlphaScale(alpha).build()
        }
    }

    /** The app's exact ramp (base alpha 1 -> 0 across the window). */
    private fun rampAlphaAt(presentationTimeUs: Long): Float {
        val s = us(windowStartSec)
        val e = us(windowEndSec)
        if (presentationTimeUs <= s) return 1f
        if (presentationTimeUs >= e) return 0f
        val a = (presentationTimeUs - s).toDouble() / (e - s).toDouble()
        return (1.0 - a).toFloat()
    }

    private fun us(sec: Double): Long = (sec * 1_000_000L).toLong()

    // -- raw composition driver ----------------------------------------------

    /**
     * Two-sequence composition in the exact shape of the app's transition
     * (base item full length; head item trimmed to the window behind a leading
     * gap), with independent control of base/head item Presentations and the
     * composition-level Presentation.
     */
    private fun exportRaw(
        name: String,
        redSrc: File,
        blueSrc: File,
        srcW: Int,
        srcH: Int,
        outW: Int,
        outH: Int,
        baseAlphaAtUs: (Long) -> Float,
        basePres: Boolean,
        headPres: Boolean,
        compPres: Boolean,
    ): File {
        fun effects(enabled: Boolean): androidx.media3.transformer.Effects =
            if (enabled) {
                androidx.media3.transformer.Effects(
                    emptyList(),
                    listOf(
                        androidx.media3.effect.Presentation.createForWidthAndHeight(
                            outW,
                            outH,
                            androidx.media3.effect.Presentation.LAYOUT_SCALE_TO_FIT,
                        ),
                    ),
                )
            } else {
                androidx.media3.transformer.Effects(emptyList(), emptyList())
            }

        val baseItem = EditedMediaItem.Builder(MediaItem.fromUri(redSrc.toURI().toString()))
            .setRemoveAudio(true)
            .setDurationUs(us(totalSec))
            .setEffects(effects(basePres))
            .build()
        val baseSeq = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_VIDEO))
            .addItem(baseItem)
            .build()

        val headItem = EditedMediaItem.Builder(MediaItem.fromUri(blueSrc.toURI().toString()))
            .setRemoveAudio(true)
            .setDurationUs(us(windowEndSec - windowStartSec))
            .setEffects(effects(headPres))
            .build()
        val headSeq = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_VIDEO))
            .addGap(us(windowStartSec))
            .addItem(headItem)
            .build()

        val settings = ProbeSettings(
            baseAlphaAtUs = baseAlphaAtUs,
            headAlphaScale = 1f,
            outputSize = Size(outW, outH),
        )
        val compositionBuilder = Composition.Builder(listOf(baseSeq, headSeq))
            .setVideoCompositorSettings(settings)
        if (compPres) {
            compositionBuilder.setEffects(
                androidx.media3.transformer.Effects(
                    emptyList(),
                    listOf(
                        androidx.media3.effect.Presentation.createForWidthAndHeight(
                            outW,
                            outH,
                            androidx.media3.effect.Presentation.LAYOUT_SCALE_TO_FIT,
                        ),
                    ),
                ),
            )
        }
        return runTransformer(name, compositionBuilder.build())
    }

    private fun runTransformer(name: String, composition: Composition): File {
        val out = File(context.cacheDir, "geom_$name-${System.nanoTime()}.mp4")
        outputs += out
        val latch = CountDownLatch(1)
        var terminal: String? = null
        val transformer = Transformer.Builder(context)
            .addListener(object : Transformer.Listener {
                override fun onCompleted(
                    finishedComposition: Composition,
                    exportResult: androidx.media3.transformer.ExportResult,
                ) {
                    terminal = "done"
                    latch.countDown()
                }

                override fun onError(
                    finishedComposition: Composition,
                    exportResult: androidx.media3.transformer.ExportResult,
                    exportException: androidx.media3.transformer.ExportException,
                ) {
                    terminal = "error: ${exportException.message}"
                    latch.countDown()
                }
            })
            .build()
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().runOnMainSync {
            transformer.start(composition, out.absolutePath)
        }
        assertTrue(
            "probe $name export did not terminate within 180s",
            latch.await(180, TimeUnit.SECONDS),
        )
        assertTrue("probe $name export failed: $terminal", terminal == "done")
        assertTrue("probe $name output missing", out.exists() && out.length() > 0)
        return out
    }

    // -- measurement ----------------------------------------------------------

    private data class FrameStats(
        val meanR: Double,
        val meanG: Double,
        val meanB: Double,
        val blueCover: Double,
        val bbox: IntArray?, // left, top, right, bottom of blue-dominant pixels
        val w: Int,
        val h: Int,
        val noFrame: String? = null,
    )

    private fun stats(file: File, timeSec: Double): FrameStats {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
            val frame = retriever.getFrameAtTime(
                (timeSec * 1_000_000).toLong(),
                MediaMetadataRetriever.OPTION_CLOSEST,
            )
            if (frame == null) {
                // Diagnostic data, not a soft pass: log exactly what is missing
                // (file duration) so an undecodable/short export is visible in
                // the results file instead of aborting the remaining probes.
                return FrameStats(
                    meanR = Double.NaN,
                    meanG = Double.NaN,
                    meanB = Double.NaN,
                    blueCover = Double.NaN,
                    bbox = null,
                    w = -1,
                    h = -1,
                    noFrame = "durationMs=${durationMs ?: "?"}",
                )
            }
            val bmp = frame.copy(Bitmap.Config.ARGB_8888, false)!!
            val n = bmp.width * bmp.height
            val px = IntArray(n)
            bmp.getPixels(px, 0, bmp.width, 0, 0, bmp.width, bmp.height)
            var r = 0.0
            var g = 0.0
            var b = 0.0
            var blueCount = 0
            var l = Int.MAX_VALUE
            var t = Int.MAX_VALUE
            var rr = -1
            var bb = -1
            for (i in px) {
                val rv = (i shr 16) and 0xFF
                val gv = (i shr 8) and 0xFF
                val bv = i and 0xFF
                r += rv
                g += gv
                b += bv
            }
            // Second pass for geometry (kept separate so the mean loop stays
            // trivial); blue-dominant = clearly more blue than red and not
            // near-black, which is unambiguous for this red/blue fixture pair.
            for (y in 0 until bmp.height) {
                val row = y * bmp.width
                for (x in 0 until bmp.width) {
                    val i = px[row + x]
                    val rv = (i shr 16) and 0xFF
                    val bv = i and 0xFF
                    if (bv > rv + 25 && bv > 40) {
                        blueCount++
                        if (x < l) l = x
                        if (x > rr) rr = x
                        if (y < t) t = y
                        if (y > bb) bb = y
                    }
                }
            }
            val outW = bmp.width
            val outH = bmp.height
            bmp.recycle()
            frame.recycle()
            return FrameStats(
                meanR = r / n,
                meanG = g / n,
                meanB = b / n,
                blueCover = blueCount.toDouble() / n,
                bbox = if (blueCount > 0) intArrayOf(l, t, rr, bb) else null,
                w = outW,
                h = outH,
            )
        } finally {
            retriever.release()
        }
    }

    /**
     * Layer solve (same as round 1-3): frame = x*red + y*blue over black.
     * With the base held invisible (alpha 0) y IS the head's effective
     * contribution; with the real ramp a = 1 - x and y/a is the head weight.
     */
    private fun report(tag: String, file: File, times: List<Double>, ramp: Boolean) {
        val det = 221.0 * 211.0 - 15.0 * 43.0
        for (t in times) {
            val s = stats(file, t)
            if (s.noFrame != null) {
                log("%s t=%.3f NOFRAME (%s)".format(tag, t, s.noFrame))
                continue
            }
            val x = (s.meanR * 211.0 - s.meanB * 15.0) / det
            val y = (221.0 * s.meanB - 43.0 * s.meanR) / det
            val a = if (ramp) 1.0 - x else Double.NaN
            val bbox = s.bbox?.joinToString(",") ?: "none"
            log(
                "%s t=%.3f %dx%d mean R%.1f G%.1f B%.1f x=%.3f y=%.3f blueCover=%.4f bbox=%s%s"
                    .format(
                        tag, t, s.w, s.h, s.meanR, s.meanG, s.meanB, x, y,
                        s.blueCover, bbox,
                        if (ramp && 1.0 - x > 0.1) " y/a=%.3f".format(y / (1.0 - x)) else "",
                    ),
            )
        }
    }

    // -- Q probes: head spatial footprint with the base invisible -------------

    @Test
    fun probe_head_geometry_matrix() {
        // Q1: Stage-6 equal geometry, production Presentation asymmetry.
        val q1 = exportRaw(
            name = "q1-equal-basepres-only",
            redSrc = redBig, blueSrc = blueBig, srcW = bigW, srcH = bigH,
            outW = bigW, outH = bigH,
            baseAlphaAtUs = { 0f },
            basePres = true, headPres = false, compPres = true,
        )
        report("Q1 equal/basePres-only/base-alpha0", q1, listOf(3.6, 3.9, 3.97), ramp = false)

        // Q2: fix candidate — head normalized to output size too.
        val q2 = exportRaw(
            name = "q2-equal-bothpres",
            redSrc = redBig, blueSrc = blueBig, srcW = bigW, srcH = bigH,
            outW = bigW, outH = bigH,
            baseAlphaAtUs = { 0f },
            basePres = true, headPres = true, compPres = true,
        )
        report("Q2 equal/bothPres/base-alpha0", q2, listOf(3.6, 3.9, 3.97), ramp = false)

        // Q3: upscale (P7 shape), production asymmetry.
        val q3 = exportRaw(
            name = "q3-upscale-basepres-only",
            redSrc = redSmall, blueSrc = blueSmall, srcW = smallW, srcH = smallH,
            outW = bigW, outH = bigH,
            baseAlphaAtUs = { 0f },
            basePres = true, headPres = false, compPres = true,
        )
        report("Q3 upscale/basePres-only/base-alpha0", q3, listOf(3.6, 3.9, 3.97), ramp = false)

        // Q4: fix candidate at the upscale geometry.
        val q4 = exportRaw(
            name = "q4-upscale-bothpres",
            redSrc = redSmall, blueSrc = blueSmall, srcW = smallW, srcH = smallH,
            outW = bigW, outH = bigH,
            baseAlphaAtUs = { 0f },
            basePres = true, headPres = true, compPres = true,
        )
        report("Q4 upscale/bothPres/base-alpha0", q4, listOf(3.6, 3.9, 3.97), ramp = false)

        // Q5: control — the round-1 known-good configuration (no Presentations,
        // equal small size) with the SAME measurement, to validate the harness.
        val q5 = exportRaw(
            name = "q5-control-nopres",
            redSrc = redSmall, blueSrc = blueSmall, srcW = smallW, srcH = smallH,
            outW = smallW, outH = smallH,
            baseAlphaAtUs = { 0f },
            basePres = false, headPres = false, compPres = false,
        )
        report("Q5 control/nopres/base-alpha0", q5, listOf(3.6, 3.9, 3.97), ramp = false)

        log("q-exports: ${outputs.joinToString(" ") { it.absolutePath }}")
    }

    // -- R probes: the REAL production pipeline (EdlToComposition) ------------

    private fun stage6Edl(
        redSrc: File,
        blueSrc: File,
        srcW: Int,
        srcH: Int,
        outW: Int,
        outH: Int,
    ): app.cutlyra.editor.edl.Edl {
        val oneSec = 120_000L
        fun asset(id: String, src: File) = app.cutlyra.editor.edl.EdlAsset(
            assetId = id,
            kind = app.cutlyra.editor.edl.EdlAssetKind.VIDEO,
            name = src.name,
            sourceUri = src.toURI().toString(),
            codec = null,
            width = srcW,
            height = srcH,
            durationTicks = (totalSec * oneSec).toLong(),
            rotationDegrees = 0,
            hasAudio = false,
        )
        val assetRed = asset("asset-red", redSrc)
        val assetBlue = asset("asset-blue", blueSrc)

        fun clip(id: String, assetId: String, startTicks: Long, durationTicks: Long) =
            app.cutlyra.editor.edl.EdlClip(
                clipId = id,
                kind = "video",
                assetId = assetId,
                name = id,
                startTicks = startTicks,
                durationTicks = durationTicks,
                sourceStartTicks = 0,
                sourceEndTicks = durationTicks,
                speed = app.cutlyra.editor.edl.EdlRational(1, 1),
                maintainPitch = false,
                volumeDb = 0.0,
                muted = false,
                hidden = false,
                transform = app.cutlyra.editor.edl.EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0),
                opacity = 1.0,
                effects = emptyList(),
                hasMasks = false,
                animations = emptyList(),
                params = emptyMap(),
            )

        // Stage-6 shape: red [0, 1 s], blue [1 s, 2 s], 0.5 s cross-fade at the
        // junction -> window [0.5 s, 1.0 s].
        val mainTrack = app.cutlyra.editor.edl.EdlTrack(
            trackId = "track-main",
            kind = app.cutlyra.editor.edl.EdlTrackKind.MAIN,
            trackType = app.cutlyra.editor.edl.EdlTrackType.VIDEO,
            name = "Main",
            zIndex = 0,
            muted = false,
            hidden = false,
            clips = listOf(
                clip("clip-a", "asset-red", 0, oneSec),
                clip("clip-b", "asset-blue", oneSec, oneSec),
            ),
        )

        return app.cutlyra.editor.edl.Edl(
            meta = app.cutlyra.editor.edl.EdlMeta(
                edlVersion = 1,
                generator = "cutlyra-geom-probe",
                ticksPerSecond = 120_000L,
                frameRate = app.cutlyra.editor.edl.EdlRational(30, 1),
                canvasWidth = srcW,
                canvasHeight = srcH,
                projectId = "proj-geom-probe",
                projectName = "geom probe",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = 2 * oneSec,
            ),
            assets = listOf(assetRed, assetBlue),
            tracks = listOf(mainTrack),
            transitions = listOf(
                app.cutlyra.editor.edl.EdlTransition(
                    transitionId = "t-1",
                    afterClipId = "clip-a",
                    kind = "cross_fade",
                    durationTicks = oneSec / 2,
                ),
            ),
            overlays = emptyList(),
            output = app.cutlyra.editor.edl.EdlOutput(
                container = "mp4",
                videoCodec = "avc1",
                audioCodec = "mp4a",
                bitrate = 8_000_000,
                fps = app.cutlyra.editor.edl.EdlRational(30, 1),
                resolutionWidth = outW,
                resolutionHeight = outH,
                includeAudio = false,
            ),
        )
    }

    private fun exportWithRealExporter(name: String, edl: app.cutlyra.editor.edl.Edl): File {
        val out = File(context.cacheDir, "geom_$name-${System.nanoTime()}.mp4")
        outputs += out
        val latch = CountDownLatch(1)
        var terminal: String? = null
        Media3Exporter.start(context, edl, out) { event ->
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                terminal = if (event is Media3Exporter.Event.Done) "done" else "error: $event"
                latch.countDown()
            }
        }
        assertTrue("$name did not terminate within 180s", latch.await(180, TimeUnit.SECONDS))
        assertTrue("$name failed: $terminal", terminal == "done")
        assertTrue("$name output missing", out.exists() && out.length() > 0)
        return out
    }

    @Test
    fun probe_real_exporter_stage6_geometry() {
        // R1: Stage-6's EXACT geometry through the real exporter — 1920x1080
        // fixtures, canvas 1920x1080, output 1920x1080 (the physical defect's
        // shape, without the UI).
        val r1 = exportWithRealExporter(
            "r1-real-equal-1080",
            stage6Edl(redBig, blueBig, bigW, bigH, bigW, bigH),
        )
        report(
            "R1 real/equal1080/ramp",
            r1,
            listOf(0.2, 0.55, 0.7, 0.85, 0.95, 1.5),
            ramp = true,
        )
        // REGRESSION GATE (GitHub #20 / PAV-70): late in the window the
        // incoming layer must cover (essentially) the whole picture. Equal
        // geometry: full frame. Pre-fix Stage-6 measured 0.2500 here for the
        // proxy-sized head; anything below 0.9 is the defect.
        val r1Late = stats(r1, 0.95)
        assertTrue(
            "R1 incoming coverage ${r1Late.blueCover} at t=0.95 — expected full frame " +
                "(incoming layer not filling the picture; GitHub #20)",
            r1Late.blueCover >= 0.90,
        )

        // R2: P7 shape — same production pipeline, upscaled output.
        val r2 = exportWithRealExporter(
            "r2-real-upscale-1080",
            stage6Edl(redSmall, blueSmall, smallW, smallH, bigW, bigH),
        )
        report(
            "R2 real/upscale/ramp",
            r2,
            listOf(0.2, 0.55, 0.7, 0.85, 0.95, 1.5),
            ramp = true,
        )
        // REGRESSION GATE (GitHub #20 / PAV-70, the Stage-6 failure geometry):
        // the incoming head must be normalized to the export frame like every
        // other visual item. With the fix its footprint equals the base's own
        // SCALE_TO_FIT picture area (a 4:3 source in a 16:9 frame ⇒ 0.75);
        // pre-fix it was the head's NATIVE texture — 320x240 centred,
        // coverage 0.037 (round-4 Q3 / round-3 P7). Gate at 0.70 to accept
        // legitimate letterboxing while hard-rejecting the defect.
        val r2Late = stats(r2, 0.95)
        assertTrue(
            "R2 incoming coverage ${r2Late.blueCover} at t=0.95 — expected ≥0.70 (head not " +
                "normalized to the export frame; native-texture compositing = GitHub #20)",
            r2Late.blueCover >= 0.70,
        )
        assertTrue(
            "R2 incoming bbox ${r2Late.bbox?.joinToString()} — expected the base's " +
                "picture region, not a small centred native-texture rectangle",
            r2Late.bbox != null && (r2Late.bbox[2] - r2Late.bbox[0] + 1) >= 1400,
        )

        log("r-exports: ${outputs.joinToString(" ") { it.absolutePath }}")
    }

    // -- solid-color clip generator ------------------------------------------
    // Same approach as ExportCrossfadeLuminanceInstrumentedTest: an AVC
    // surface encoder fed by an EGL window surface cleared to the colour.

    private fun createSolidColorClip(target: File, w: Int, h: Int, rgb: FloatArray) {
        val frameCount = (totalSec * fps).toInt() + fps / 2

        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h)
            .apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
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
        val configs = arrayOfNulls<EGLConfig>(1)
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
                GLES20.glClearColor(rgb[0], rgb[1], rgb[2], 1f)
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
    }
}
