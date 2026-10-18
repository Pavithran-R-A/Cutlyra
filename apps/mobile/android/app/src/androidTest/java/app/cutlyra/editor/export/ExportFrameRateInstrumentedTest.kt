package app.cutlyra.editor.export

import android.content.Context
import android.media.MediaExtractor
import android.media.MediaFormat
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
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * Output frame-timestamp proof for the export frame-rate contract
 * (GitHub #21 / Linear PAV-71): "FPS selection is ignored; MP4 always
 * 30 FPS".
 *
 * The native half of the fix is `EdlToComposition` declaring
 * `EditedMediaItem.setFrameRate(edl.output.fps)` for EVERY visual item —
 * previously only stills got it, so media3 emitted video at the source's
 * own cadence no matter what the sheet said.
 *
 * These tests read the real muxed MP4 with `MediaExtractor` and measure
 * actual sample timestamps (never `KEY_CAPTURE_FRAMERATE`, which most
 * files do not carry, and never the exporter's self-reported metadata).
 * They assert the two halves of media3 1.11.0's asymmetric contract,
 * both verified against its source at tag 1.11.0
 * (`SequenceRenderersFactory.TargetFrameRateHelper`):
 *
 *   1. CAP works: 30 fps source exported at 24 → ~24 fps timestamps
 *      (frames genuinely dropped — this is the direction that was broken).
 *   2. NO DUPLICATION: 30 fps source exported at 60 → stays ~30 fps.
 *      media3 has no frame-duplication primitive ("This algorithm has no
 *      impact if the target frame rate is greater [than] input frame
 *      rate"), so the test locks the honest fallback the export sheet
 *      now discloses BEFORE export, rather than pretending 60 is real.
 *
 * Fixture: M4's instrumentation-APK `res/raw/test_clip.mp4` — 30 fps,
 * 2 s, 320x240, WITH audio (MediaPipelineInstrumentedTest asserts the
 * 30 fps), reused here for both the single-clip and cross-fade shapes.
 * Tolerance is ±12 % on the measured average: media3's drop algorithm
 * keeps the first sample at-or-after each 1/`frameRate` grid point, so
 * intervals jitter between one and two source frames while the AVERAGE
 * tracks the selection precisely.
 */
@RunWith(AndroidJUnit4::class)
class ExportFrameRateInstrumentedTest {
    private lateinit var context: Context
    private lateinit var testContext: Context
    private lateinit var sourceClip: File
    private lateinit var outputFile: File

    private val ticksPerSecond = 120_000L

    /** The fixture's own rate, asserted by MediaPipelineInstrumentedTest. */
    private val sourceFps = 30

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        testContext = InstrumentationRegistry.getInstrumentation().context
        sourceClip = File(context.cacheDir, "fps_source_${System.nanoTime()}.mp4")
        testContext.resources.openRawResource(R.raw.test_clip).use { input ->
            sourceClip.outputStream().use { output -> input.copyTo(output) }
        }
        outputFile = File(context.cacheDir, "fps_export_${System.nanoTime()}.mp4")
    }

    @After
    fun tearDown() {
        sourceClip.delete()
        outputFile.delete()
    }

    private data class VideoSampleStats(val count: Int, val firstUs: Long, val lastUs: Long) {
        /** Average frames per second across the measured span. */
        val averageFps: Double
            get() = if (count > 1 && lastUs > firstUs) {
                (count - 1) * 1_000_000.0 / (lastUs - firstUs)
            } else {
                0.0
            }
    }

    /**
     * Reads the MUXED output file's video-track sample timestamps directly —
     * the ground truth for "what frame rate did the user actually get",
     * independent of how any given tool infers a nominal rate.
     */
    private fun probeVideoSamples(file: File): VideoSampleStats {
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(file.absolutePath)
            var trackIndex = -1
            for (index in 0 until extractor.trackCount) {
                val mime = extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME)
                if (mime?.startsWith("video/") == true) {
                    trackIndex = index
                    break
                }
            }
            require(trackIndex >= 0) { "no video track found in $file" }
            extractor.selectTrack(trackIndex)
            val buffer = ByteBuffer.allocate(1024 * 1024)
            var count = 0
            var firstUs = -1L
            var lastUs = -1L
            while (true) {
                buffer.clear()
                if (extractor.readSampleData(buffer, 0) < 0) break
                val pts = extractor.sampleTime
                if (firstUs < 0) firstUs = pts
                lastUs = pts
                count++
                extractor.advance()
            }
            assertTrue("output video track produced no samples", count > 1)
            return VideoSampleStats(count, firstUs, lastUs)
        } finally {
            extractor.release()
        }
    }

    private fun assertAverageFps(
        label: String,
        expectedFps: Double,
        stats: VideoSampleStats,
        toleranceFraction: Double = 0.12,
    ) {
        val measured = stats.averageFps
        val tolerance = expectedFps * toleranceFraction
        assertTrue(
            "$label: expected ~${expectedFps} fps (±${(toleranceFraction * 100).toInt()} %), " +
                "measured ${"%.2f".format(measured)} fps " +
                "(count=${stats.count}, spanUs=${stats.lastUs - stats.firstUs})",
            abs(measured - expectedFps) <= tolerance,
        )
    }

    private fun identityTransform() = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0)

    private fun videoAsset(durationTicks: Long) = EdlAsset(
        assetId = "asset-1",
        kind = EdlAssetKind.VIDEO,
        name = sourceClip.name,
        sourceUri = sourceClip.toURI().toString(),
        codec = null,
        width = 320,
        height = 240,
        durationTicks = durationTicks,
        rotationDegrees = 0,
        hasAudio = true,
    )

    private fun videoClip(
        clipId: String,
        startTicks: Long,
        durationTicks: Long,
        sourceStartTicks: Long = 0,
    ) = EdlClip(
        clipId = clipId,
        kind = "video",
        assetId = "asset-1",
        name = clipId,
        startTicks = startTicks,
        durationTicks = durationTicks,
        sourceStartTicks = sourceStartTicks,
        sourceEndTicks = sourceStartTicks + durationTicks,
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

    /** One main-track clip of [clipTicks], exported at [fps]. */
    private fun buildSingleClipEdl(fps: EdlRational, clipTicks: Long): Edl {
        val asset = videoAsset(durationTicks = 2 * ticksPerSecond)
        val mainTrack = EdlTrack(
            trackId = "track-main",
            kind = EdlTrackKind.MAIN,
            trackType = EdlTrackType.VIDEO,
            name = "Main",
            zIndex = 0,
            muted = false,
            hidden = false,
            clips = listOf(videoClip("clip-a", startTicks = 0, durationTicks = clipTicks)),
        )
        return Edl(
            meta = EdlMeta(
                edlVersion = 1,
                generator = "cutlyra-frame-rate-test",
                ticksPerSecond = ticksPerSecond,
                frameRate = fps,
                canvasWidth = 320,
                canvasHeight = 240,
                projectId = "proj-fps",
                projectName = "Frame Rate Fixture",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = clipTicks,
            ),
            assets = listOf(asset),
            tracks = listOf(mainTrack),
            transitions = emptyList(),
            overlays = emptyList(),
            output = EdlOutput(
                container = "mp4",
                videoCodec = "avc1",
                audioCodec = "mp4a",
                bitrate = 4_000_000,
                fps = fps,
                resolutionWidth = 320,
                resolutionHeight = 240,
                includeAudio = true,
            ),
        )
    }

    /**
     * Runs a REAL export to completion and returns the muxed file's video
     * sample statistics. Fails loudly (never silently passes) if the export
     * errors or times out — a broken pipeline must not masquerade as a
     * frame-rate result.
     */
    private fun exportAndProbe(edl: Edl): VideoSampleStats {
        outputFile.delete()
        val latch = CountDownLatch(1)
        val events = mutableListOf<Media3Exporter.Event>()
        Media3Exporter.start(context, edl, outputFile) { event ->
            events.add(event)
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                latch.countDown()
            }
        }
        assertTrue(
            "export did not reach a terminal state within 90s: $events",
            latch.await(90, TimeUnit.SECONDS),
        )
        val terminal = events.last()
        assertTrue("export failed: $terminal", terminal is Media3Exporter.Event.Done)
        assertTrue("export produced no output file", outputFile.length() > 0)
        return probeVideoSamples(outputFile)
    }

    /** 1 s of the 30 fps fixture exported at 24 fps: frames MUST be dropped. */
    @Test
    fun exports_24fps_by_dropping_frames_from_the_30fps_source() {
        val oneSecondTicks = ticksPerSecond
        val stats = exportAndProbe(buildSingleClipEdl(EdlRational(24, 1), oneSecondTicks))
        assertAverageFps("24 fps selection", expectedFps = 24.0, stats)
        // The pre-fix behavior was the source cadence untouched: catching a
        // measured ~30 here would mean `setFrameRate` stopped reaching video
        // items again.
        assertTrue(
            "24 fps selection measured ${"%.2f".format(stats.averageFps)} fps — " +
                "expected the 30 fps source to be capped, not passed through",
            stats.averageFps < sourceFps - 2.5,
        )
    }

    /** 1 s at 30 fps: the control case — selection == source, no drop. */
    @Test
    fun exports_30fps_unchanged_from_the_30fps_source() {
        val oneSecondTicks = ticksPerSecond
        val stats = exportAndProbe(buildSingleClipEdl(EdlRational(30, 1), oneSecondTicks))
        assertAverageFps("30 fps selection", expectedFps = 30.0, stats)
    }

    /**
     * 60 selected over 30 fps footage: stays ~30 fps, BY CONTRACT. media3
     * 1.11.0 cannot duplicate frames; the export sheet discloses this before
     * the export runs (PAV-71's "explicit supported fallback (not silent
     * 30 FPS)"). This assertion is the honest-capability lock: if media3
     * someday gains real upsampling, this test is what tells us to update the
     * sheet's disclosure.
     */
    @Test
    fun exports_60fps_selection_with_30fps_source_honestly_stays_30fps() {
        val oneSecondTicks = ticksPerSecond
        val stats = exportAndProbe(buildSingleClipEdl(EdlRational(60, 1), oneSecondTicks))
        assertAverageFps("60 fps selection over 30 fps footage (no duplication)", expectedFps = 30.0, stats)
        assertTrue(
            "60 fps selection over 30 fps footage measured ${"%.2f".format(stats.averageFps)} fps — " +
                "media3 1.11.0 has no frame-duplication primitive; a real 60 here means the " +
                "contract changed and export-frame-rate.ts's disclosure must be revisited",
            stats.averageFps < 45.0,
        )
    }

    /**
     * The cap must survive the multi-input path too: a cross-fade composition
     * renders through `SequenceVideoRenderer` per sequence and (for the
     * window) the custom compositor, and neither may resurrect dropped
     * frames. Two 600 ms clips with a 200 ms cross-fade compress to a 1.0 s
     * output at 24 fps.
     */
    @Test
    fun exports_crossfade_composition_at_24fps() {
        val clipTicks = ticksPerSecond * 6 / 10 // 600 ms
        val transitionTicks = ticksPerSecond / 5 // 200 ms
        val asset = videoAsset(durationTicks = 2 * ticksPerSecond)
        val clipA = videoClip("clip-a", startTicks = 0, durationTicks = clipTicks)
        val clipB = videoClip(
            clipId = "clip-b",
            startTicks = clipTicks,
            durationTicks = clipTicks,
            sourceStartTicks = 0,
        )
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
        val fps = EdlRational(24, 1)
        val edl = Edl(
            meta = EdlMeta(
                edlVersion = 1,
                generator = "cutlyra-frame-rate-test",
                ticksPerSecond = ticksPerSecond,
                frameRate = fps,
                canvasWidth = 320,
                canvasHeight = 240,
                projectId = "proj-fps",
                projectName = "Frame Rate Crossfade Fixture",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = 2 * clipTicks - transitionTicks,
            ),
            assets = listOf(asset),
            tracks = listOf(mainTrack),
            transitions = listOf(
                EdlTransition(
                    transitionId = "t-1",
                    afterClipId = "clip-a",
                    kind = "crossfade",
                    durationTicks = transitionTicks,
                ),
            ),
            overlays = emptyList(),
            output = EdlOutput(
                container = "mp4",
                videoCodec = "avc1",
                audioCodec = "mp4a",
                bitrate = 4_000_000,
                fps = fps,
                resolutionWidth = 320,
                resolutionHeight = 240,
                includeAudio = true,
            ),
        )
        val stats = exportAndProbe(edl)
        assertAverageFps("24 fps selection across a cross-fade", expectedFps = 24.0, stats)
        // Duration sanity: compressed output is 1.0 s, so the sample span must
        // sit near it — also guards the no-black-tail invariant.
        val spanSec = (stats.lastUs - stats.firstUs) / 1_000_000.0
        assertTrue(
            "cross-fade output span ${"%.2f".format(spanSec)}s is not near the expected 1.0s",
            abs(spanSec - 1.0) <= 0.35,
        )
    }
}
