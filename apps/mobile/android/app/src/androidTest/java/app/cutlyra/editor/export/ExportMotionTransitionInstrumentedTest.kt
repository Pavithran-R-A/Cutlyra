package app.cutlyra.editor.export

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.cutlyra.editor.edl.Edl
import app.cutlyra.editor.edl.EdlAnimationChannel
import app.cutlyra.editor.edl.EdlAsset
import app.cutlyra.editor.edl.EdlAssetKind
import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlKeyframe
import app.cutlyra.editor.edl.EdlMeta
import app.cutlyra.editor.edl.EdlOutput
import app.cutlyra.editor.edl.EdlRational
import app.cutlyra.editor.edl.EdlTrack
import app.cutlyra.editor.edl.EdlTrackKind
import app.cutlyra.editor.edl.EdlTrackType
import app.cutlyra.editor.edl.EdlTransform
import app.cutlyra.editor.edl.EdlTransition
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * Phase 3 pixel gate: the advanced transitions must render in the EXPORTED MP4,
 * not only in project state or the preview.
 *
 * Fixture: two runtime-generated FLAT solid-colour clips (red then blue) and
 * one transition of 500 ms, so the compressed output is 1.5 s and the window
 * is [0.5 s, 1.0 s). A flat fixture makes the assertions unambiguous:
 *
 *  - slide/push: the incoming (blue) head is painted ABOVE the base and
 *    revealed by motion, so the frame must be two FLAT regions whose boundary
 *    follows `W·(1-p)` for direction `left` (`W·p` for `right`). An alpha
 *    blend, a hard cut, or a head painted below the base all fail: a blend is
 *    purple rather than pure blue, a hard cut has no interior boundary, and a
 *    below-painted head would be invisible under an opaque base.
 *  - zoom: the incoming clip arrives scaled (1.25 -> 1) with the base's alpha
 *    ramping 1 -> 0, so the frame must MIX the two baselines by the window
 *    progress (sampled from the same export outside the window).
 *
 * Every frame is decoded from the produced file with MediaMetadataRetriever —
 * the same "decoded pixels, not unit math" contract the cross-fade and
 * chroma-key gates use. Slide vs push are pixel-identical for full-frame
 * opaque clips (the incoming layer covers the outgoing one either way); the
 * outgoing motion that distinguishes them is asserted structurally in
 * `TransitionAlphaMathTest` / the TS channel tests.
 */
@RunWith(AndroidJUnit4::class)
class ExportMotionTransitionInstrumentedTest {
    private lateinit var context: Context
    private lateinit var redClip: File
    private lateinit var blueClip: File

    private val ticksPerSecond = 120_000L
    private val oneSecondTicks = ticksPerSecond
    private val transitionTicks = ticksPerSecond / 2
    private val windowStartSec = 0.5
    private val windowEndSec = 1.0

    private val red = Triple(210, 30, 30)
    private val blue = Triple(30, 40, 210)

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        redClip = File(context.cacheDir, "motion_red_${System.nanoTime()}.mp4")
        blueClip = File(context.cacheDir, "motion_blue_${System.nanoTime()}.mp4")
        ColorBlockVideoFactory.create(redClip, background = red, block = red, width = 320, height = 240)
        ColorBlockVideoFactory.create(blueClip, background = blue, block = blue, width = 320, height = 240)
    }

    @After
    fun tearDown() {
        redClip.delete()
        blueClip.delete()
    }

    // -- fixture --------------------------------------------------------------

    private fun identityTransform() = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0)

    private fun asset(assetId: String, source: File, name: String) = EdlAsset(
        assetId = assetId,
        kind = EdlAssetKind.VIDEO,
        name = source.name,
        sourceUri = source.toURI().toString(),
        codec = null,
        width = 320,
        height = 240,
        durationTicks = oneSecondTicks + oneSecondTicks / 2,
        rotationDegrees = 0,
        hasAudio = false,
    )

    private fun clip(
        clipId: String,
        assetId: String,
        startTicks: Long,
        animations: List<EdlAnimationChannel> = emptyList(),
    ) = EdlClip(
        clipId = clipId,
        kind = "video",
        assetId = assetId,
        name = clipId,
        startTicks = startTicks,
        durationTicks = oneSecondTicks,
        sourceStartTicks = 0,
        sourceEndTicks = oneSecondTicks,
        speed = EdlRational(1, 1),
        maintainPitch = false,
        volumeDb = 0.0,
        muted = false,
        hidden = false,
        transform = identityTransform(),
        opacity = 1.0,
        effects = emptyList(),
        hasMasks = false,
        animations = animations,
        params = emptyMap(),
    )

    /** One linear ramp, exactly what `buildAnimations` emits for a scalar channel. */
    private fun ramp(path: String, from: Double, to: Double, startTicks: Long = 0): EdlAnimationChannel =
        EdlAnimationChannel(
            propertyPath = path,
            componentKey = null,
            extrapolationBefore = "hold",
            extrapolationAfter = "hold",
            keyframes = listOf(
                EdlKeyframe("kf-$path-0", startTicks, from, "linear", null, null),
                EdlKeyframe("kf-$path-1", startTicks + transitionTicks, to, "hold", null, null),
            ),
        )

    private fun incomingChannels(
        kind: String,
        direction: String,
        canvasWidth: Int,
        canvasHeight: Int,
    ): List<EdlAnimationChannel> =
        when (kind) {
            // `direction` is the way the incoming clip TRAVELS. Entering from
            // the right means travelling left, i.e. kicked off at +W.
            "slide", "push" -> when (direction) {
                "left" -> listOf(
                    ramp("transform.positionX", canvasWidth.toDouble(), 0.0),
                    ramp("transform.positionY", 0.0, 0.0),
                )
                "right" -> listOf(
                    ramp("transform.positionX", -canvasWidth.toDouble(), 0.0),
                    ramp("transform.positionY", 0.0, 0.0),
                )
                "up" -> listOf(
                    ramp("transform.positionX", 0.0, 0.0),
                    ramp("transform.positionY", canvasHeight.toDouble(), 0.0),
                )
                "down" -> listOf(
                    ramp("transform.positionX", 0.0, 0.0),
                    ramp("transform.positionY", -canvasHeight.toDouble(), 0.0),
                )
                else -> error("unknown direction $direction")
            }
            "zoom" -> listOf(
                ramp("transform.scaleX", 1.25, 1.0),
                ramp("transform.scaleY", 1.25, 1.0),
            )
            else -> emptyList()
        }

    private fun buildEdl(
        kind: String,
        direction: String = "left",
        blueSource: File = blueClip,
    ): Edl {
        val assetA = asset("asset-a", redClip, "red")
        val assetB = asset("asset-b", blueSource, "blue")
        // push: the outgoing clip leaves the frame as the head arrives. The
        // transition sits at the END of the clip, so its channels are anchored
        // at the clip-local window start (what the TS producer emits).
        val windowOffsetTicks = oneSecondTicks - transitionTicks
        val outgoingAnimations =
            if (kind == "push") {
                val kick = when (direction) {
                    "right" -> 320.0
                    "up" -> 0.0
                    else -> -320.0
                }
                val kickY = when (direction) {
                    "up" -> -240.0
                    "down" -> 240.0
                    else -> 0.0
                }
                listOf(
                    ramp("transform.positionX", 0.0, kick, windowOffsetTicks),
                    ramp("transform.positionY", 0.0, kickY, windowOffsetTicks),
                )
            } else {
                emptyList()
            }
        val clipA = clip("clip-a", assetA.assetId, startTicks = 0, animations = outgoingAnimations)
        val clipB = clip("clip-b", assetB.assetId, startTicks = oneSecondTicks)
        val mainTrack = EdlTrack(
            trackId = "track-main",
            kind = EdlTrackKind.MAIN,
            trackType = EdlTrackType.VIDEO,
            name = "Main",
            zIndex = 0,
            muted = false,
            hidden = false,
            clips = listOf(clipA, clipB),
        )
        return Edl(
            meta = EdlMeta(
                edlVersion = 1,
                generator = "cutlyra-motion-transition-test",
                ticksPerSecond = ticksPerSecond,
                frameRate = EdlRational(30, 1),
                canvasWidth = 320,
                canvasHeight = 240,
                projectId = "proj-motion",
                projectName = "Motion Fixture",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = 2 * oneSecondTicks,
            ),
            assets = listOf(assetA, assetB),
            tracks = listOf(mainTrack),
            transitions = listOf(
                EdlTransition(
                    transitionId = "tr-1",
                    afterClipId = "clip-a",
                    kind = kind,
                    durationTicks = transitionTicks,
                    direction = direction,
                    incomingAnimations = incomingChannels(kind, direction, 320, 240),
                ),
            ),
            overlays = emptyList(),
            output = EdlOutput(
                container = "mp4",
                videoCodec = "avc1",
                audioCodec = "mp4a",
                bitrate = 4_000_000,
                fps = EdlRational(30, 1),
                resolutionWidth = 320,
                resolutionHeight = 240,
                includeAudio = false,
            ),
        )
    }

    // -- export / decode helpers ---------------------------------------------

    private fun exportOrFail(edl: Edl, destination: File, label: String) {
        destination.delete()
        val latch = CountDownLatch(1)
        val events = mutableListOf<Media3Exporter.Event>()
        Media3Exporter.start(context, edl, destination) { event ->
            events.add(event)
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                latch.countDown()
            }
        }
        assertTrue("$label export did not terminate within 120s", latch.await(120, TimeUnit.SECONDS))
        val terminal = events.lastOrNull()
        assertTrue("$label export failed: $terminal", terminal is Media3Exporter.Event.Done)
        assertTrue("$label output missing", destination.exists() && destination.length() > 0)
    }

    private fun frameAt(file: File, timeSec: Double): Bitmap {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            val frame = retriever.getFrameAtTime(
                (timeSec * 1_000_000).toLong(),
                MediaMetadataRetriever.OPTION_CLOSEST,
            )
            assertTrue("no frame decodable at ${timeSec}s in ${file.name}", frame != null)
            return frame!!.copy(Bitmap.Config.ARGB_8888, false)!!
        } finally {
            retriever.release()
        }
    }

    private fun durationSec(file: File): Double {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            val millis = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
            return millis / 1000.0
        } finally {
            retriever.release()
        }
    }

    /** Average colour of one 3x3 patch, in 0..255 RGB. */
    private fun patch(frame: Bitmap, x: Int, y: Int): Triple<Double, Double, Double> {
        var r = 0.0
        var g = 0.0
        var b = 0.0
        var n = 0
        for (dy in -1..1) {
            for (dx in -1..1) {
                val px = (x + dx).coerceIn(0, frame.width - 1)
                val py = (y + dy).coerceIn(0, frame.height - 1)
                val pixel = frame.getPixel(px, py)
                r += (pixel shr 16) and 0xFF
                g += (pixel shr 8) and 0xFF
                b += pixel and 0xFF
                n++
            }
        }
        return Triple(r / n, g / n, b / n)
    }

    private fun meanLuma(frame: Bitmap): Double {
        var sum = 0.0
        var n = 0
        for (y in 0 until frame.height step 8) {
            for (x in 0 until frame.width step 8) {
                val pixel = frame.getPixel(x, y)
                val r = (pixel shr 16) and 0xFF
                val g = (pixel shr 8) and 0xFF
                val b = pixel and 0xFF
                sum += 0.2126 * r + 0.7152 * g + 0.0722 * b
                n++
            }
        }
        return sum / n
    }

    /** Fraction of frame ROWS (mid column) that are blue-dominant. */
    private fun blueRowCoverage(frame: Bitmap): Double {
        val x = frame.width / 2
        var blue = 0
        for (y in 0 until frame.height) {
            val (r, _, b) = patch(frame, x, y)
            if (b - r > 80.0) blue++
        }
        return blue.toDouble() / frame.height
    }

    /** Largest neighbour luma jump along the middle row (edge sharpness). */
    private fun maxEdgeContrast(frame: Bitmap): Double {
        val y = frame.height / 2
        var max = 0.0
        var previous = patch(frame, 0, y)
        for (x in 1 until frame.width) {
            val current = patch(frame, x, y)
            fun luma(c: Triple<Double, Double, Double>) =
                0.2126 * c.first + 0.7152 * c.second + 0.0722 * c.third
            max = maxOf(max, abs(luma(current) - luma(previous)))
            previous = current
        }
        return max
    }

    /** Fraction of frame columns (mid row) that are blue-dominant. */
    private fun blueCoverage(frame: Bitmap): Double {
        val y = frame.height / 2
        var blue = 0
        for (x in 0 until frame.width) {
            val (r, _, b) = patch(frame, x, y)
            if (b - r > 80.0) blue++
        }
        return blue.toDouble() / frame.width
    }

    // -- tests ----------------------------------------------------------------

    /**
     * slide/push: the head is registered ABOVE the base and is FLAT (not
     * blended); its boundary follows the window progress. Direction sets which
     * side it enters from.
     */
    private fun assertTravel(kind: String, directionLabel: String, enterFromRight: Boolean, output: File) {
        val direction = if (enterFromRight) "left" else "right"
        exportOrFail(buildEdl(kind, direction), output, "$kind/$directionLabel")
        assertTrue(
            "$kind export must be compressed to ~1.5s, was ${durationSec(output)}s",
            abs(durationSec(output) - 1.5) < 0.3,
        )
        // Baselines outside the window.
        val before = patch(frameAt(output, 0.35), 160, 120)
        val after = patch(frameAt(output, 1.15), 160, 120)
        assertTrue("$kind: pre-window frame must be the red clip, got $before", before.first - before.third > 80)
        assertTrue("$kind: post-window frame must be the blue clip, got $after", after.third - after.first > 80)

        // 0.92 is the last sample comfortably before the window's final frame:
        // media3 composites ONE frame at a sequence item's last boundary from
        // the base only (same one-frame item-boundary artifact the cross-fade
        // gate documents) — every frame before it is correct, and the frame
        // after the window is the incoming clip at 100%.
        val samples = listOf(0.6, 0.75, 0.92)
        val report = StringBuilder()
        val coverages = ArrayList<Double>()
        for (t in samples) {
            val frame = frameAt(output, t)
            val p = ((t - windowStartSec) / (windowEndSec - windowStartSec)).coerceIn(0.0, 1.0)
            val coverage = blueCoverage(frame)
            coverages.add(coverage)
            report.append("t=%.2f p=%.2f coverage=%.2f; ".format(t, p, coverage))
            assertTrue(
                "$kind: frame at ${t}s must not be black (head did not render): luma=${meanLuma(frame)}",
                meanLuma(frame) > 25.0,
            )
            // The head covers exactly the window progress, anchored on the side
            // it travels from. A cut would show 0 or 1 coverage; an alpha blend
            // would not be FLAT and would not advance linearly.
            assertTrue(
                "$kind/$directionLabel: at ${t}s the incoming clip must cover ~${Math.round(p * 100)}% of the frame, was " +
                    "${Math.round(coverage * 100)}% (window $windowStartSec..$windowEndSec). per-sample: $report",
                abs(coverage - p) <= 0.20,
            )
            val anchoredX = if (enterFromRight) frame.width - 24 else 24
            val anchored = patch(frame, anchoredX, 120)
            assertTrue(
                "$kind/$directionLabel: at ${t}s the incoming clip must be anchored on the " +
                    "${if (enterFromRight) "right" else "left"} (direction), got $anchored. $report",
                anchored.third - anchored.first > 80.0,
            )
            // Layer order: covered columns are PURE incoming colour, i.e. the
            // head is painted ABOVE the opaque base rather than blended into it.
            val middleX = if (enterFromRight) {
                (frame.width * (1 - p) + frame.width).toInt() / 2
            } else {
                (frame.width * p).toInt() / 2
            }
            val covered = patch(frame, middleX, 60)
            assertTrue(
                "$kind/$directionLabel: covered region at ${t}s must be flat incoming blue (head above base), got $covered. $report",
                covered.third - covered.first > 80.0,
            )
        }
        for (i in 1 until coverages.size) {
            assertTrue(
                "$kind/$directionLabel: the incoming clip must keep advancing across the window, coverage stalled at $coverages. $report",
                coverages[i] > coverages[i - 1] + 0.05,
            )
        }
    }

    @Test
    fun slide_left_renders_a_moving_boundary_from_the_right() {
        assertTravel("slide", "left", enterFromRight = true, output = File(context.cacheDir, "slide_left_${System.nanoTime()}.mp4"))
    }

    @Test
    fun slide_right_renders_a_moving_boundary_from_the_left() {
        assertTravel("slide", "right", enterFromRight = false, output = File(context.cacheDir, "slide_right_${System.nanoTime()}.mp4"))
    }

    @Test
    fun push_renders_the_same_motion_with_the_outgoing_layer_leaving() {
        assertTravel("push", "left", enterFromRight = true, output = File(context.cacheDir, "push_left_${System.nanoTime()}.mp4"))
    }

    // -- wipe / dip / blur ----------------------------------------------------

    @Test
    fun wipe_left_reveals_the_incoming_clip_from_the_right() {
        assertTravel(
            "wipe",
            "left",
            enterFromRight = true,
            output = File(context.cacheDir, "wipe_left_${System.nanoTime()}.mp4"),
        )
    }

    @Test
    fun wipe_up_reveals_the_incoming_clip_from_the_bottom() {
        val output = File(context.cacheDir, "wipe_up_${System.nanoTime()}.mp4")
        exportOrFail(buildEdl("wipe", "up"), output, "wipe/up")
        assertTrue(
            "wipe export must be compressed to ~1.5s, was ${durationSec(output)}s",
            abs(durationSec(output) - 1.5) < 0.3,
        )
        val before = patch(frameAt(output, 0.35), 160, 120)
        val after = patch(frameAt(output, 1.15), 160, 120)
        assertTrue("wipe/up: pre-window frame must be red, got $before", before.first - before.third > 80)
        assertTrue("wipe/up: post-window frame must be blue, got $after", after.third - after.first > 80)

        var previous = 0.0
        for (t in listOf(0.6, 0.75, 0.92)) {
            val frame = frameAt(output, t)
            val p = ((t - windowStartSec) / (windowEndSec - windowStartSec)).coerceIn(0.0, 1.0)
            val coverage = blueRowCoverage(frame)
            val anchored = patch(frame, 160, frame.height - 12)
            val top = patch(frame, 160, 12)
            assertTrue(
                "wipe/up at ${t}s must cover ~${Math.round(p * 100)}% of rows, was ${Math.round(coverage * 100)}%",
                abs(coverage - p) <= 0.20,
            )
            assertTrue(
                "wipe/up at ${t}s must reveal from the BOTTOM: bottom=$anchored top=$top",
                anchored.third - anchored.first > 80.0 && top.first - top.third > 80.0,
            )
            assertTrue("wipe/up must advance across the window: $coverage after $previous", coverage > previous)
            previous = coverage
        }
    }

    @Test
    fun dip_black_passes_through_black_at_the_midpoint() {
        val output = File(context.cacheDir, "dip_black_${System.nanoTime()}.mp4")
        exportOrFail(buildEdl("dip-black"), output, "dip-black")
        assertTrue(
            "dip-black export must be compressed to ~1.5s, was ${durationSec(output)}s",
            abs(durationSec(output) - 1.5) < 0.3,
        )
        val before = patch(frameAt(output, 0.35), 160, 120)
        val after = patch(frameAt(output, 1.15), 160, 120)
        assertTrue("dip-black: pre-window must be red, got $before", before.first - before.third > 80)
        assertTrue("dip-black: post-window must be blue, got $after", after.third - after.first > 80)

        // The window is 0.5..1.0, so the MIDPOINT is 0.75.
        val mid = frameAt(output, 0.75)
        assertTrue(
            "dip-black must be black at the midpoint (0.75s), luma=${meanLuma(mid)}",
            meanLuma(mid) < 25.0,
        )
        val rising = meanLuma(frameAt(output, 0.9))
        val early = meanLuma(frameAt(output, 0.6))
        assertTrue(
            "dip-black must brighten after the midpoint: 0.6s=$early 0.9s=$rising",
            rising > early + 10.0,
        )
    }

    @Test
    fun dip_white_passes_through_white_at_the_midpoint() {
        val output = File(context.cacheDir, "dip_white_${System.nanoTime()}.mp4")
        exportOrFail(buildEdl("dip-white"), output, "dip-white")
        val mid = frameAt(output, 0.75)
        assertTrue(
            "dip-white must be white at the midpoint (0.75s), luma=${meanLuma(mid)}",
            meanLuma(mid) > 225.0,
        )
        val before = patch(frameAt(output, 0.35), 160, 120)
        val after = patch(frameAt(output, 1.15), 160, 120)
        assertTrue("dip-white: pre-window must be red, got $before", before.first - before.third > 80)
        assertTrue("dip-white: post-window must be blue, got $after", after.third - after.first > 80)
    }

    /**
     * Blur is a DIFFERENTIAL gate: a flat fixture cannot show softness, so the
     * incoming clip carries a white block on blue and the same fixture is
     * exported twice. Inside the window the blur export must have visibly less
     * edge contrast than the plain fade; after the window both are sharp.
     */
    @Test
    fun blur_softens_the_incoming_clip_inside_the_window() {
        val blockBlue = File(context.cacheDir, "blur_blue_${System.nanoTime()}.mp4")
        ColorBlockVideoFactory.create(
            blockBlue,
            background = blue,
            block = Triple(245, 245, 245),
            width = 320,
            height = 240,
        )
        try {
            val blurOutput = File(context.cacheDir, "blur_${System.nanoTime()}.mp4")
            val fadeOutput = File(context.cacheDir, "blur_fade_ref_${System.nanoTime()}.mp4")
            exportOrFail(buildEdl("blur", blueSource = blockBlue), blurOutput, "blur")
            exportOrFail(buildEdl("fade", blueSource = blockBlue), fadeOutput, "fade-reference")

            // 0.7s is p=0.4: the head is 40% visible over the base and still
            // carries ~60% of the peak blur — the most legible comparison
            // point on a 320x240 canvas.
            val blurred = maxEdgeContrast(frameAt(blurOutput, 0.7))
            val sharpReference = maxEdgeContrast(frameAt(fadeOutput, 0.7))
            assertTrue(
                "blur must soften the incoming clip mid-window: blur=$blurred fade=$sharpReference",
                blurred < sharpReference * 0.8,
            )
            val resolved = maxEdgeContrast(frameAt(blurOutput, 1.15))
            assertTrue(
                "after the window the clip must be sharp again: $resolved (mid-window $blurred)",
                resolved > blurred * 1.3,
            )
        } finally {
            blockBlue.delete()
        }
    }

    @Test
    fun zoom_blends_between_the_two_clips_by_window_progress() {
        val output = File(context.cacheDir, "zoom_${System.nanoTime()}.mp4")
        exportOrFail(buildEdl("zoom"), output, "zoom")
        assertTrue(
            "zoom export must be compressed to ~1.5s, was ${durationSec(output)}s",
            abs(durationSec(output) - 1.5) < 0.3,
        )
        val baseA = patch(frameAt(output, 0.35), 160, 120)
        val baseB = patch(frameAt(output, 1.15), 160, 120)
        assertTrue("zoom fixture baselines are not red/blue", baseB.third - baseA.third > 80.0)

        data class Sample(val t: Double, val p: Double, val blue: Double, val expected: Double, val dev: Double)
        val samples = ArrayList<Sample>()
        for (t in listOf(0.6, 0.75, 0.92)) {
            val p = ((t - windowStartSec) / (windowEndSec - windowStartSec)).coerceIn(0.0, 1.0)
            val measured = patch(frameAt(output, t), 160, 120)
            val expectedBlue = (1.0 - p) * baseA.third + p * baseB.third
            samples.add(Sample(t, p, measured.third, expectedBlue, abs(measured.third - expectedBlue)))
            assertTrue(
                "zoom frame at ${t}s must mix both clips (base alpha ramp + scaled head), got $measured",
                measured.third > baseA.third + 8.0 && measured.third < baseB.third - 8.0,
            )
        }
        for (i in 1 until samples.size) {
            assertTrue(
                "zoom must move monotonically toward the incoming clip: $samples",
                samples[i].blue > samples[i - 1].blue,
            )
        }
        assertTrue(
            "zoom mid-window should be ~50/50; got $samples",
            samples.all { it.dev < 45.0 },
        )
    }
}
