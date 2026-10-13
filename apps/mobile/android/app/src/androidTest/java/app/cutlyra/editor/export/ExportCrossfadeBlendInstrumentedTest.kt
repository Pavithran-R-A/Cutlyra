package app.cutlyra.editor.export

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
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
import app.cutlyra.editor.test.R
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Stage 18 physical-release-qualification regression (POCO 2026-10-12):
 * a cross-fade transition that PERSISTS in project state and RENDERS in the
 * preview was exported as a HARD CUT — no blended frame anywhere in the
 * output. The existing golden-frame test only asserts structural shape
 * (sequence count, decodable non-black frames), which a completely invisible
 * transition overlay passes; this test asserts the actual PIXELS.
 *
 * Method: export the SAME two-clip EDL twice — once with the transition,
 * once as the hard-cut control — then, at several timestamps inside the
 * transition window, fit the exported frame as a linear mix of the two
 * source clips as shown by the control export:
 *
 *   A(t)  = control frame at t            (what the base shows)
 *   C(t)  = control frame at t + d        (what the incoming clip shows;
 *                                          the base cuts at clipEnd, so the
 *                                          incoming clip's content at t is
 *                                          the control's content d later)
 *   F(t)  = faded export's frame at t
 *   F(t) ?= alpha*A(t) + (1-alpha)*C(t)
 *
 * A real cross-fade yields alpha in (0.2, 0.8) with a small residual for at
 * least one interior timestamp; a hard cut yields alpha ~ 1 (F identical to
 * A) for every interior timestamp and fails the test.
 *
 * Uses the producer's ACTUAL kind string ("cross_fade", as emitted by
 * `buildTransitions`), not the "crossfade" spelling only the old fixture
 * used, so a kind-mapping regression is caught here too.
 */
@RunWith(AndroidJUnit4::class)
class ExportCrossfadeBlendInstrumentedTest {
    private lateinit var context: Context
    private lateinit var testContext: Context
    private lateinit var sourceClip: File
    private lateinit var fadeOutput: File
    private lateinit var cutOutput: File

    private val ticksPerSecond = 120_000L
    private val oneSecondTicks = ticksPerSecond
    /** 500ms — the app's default transition duration. Window = [0.5s, 1.0s]. */
    private val transitionTicks = ticksPerSecond / 2
    private val transitionSec = transitionTicks.toDouble() / ticksPerSecond

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        testContext = InstrumentationRegistry.getInstrumentation().context
        sourceClip = File(context.cacheDir, "blend_source_${System.nanoTime()}.mp4")
        testContext.resources.openRawResource(R.raw.test_clip).use { input ->
            sourceClip.outputStream().use { output -> input.copyTo(output) }
        }
        fadeOutput = File(context.cacheDir, "blend_fade_${System.nanoTime()}.mp4")
        cutOutput = File(context.cacheDir, "blend_cut_${System.nanoTime()}.mp4")
    }

    @After
    fun tearDown() {
        sourceClip.delete()
        fadeOutput.delete()
        cutOutput.delete()
    }

    private fun identityTransform() = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0)

    private fun buildFixtureEdl(withTransition: Boolean): Edl {
        val asset = EdlAsset(
            assetId = "asset-1",
            kind = EdlAssetKind.VIDEO,
            name = sourceClip.name,
            sourceUri = sourceClip.toURI().toString(),
            codec = null,
            width = 320,
            height = 240,
            durationTicks = 2 * oneSecondTicks,
            rotationDegrees = 0,
            hasAudio = true,
        )

        fun baseClip(id: String, startTicks: Long, sourceStart: Long): EdlClip = EdlClip(
            clipId = id,
            kind = "video",
            assetId = asset.assetId,
            name = id,
            startTicks = startTicks,
            durationTicks = oneSecondTicks,
            sourceStartTicks = sourceStart,
            sourceEndTicks = sourceStart + oneSecondTicks,
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

        // clip-b shows the SECOND second of the source so the two sides of the
        // junction have clearly different content to blend between.
        val clipA = baseClip("clip-a", startTicks = 0, sourceStart = 0)
        val clipB = baseClip("clip-b", startTicks = oneSecondTicks, sourceStart = oneSecondTicks)

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
                generator = "cutlyra-blend-regression",
                ticksPerSecond = ticksPerSecond,
                frameRate = EdlRational(30, 1),
                canvasWidth = 320,
                canvasHeight = 240,
                projectId = "proj-blend",
                projectName = "Blend Fixture",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = 2 * oneSecondTicks,
            ),
            assets = listOf(asset),
            tracks = listOf(mainTrack),
            transitions = if (withTransition) {
                listOf(
                    EdlTransition(
                        transitionId = "t-1",
                        afterClipId = "clip-a",
                        kind = "cross_fade",
                        durationTicks = transitionTicks,
                    ),
                )
            } else {
                emptyList()
            },
            overlays = emptyList(),
            output = EdlOutput(
                container = "mp4",
                videoCodec = "avc1",
                audioCodec = "mp4a",
                bitrate = 4_000_000,
                fps = EdlRational(30, 1),
                resolutionWidth = 320,
                resolutionHeight = 240,
                includeAudio = true,
            ),
        )
    }

    private fun exportOrFail(edl: Edl, destination: File, label: String) {
        val latch = CountDownLatch(1)
        val events = mutableListOf<Media3Exporter.Event>()
        Media3Exporter.start(context, edl, destination) { event ->
            events.add(event)
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                latch.countDown()
            }
        }
        assertTrue("$label export did not terminate within 90s", latch.await(90, TimeUnit.SECONDS))
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

    /** Linear least-squares fit F ~= alpha*A + (1-alpha)*C over RGB. */
    private fun fitMix(f: Bitmap, a: Bitmap, c: Bitmap): Pair<Double, Double> {
        val n = f.width * f.height
        val fp = IntArray(n)
        val ap = IntArray(n)
        val cp = IntArray(n)
        f.getPixels(fp, 0, f.width, 0, 0, f.width, f.height)
        a.getPixels(ap, 0, a.width, 0, 0, a.width, a.height)
        c.getPixels(cp, 0, c.width, 0, 0, c.width, c.height)
        var num = 0.0
        var den = 0.0
        for (i in 0 until n) {
            for (shift in intArrayOf(16, 8, 0)) {
                val fv = ((fp[i] shr shift) and 0xFF).toDouble()
                val av = ((ap[i] shr shift) and 0xFF).toDouble()
                val cv = ((cp[i] shr shift) and 0xFF).toDouble()
                num += (fv - cv) * (av - cv)
                den += (av - cv) * (av - cv)
            }
        }
        if (den <= 0.0) return Pair(Double.NaN, Double.NaN)
        val alpha = num / den
        var residual = 0.0
        for (i in 0 until n) {
            for (shift in intArrayOf(16, 8, 0)) {
                val fv = ((fp[i] shr shift) and 0xFF).toDouble()
                val av = ((ap[i] shr shift) and 0xFF).toDouble()
                val cv = ((cp[i] shr shift) and 0xFF).toDouble()
                val predicted = alpha * av + (1 - alpha) * cv
                residual += kotlin.math.abs(fv - predicted)
            }
        }
        residual /= (n * 3)
        return Pair(alpha, residual)
    }

    private fun meanAbsDiff(a: Bitmap, b: Bitmap): Double {
        val n = a.width * a.height
        val ap = IntArray(n)
        val bp = IntArray(n)
        a.getPixels(ap, 0, a.width, 0, 0, a.width, a.height)
        b.getPixels(bp, 0, b.width, 0, 0, b.width, b.height)
        var sum = 0.0
        for (i in 0 until n) {
            for (shift in intArrayOf(16, 8, 0)) {
                sum += kotlin.math.abs(((ap[i] shr shift) and 0xFF) - ((bp[i] shr shift) and 0xFF))
            }
        }
        return sum / (n * 3)
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

    /**
     * THE regression: at least one frame inside the transition window must be
     * a genuine linear mix of both clips. A hard-cut export (the Stage 18
     * POCO finding) fails this with alpha ~ 1 at every interior timestamp.
     */
    @Test
    fun exported_crossfade_blends_pixels_across_the_transition_window() {
        exportOrFail(buildFixtureEdl(withTransition = false), cutOutput, "control (hard cut)")
        exportOrFail(buildFixtureEdl(withTransition = true), fadeOutput, "cross-fade")

        // Sanity: the two sides of the junction must actually differ,
        // otherwise the mix fit is meaningless.
        val aRef = frameAt(cutOutput, 0.3)
        val cRef = frameAt(cutOutput, 1.3)
        val baseSeparation = meanAbsDiff(aRef, cRef)
        assertTrue(
            "fixture too static to distinguish clips (mean abs diff=$baseSeparation); " +
                "the blend assertion would be vacuous",
            baseSeparation >= 4.0,
        )

        // The faded export must run on the COMPRESSED timeline like the
        // preview: total = clipA + clipB - overlap = 1.5s (the control stays
        // nominal at 2.0s).
        assertTrue(
            "cross-fade export must be compressed to ~1.5s, was ${durationSec(fadeOutput)}s",
            Math.abs(durationSec(fadeOutput) - 1.5) < 0.3,
        )

        // Outside the window the faded export must match the control,
        // aligned on each one's own clock: before the junction both are
        // nominal; after it the faded output runs `transitionSec` AHEAD of
        // the nominal control (the incoming clip was pulled earlier).
        val beforeDiff = meanAbsDiff(frameAt(fadeOutput, 0.3), frameAt(cutOutput, 0.3))
        assertTrue(
            "faded export diverges from control BEFORE the window (diff=$beforeDiff)",
            beforeDiff <= 4.0,
        )
        val afterDiff = meanAbsDiff(frameAt(fadeOutput, 1.3), frameAt(cutOutput, 1.3 + transitionSec))
        assertTrue(
            "faded export diverges from the compressed control AFTER the window " +
                "(diff=$afterDiff)",
            afterDiff <= 4.0,
        )

        // Inside the window [0.5, 1.0]: fit F(t) against A(t)=control(t) and
        // C(t)=control(t+0.5) (the incoming clip's content at output time t,
        // given the control's hard cut at 1.0s).
        val sampleTimes = listOf(0.6, 0.7, 0.8, 0.9)
        val report = StringBuilder()
        var blendsFound = 0
        for (t in sampleTimes) {
            val f = frameAt(fadeOutput, t)
            val a = frameAt(cutOutput, t)
            val c = frameAt(cutOutput, t + transitionSec)
            val separation = meanAbsDiff(a, c)
            val (alpha, residual) = fitMix(f, a, c)
            report.append(
                "t=%.2f sep=%.2f alpha=%.3f residual=%.2f; ".format(t, separation, alpha, residual),
            )
            if (separation >= 4.0 &&
                alpha > 0.2 && alpha < 0.8 &&
                residual < 0.4 * separation
            ) {
                blendsFound++
            }
        }
        assertTrue(
            "exported cross-fade contains no blended frame in the transition window " +
                "[$transitionSec..1.0s] — the transition was rendered as a hard cut. " +
                "per-sample fit: $report",
            blendsFound >= 1,
        )
    }

    /**
     * Companion shape check: the composition for the fading EDL must contain
     * the transition overlay sequence (base + overlay + audio lane). A
     * missing overlay here means the transition never reached the renderer.
     */
    @Test
    fun fading_edl_builds_a_transition_overlay_sequence() {
        val composition = EdlToComposition.buildComposition(buildFixtureEdl(withTransition = true))
        assertTrue(
            "expected base + cross-fade overlay (+ optional audio) sequences, " +
                "got ${composition.sequences.size}",
            composition.sequences.size >= 2,
        )
        val cut = EdlToComposition.buildComposition(buildFixtureEdl(withTransition = false))
        assertTrue(
            "control must have fewer sequences than the fading build " +
                "(cut=${cut.sequences.size}, fade=${composition.sequences.size})",
            composition.sequences.size > cut.sequences.size,
        )
    }
}
