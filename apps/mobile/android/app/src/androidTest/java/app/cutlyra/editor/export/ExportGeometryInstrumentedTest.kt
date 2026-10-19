package app.cutlyra.editor.export

import android.content.Context
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
import app.cutlyra.editor.media.MediaProbe
import app.cutlyra.editor.test.R
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Output-geometry proof for GitHub #19 / Linear PAV-69 (Stage-4 D-NEW-1):
 * "1080p export is encoded as 1920×1088 instead of requested 1920×1080".
 *
 * ROOT CAUSE (verified in media3 1.11.0 source): with encoder fallback
 * enabled, `DefaultEncoderFactory` routes every request through
 * `EncoderUtil.getSupportedResolution`, which rounds the requested size UP
 * to the encoder's advertised VideoCapabilities alignment before
 * configuring the codec. The POCO's `c2.mtk.avc.encoder` advertises
 * 16-pixel height alignment, so a requested 1080 was CONFIGURED and MUXED
 * as 1088 (SAR 1:1 → DAR 30:17). The fix (`Media3Exporter`) disables that
 * fallback so the encoder is configured at the exact requested size.
 *
 * These tests assert, on real muxed files, the geometry the user selected:
 *
 *   - landscape 1920×1080 — the exact D-NEW-1 repro class (red pre-fix on
 *     alignment-bumping devices);
 *   - landscape 1280×720 — control: already 16-aligned, must stay exact;
 *   - portrait 1080×1920 — asserted in DISPLAY terms (rotation-aware), so
 *     either encoder-rotation (1920×1080 + 90°) or direct portrait coding
 *     passes while any padding shape (1088 anywhere) fails;
 *   - a cross-fade composition at 1920×1080 — the multi-input compositor
 *     path must not reintroduce padding.
 *
 * "Display size" = probed width/height with a 90/270° rotation swapped,
 * matching what ffprobe/players present (mp4 display matrix). Fixture:
 * M4's instrumentation-APK `res/raw/test_clip.mp4` (320×240, 2 s), scaled
 * up by the composition's Presentation pass; clips are 500 ms to keep the
 * emulator suite quick — geometry does not depend on duration.
 */
@RunWith(AndroidJUnit4::class)
class ExportGeometryInstrumentedTest {
    private lateinit var context: Context
    private lateinit var testContext: Context
    private lateinit var sourceClip: File
    private lateinit var outputFile: File

    private val ticksPerSecond = 120_000L

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        testContext = InstrumentationRegistry.getInstrumentation().context
        sourceClip = File(context.cacheDir, "geom_source_${System.nanoTime()}.mp4")
        testContext.resources.openRawResource(R.raw.test_clip).use { input ->
            sourceClip.outputStream().use { output -> input.copyTo(output) }
        }
        outputFile = File(context.cacheDir, "geom_export_${System.nanoTime()}.mp4")
    }

    @After
    fun tearDown() {
        sourceClip.delete()
        outputFile.delete()
    }

    /** Display size in the orientation the USER selected, rotation-aware. */
    private data class DisplaySize(val width: Int, val height: Int) {
        override fun toString(): String = "${width}x$height"
    }

    private fun exportAndProbeDisplaySize(edl: Edl): DisplaySize {
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
        val probe = MediaProbe.probe(outputFile, mimeTypeHint = null)
        return if (probe.rotationDegrees % 180 == 90) {
            DisplaySize(probe.height, probe.width)
        } else {
            DisplaySize(probe.width, probe.height)
        }
    }

    private fun identityTransform() = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0)

    /**
     * Single-clip EDL at the requested output geometry. `canvasWidth`/
     * `canvasHeight` mirror the output size exactly, matching what the
     * export sheet produces (the canvas IS the render resolution).
     */
    private fun buildSingleClipEdl(
        outputWidth: Int,
        outputHeight: Int,
        clipTicks: Long,
        transitions: List<EdlTransition> = emptyList(),
        secondClip: EdlClip? = null,
    ): Edl {
        val asset = EdlAsset(
            assetId = "asset-1",
            kind = EdlAssetKind.VIDEO,
            name = sourceClip.name,
            sourceUri = sourceClip.toURI().toString(),
            codec = null,
            width = 320,
            height = 240,
            durationTicks = 2 * ticksPerSecond,
            rotationDegrees = 0,
            hasAudio = true,
        )
        fun clip(clipId: String, startTicks: Long) = EdlClip(
            clipId = clipId,
            kind = "video",
            assetId = "asset-1",
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
        val clips = if (secondClip != null) {
            listOf(clip("clip-a", 0), secondClip)
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
        return Edl(
            meta = EdlMeta(
                edlVersion = 1,
                generator = "cutlyra-geometry-test",
                ticksPerSecond = ticksPerSecond,
                frameRate = EdlRational(30, 1),
                canvasWidth = outputWidth,
                canvasHeight = outputHeight,
                projectId = "proj-geom",
                projectName = "Geometry Fixture",
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
                bitrate = 4_000_000,
                fps = EdlRational(30, 1),
                resolutionWidth = outputWidth,
                resolutionHeight = outputHeight,
                includeAudio = true,
            ),
        )
    }

    /** The D-NEW-1 class: 1080 is NOT 16-aligned — pre-fix, POCO muxed 1088. */
    @Test
    fun exports_exact_1920x1080_landscape_geometry() {
        val display = exportAndProbeDisplaySize(
            buildSingleClipEdl(1920, 1080, clipTicks = ticksPerSecond / 2),
        )
        assertEquals(
            "1080p-class export must be exactly 1920x1080 — media3's encoder " +
                "resolution fallback must not round the size up to macroblock " +
                "alignment (GitHub #19)",
            DisplaySize(1920, 1080),
            display,
        )
    }

    /** Control: 720 is 16-aligned; nothing may change for it. */
    @Test
    fun exports_exact_1280x720_landscape_geometry() {
        val display = exportAndProbeDisplaySize(
            buildSingleClipEdl(1280, 720, clipTicks = ticksPerSecond / 2),
        )
        assertEquals(DisplaySize(1280, 720), display)
    }

    /**
     * Portrait: media3 may encode rotated (landscape-coded + 90° matrix) or
     * directly — either is correct; padding (a 1088 anywhere) is not.
     */
    @Test
    fun exports_exact_1080x1920_portrait_geometry() {
        val display = exportAndProbeDisplaySize(
            buildSingleClipEdl(1080, 1920, clipTicks = ticksPerSecond / 2),
        )
        assertEquals(
            "portrait export must present exactly 1080x1920 regardless of " +
                "the encoder-rotation strategy",
            DisplaySize(1080, 1920),
            display,
        )
    }

    /** Multi-input (cross-fade) compositions must keep exact geometry too. */
    @Test
    fun exports_exact_1920x1080_geometry_through_a_crossfade_composition() {
        val clipTicks = ticksPerSecond / 2 // 500 ms
        val transitionTicks = ticksPerSecond / 10 // 100 ms
        val secondClip = EdlClip(
            clipId = "clip-b",
            kind = "video",
            assetId = "asset-1",
            name = "b",
            startTicks = clipTicks,
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
        val display = exportAndProbeDisplaySize(
            buildSingleClipEdl(
                outputWidth = 1920,
                outputHeight = 1080,
                clipTicks = clipTicks,
                transitions = listOf(
                    EdlTransition(
                        transitionId = "t-1",
                        afterClipId = "clip-a",
                        kind = "crossfade",
                        durationTicks = transitionTicks,
                    ),
                ),
                secondClip = secondClip,
            ),
        )
        assertEquals(DisplaySize(1920, 1080), display)
    }
}
