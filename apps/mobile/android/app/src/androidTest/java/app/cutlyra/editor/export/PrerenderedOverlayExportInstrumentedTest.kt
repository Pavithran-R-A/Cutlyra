package app.cutlyra.editor.export

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * GitHub #39 / Linear PAV-103 — DECODED-MP4 regression for the prerendered
 * overlay path: an overlay frame must be burned into every encoded frame of
 * its FULL [startUs, endUs) window on the OUTPUT clock, and into no frame
 * outside it.
 *
 * WHY THIS EXISTS (Stage 12): on main `89b1de3` the autotest's caption pages
 * rendered on exactly 3 of 270 encoded frames, identically on emulator and
 * POCO hardware. The TS-side cause (collapsed whisper DTW starts → 80 ms
 * element windows) is pinned by `caption-window-integrity.test.ts`; the
 * native half pinned here is that a NORMAL-SIZED window handed to
 * `Media3Exporter` via `PrerenderedOverlay` really does cover every frame
 * of its window, including under CROSS-FADE timeline compression (windows
 * remapped start-only through `MainTrackPlacements.remapNominalTick`, the
 * exact conversion `NativeBridgePlugin.exportProject` performs) and at
 * non-30 fps output grids.
 *
 * WHAT THIS DOES: real `EdlToComposition.buildComposition` + a real
 * `Media3Exporter`/`Transformer` export, then decodes actual output frames
 * (MediaMetadataRetriever) and counts solid-magenta overlay pixels at
 * sample times inside and outside each window. Kind-agnostic by
 * construction: the exporter composites every prerendered overlay — text
 * page or caption page — as the same `BitmapOverlay`, so window timing is
 * the property under test, not glyph rendering (which only the webview's
 * drawing code can produce; the preview/export drawing parity is
 * overlay-frames.ts's single-implementation design).
 *
 * Fixture source: the instrumentation-APK `res/raw/test_clip.mp4` (2 s,
 * 320x240), as both main-track clips — same pattern as
 * `ExportGoldenFrameInstrumentedTest`.
 */
@RunWith(AndroidJUnit4::class)
class PrerenderedOverlayExportInstrumentedTest {
    private lateinit var context: Context
    private lateinit var testContext: Context
    private lateinit var sourceClip: File

    private val ticksPerSecond = 120_000L

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        testContext = InstrumentationRegistry.getInstrumentation().context
        sourceClip = File(context.cacheDir, "overlay_source_${System.nanoTime()}.mp4")
        testContext.resources.openRawResource(R.raw.test_clip).use { input ->
            sourceClip.outputStream().use { output -> input.copyTo(output) }
        }
    }

    @After
    fun tearDown() {
        sourceClip.delete()
    }

    private fun ticksOf(seconds: Double) = Math.round(seconds * ticksPerSecond)

    private fun buildEdl(
        fps: Long,
        transitionTicks: Long,
    ): Edl {
        val oneSecond = ticksPerSecond
        val asset = EdlAsset(
            assetId = "asset-1",
            kind = EdlAssetKind.VIDEO,
            name = sourceClip.name,
            sourceUri = sourceClip.toURI().toString(),
            codec = null,
            width = 320,
            height = 240,
            durationTicks = 2 * oneSecond,
            rotationDegrees = 0,
            hasAudio = false,
        )
        fun identity() = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0)
        val clipA = EdlClip(
            clipId = "clip-a",
            kind = "video",
            assetId = asset.assetId,
            name = "a",
            startTicks = 0,
            durationTicks = oneSecond,
            sourceStartTicks = 0,
            sourceEndTicks = oneSecond,
            speed = EdlRational(1, 1),
            maintainPitch = false,
            volumeDb = 0.0,
            muted = false,
            hidden = false,
            transform = identity(),
            opacity = 1.0,
            effects = emptyList(),
            hasMasks = false,
            animations = emptyList(),
            params = emptyMap(),
        )
        val clipB = clipA.copy(
            clipId = "clip-b",
            startTicks = oneSecond,
            sourceStartTicks = 0,
            sourceEndTicks = oneSecond,
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
        val transitions = if (transitionTicks > 0) {
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
                generator = "cutlyra-39-overlay-window-test",
                ticksPerSecond = ticksPerSecond,
                frameRate = EdlRational(fps, 1L),
                canvasWidth = 320,
                canvasHeight = 240,
                projectId = "proj-39",
                projectName = "Overlay Window Fixture",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = 2 * oneSecond,
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
                fps = EdlRational(fps, 1L),
                resolutionWidth = 320,
                resolutionHeight = 240,
                includeAudio = false,
            ),
        )
    }

    private fun magentaBitmap(): Bitmap =
        Bitmap.createBitmap(320, 240, Bitmap.Config.ARGB_8888).apply {
            eraseColor(Color.MAGENTA)
        }

    private fun runExport(edl: Edl, frames: List<PrerenderedOverlay.Frame>): File {
        val outputFile = File(context.cacheDir, "overlay_export_${System.nanoTime()}.mp4")
        val latch = CountDownLatch(1)
        val events = mutableListOf<Media3Exporter.Event>()
        Media3Exporter.start(context, edl, outputFile, frames) { event ->
            events.add(event)
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                latch.countDown()
            }
        }
        assertTrue("export did not reach a terminal state within 90s", latch.await(90, TimeUnit.SECONDS))
        val terminal = events.lastOrNull()
        assertTrue("export failed: $terminal", terminal is Media3Exporter.Event.Done)
        return (terminal as Media3Exporter.Event.Done).outputFile
    }

    /** Fraction of a 40x40 centre box that is unmistakably solid magenta. */
    private fun magentaFraction(file: File, atUs: Long): Double {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            val frame = retriever.getFrameAtTime(
                atUs,
                MediaMetadataRetriever.OPTION_CLOSEST,
            ) ?: error("no frame decodable at ${atUs}us")
            val bitmap = frame.copy(Bitmap.Config.ARGB_8888, false)
                ?: error("frame at ${atUs}us not convertible")
            val cx = bitmap.width / 2
            val cy = bitmap.height / 2
            var hits = 0
            var total = 0
            for (dy in -20 until 20) {
                for (dx in -20 until 20) {
                    val pixel = bitmap.getPixel(cx + dx, cy + dy)
                    val r = Color.red(pixel)
                    val g = Color.green(pixel)
                    val b = Color.blue(pixel)
                    if (r > 180 && b > 180 && g < 120) hits++
                    total++
                }
            }
            return hits.toDouble() / total
        } finally {
            retriever.release()
        }
    }

    private fun assertOverlayPresent(file: File, atUs: Long) {
        assertTrue(
            "expected overlay glyphs at ${atUs}us, magenta fraction=${magentaFraction(file, atUs)}",
            magentaFraction(file, atUs) > 0.9,
        )
    }

    private fun assertOverlayAbsent(file: File, atUs: Long) {
        assertFalse(
            "expected NO overlay at ${atUs}us, magenta fraction=${magentaFraction(file, atUs)}",
            magentaFraction(file, atUs) > 0.5,
        )
    }

    @Test
    fun overlay_windows_cover_every_encoded_frame_of_the_window_at_30fps() {
        val frames = listOf(
            PrerenderedOverlay.Frame(0L, 500_000L, magentaBitmap()),
            PrerenderedOverlay.Frame(500_000L, 1_500_000L, magentaBitmap()),
        )
        val output = runExport(buildEdl(fps = 30L, transitionTicks = 0), frames)
        try {
            // Page-1 window [0, 0.5s): first, middle, and last in-window frame.
            assertOverlayPresent(output, 0L)
            assertOverlayPresent(output, 250_000L)
            assertOverlayPresent(output, 490_000L)
            // Page-2 window [0.5s, 1.5s): boundary-inclusive at 0.5s.
            assertOverlayPresent(output, 500_000L)
            assertOverlayPresent(output, 1_000_000L)
            assertOverlayPresent(output, 1_490_000L)
            // Outside both windows (the pre-fix symptom was the INVERSE:
            // glyphs only at ~2.56s-ish samples, never over these).
            assertOverlayAbsent(output, 1_600_000L)
        } finally {
            output.delete()
        }
    }

    @Test
    fun crossfade_compression_shifts_overlay_windows_start_only_like_the_plugin_remapped() {
        val transitionTicks = ticksOf(0.2)
        val edl = buildEdl(fps = 30L, transitionTicks = transitionTicks)
        // Mirror NativeBridgePlugin.exportProject exactly: remap the window
        // START through MainTrackPlacements, keep its duration.
        val placements = MainTrackPlacements.build(
            edl.mainTrack()?.clips?.filter { it.kind == "video" || it.kind == "image" } ?: emptyList(),
            edl.transitions,
        )
        val nominalStart = ticksOf(1.4)
        val nominalEnd = ticksOf(1.7)
        val outStartTicks = placements.remapNominalTick(nominalStart)
        val outEndTicks = outStartTicks + (nominalEnd - nominalStart)
        val frames = listOf(
            PrerenderedOverlay.Frame(
                startUs = outStartTicks * 1_000_000L / ticksPerSecond,
                endUs = outEndTicks * 1_000_000L / ticksPerSecond,
                bitmap = magentaBitmap(),
            ),
        )
        // Output timeline is compressed by the 0.2s overlap: the nominal
        // [1.4, 1.7) window must land on output [1.2, 1.5).
        assertTrue("fixture sanity: remap must shift the window", outStartTicks < nominalStart)
        val output = runExport(edl, frames)
        try {
            // Inside the SHIFTED window (the nominal-clock bug predicted
            // NO overlay here — window would sit at 1.4..1.7).
            assertOverlayPresent(output, 1_250_000L)
            assertOverlayPresent(output, 1_450_000L)
            // Outside it, on both sides (the nominal-clock bug predicted
            // overlay here — 1.55s is inside [1.4, 1.7)).
            assertOverlayAbsent(output, 1_100_000L)
            assertOverlayAbsent(output, 1_600_000L)
        } finally {
            output.delete()
        }
    }

    @Test
    fun overlay_windows_hold_at_24fps_and_60fps_output_grids() {
        for (fps in listOf(24L, 60L)) {
            val frames = listOf(
                PrerenderedOverlay.Frame(0L, 500_000L, magentaBitmap()),
            )
            val output = runExport(buildEdl(fps = fps, transitionTicks = 0), frames)
            try {
                assertOverlayPresent(output, 0L)
                assertOverlayPresent(output, 490_000L)
                // Straddles the 0.5s window edge at every grid >= 12 fps.
                assertOverlayAbsent(output, 510_000L)
                assertOverlayAbsent(output, 900_000L)
            } finally {
                output.delete()
            }
        }
    }
}
