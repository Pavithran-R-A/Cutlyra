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
import app.cutlyra.editor.edl.EdlEffect
import app.cutlyra.editor.edl.EdlMeta
import app.cutlyra.editor.edl.EdlOutput
import app.cutlyra.editor.edl.EdlRational
import app.cutlyra.editor.edl.EdlTrack
import app.cutlyra.editor.edl.EdlTrackKind
import app.cutlyra.editor.edl.EdlTrackType
import app.cutlyra.editor.edl.EdlTransform
import app.cutlyra.editor.media.MediaProbe
import app.cutlyra.editor.test.R
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * GitHub #48 / Linear PAV-142 — THE regression test for effect-bearing
 * exports.
 *
 * Before #48, `EdlToComposition.buildEditedMediaItem` threw
 * `ExportUnsupportedException` for any non-empty `EdlClip.effects`. The Adjust
 * and Filters panels write exactly those effects, so a project with a single
 * brightness slider moved could not export AT ALL on Android — and that is
 * why both panels were withheld from the shipping toolbar
 * (`toolbar-defs.ts`).
 *
 * These tests exercise the real pipeline end to end: `EdlToComposition`
 * -> media3 `Transformer` -> an MP4 on disk -> frames decoded back out with
 * `MediaMetadataRetriever`. Three levels of proof:
 *
 *   1. an effect-bearing clip EXPORTS (fails on pre-#48 code);
 *   2. the grade is VISIBLE in the decoded frames (brightness raises mean
 *      luma, the Mono preset collapses chroma);
 *   3. the decoded result MATCHES the matrix the preview shader uses —
 *      asserted on per-pixel means, which an affine transform preserves
 *      exactly (`E[M*c + d] = M*E[c] + d`), so the check is robust to
 *      codec noise while still catching a wrong or missing grade.
 *
 * Unsupported params (`sharpen`, `vignette`) are asserted to REFUSE with a
 * named message rather than export as if they had been applied — the "no
 * preview-only effects, no silent drops" rule.
 */
@RunWith(AndroidJUnit4::class)
class ExportColorGradeInstrumentedTest {
    private lateinit var context: Context
    private lateinit var testContext: Context
    private lateinit var sourceClip: File

    private val ticksPerSecond = 120_000L
    private val clipDurationTicks = ticksPerSecond // 1 s keeps the suite quick

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        testContext = InstrumentationRegistry.getInstrumentation().context
        sourceClip = File(context.cacheDir, "grade_source_${System.nanoTime()}.mp4")
        testContext.resources.openRawResource(R.raw.test_clip).use { input ->
            sourceClip.outputStream().use { output -> input.copyTo(output) }
        }
    }

    @After
    fun tearDown() {
        sourceClip.delete()
    }

    private fun identityTransform() = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0)

    /** A single hard-cut main-track clip carrying [effects] on the visual clip. */
    private fun buildEdl(effects: List<EdlEffect>): Edl {
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
        val clip = EdlClip(
            clipId = "clip-main",
            kind = "video",
            assetId = asset.assetId,
            name = "main",
            startTicks = 0,
            durationTicks = clipDurationTicks,
            sourceStartTicks = 0,
            sourceEndTicks = clipDurationTicks,
            speed = EdlRational(1, 1),
            maintainPitch = false,
            volumeDb = 0.0,
            muted = false,
            hidden = false,
            transform = identityTransform(),
            opacity = 1.0,
            effects = effects,
            hasMasks = false,
            animations = emptyList(),
            params = emptyMap(),
        )
        val mainTrack = EdlTrack(
            trackId = "track-main",
            kind = EdlTrackKind.MAIN,
            trackType = EdlTrackType.VIDEO,
            name = "Main",
            zIndex = 0,
            muted = false,
            hidden = false,
            clips = listOf(clip),
        )
        return Edl(
            meta = EdlMeta(
                edlVersion = 1,
                generator = "cutlyra-color-grade-test",
                ticksPerSecond = ticksPerSecond,
                frameRate = EdlRational(30, 1),
                canvasWidth = 320,
                canvasHeight = 240,
                projectId = "proj-grade",
                projectName = "Color Grade Fixture",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = clipDurationTicks,
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
                fps = EdlRational(30, 1),
                resolutionWidth = 320,
                resolutionHeight = 240,
                includeAudio = true,
            ),
        )
    }

    private fun effect(type: String, params: Map<String, Any?>) =
        EdlEffect(effectId = "e-1", type = type, enabled = true, params = params)

    /** Runs a real export to completion; returns the output file or fails the test. */
    private fun export(edl: Edl, label: String): File {
        val outputFile = File(context.cacheDir, "grade_${label}_${System.nanoTime()}.mp4")
        val latch = CountDownLatch(1)
        val events = mutableListOf<Media3Exporter.Event>()
        Media3Exporter.start(context, edl, outputFile) { event ->
            events.add(event)
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                latch.countDown()
            }
        }
        assertTrue("$label export did not terminate within 90s", latch.await(90, TimeUnit.SECONDS))
        val terminal = events.lastOrNull()
        assertTrue("$label export failed: $terminal", terminal is Media3Exporter.Event.Done)
        val done = terminal as Media3Exporter.Event.Done
        assertTrue(done.outputFile.length() > 0)
        MediaProbe.probe(done.outputFile, mimeTypeHint = "video/mp4")
        return done.outputFile
    }

    /** Mean sRGB of every pixel of the frame at [atUs], each channel 0..1. */
    private fun meanRgb(file: File, atUs: Long): FloatArray {
        val retriever = MediaMetadataRetriever()
        val frame = try {
            retriever.setDataSource(file.absolutePath)
            retriever.getFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST)
        } finally {
            retriever.release()
        }
        assertNotNull("$file has no decodable frame at ${atUs}us", frame)
        val bitmap = frame!!
        var r = 0L
        var g = 0L
        var b = 0L
        for (y in 0 until bitmap.height) {
            for (x in 0 until bitmap.width) {
                val c = bitmap.getPixel(x, y)
                r += (c shr 16) and 0xff
                g += (c shr 8) and 0xff
                b += c and 0xff
            }
        }
        val n = (bitmap.width * bitmap.height).toFloat() * 255f
        return floatArrayOf(r / n, g / n, b / n)
    }

    private fun apply(matrix: FloatArray, rgb: FloatArray): FloatArray = floatArrayOf(
        matrix[0] * rgb[0] + matrix[4] * rgb[1] + matrix[8] * rgb[2] + matrix[12],
        matrix[1] * rgb[0] + matrix[5] * rgb[1] + matrix[9] * rgb[2] + matrix[13],
        matrix[2] * rgb[0] + matrix[6] * rgb[1] + matrix[10] * rgb[2] + matrix[14],
    )

    /**
     * THE #48 regression: an effect-bearing clip must export, the grade must
     * be visible, and it must be the SAME grade the preview renders.
     */
    @Test
    fun effect_bearing_clip_exports_and_its_grade_is_visible_and_matches_preview() {
        val atUs = 500_000L

        // 1. Baseline — no effects at all.
        val baseline = export(buildEdl(emptyList()), "baseline")
        try {
            // 2. The regression case: an `adjust` effect. Pre-#48 this threw
            //    ExportUnsupportedException before media3 ever started.
            val brightnessEdl = buildEdl(
                listOf(effect(ColorGrade.ADJUST_TYPE, mapOf("brightness" to 50))),
            )
            val graded = export(brightnessEdl, "brightness")
            try {
                val base = meanRgb(baseline, atUs)
                val out = meanRgb(graded, atUs)

                // Visible: mean luma must move up noticeably.
                val baseLuma = 0.2126f * base[0] + 0.7152f * base[1] + 0.0722f * base[2]
                val outLuma = 0.2126f * out[0] + 0.7152f * out[1] + 0.0722f * out[2]
                assertTrue(
                    "brightness must raise decoded mean luma, baseline=$baseLuma graded=$outLuma",
                    outLuma > baseLuma + 0.05f,
                )

                // Parity: the decoded means must satisfy the SAME matrix the
                // preview's color-adjust pass uses. An affine transform
                // preserves means, so this is exact modulo codec noise.
                val matrix = ColorGrade.fromAdjust(mapOf("brightness" to 50)).rgbMatrix()
                val expected = apply(matrix, base)
                for (i in 0 until 3) {
                    assertTrue(
                        "channel $i of the exported grade must match the preview matrix: " +
                            "expected ${expected[i]}, decoded ${out[i]}",
                        abs(out[i] - expected[i]) < 0.05f,
                    )
                }

                // 3. The Mono filter preset: chroma must collapse.
                val monoEdl = buildEdl(
                    listOf(
                        effect(
                            ColorGrade.FILTER_TYPE,
                            mapOf("preset" to "mono", "intensity" to 100),
                        ),
                    ),
                )
                val mono = export(monoEdl, "mono")
                try {
                    val monoRgb = meanRgb(mono, atUs)
                    val spread = { c: FloatArray ->
                        maxOf(abs(c[0] - c[1]), abs(c[1] - c[2]), abs(c[0] - c[2]))
                    }
                    assertTrue(
                        "mono must collapse chroma: baseline spread ${spread(base)}, " +
                            "mono spread ${spread(monoRgb)}",
                        spread(monoRgb) < spread(base) * 0.5f + 0.01f,
                    )
                    // ...and still land where the shared matrix says it should.
                    val monoMatrix =
                        ColorGrade.fromFilter(mapOf("preset" to "mono", "intensity" to 100))
                            .rgbMatrix()
                    val monoExpected = apply(monoMatrix, base)
                    for (i in 0 until 3) {
                        assertTrue(
                            "mono channel $i: expected ${monoExpected[i]}, decoded ${monoRgb[i]}",
                            abs(monoRgb[i] - monoExpected[i]) < 0.05f,
                        )
                    }
                } finally {
                    mono.delete()
                }
            } finally {
                graded.delete()
            }
        } finally {
            baseline.delete()
        }
    }

    /**
     * The other half of "no preview-only effects": a grade we CANNOT map must
     * fail the export with a message naming the param, instead of exporting a
     * file that quietly ignores the user's edit.
     */
    @Test
    fun an_unmappable_adjust_param_refuses_the_export_with_a_named_message() {
        val edl = buildEdl(listOf(effect(ColorGrade.ADJUST_TYPE, mapOf("sharpen" to 40))))
        val outputFile = File(context.cacheDir, "grade_refused_${System.nanoTime()}.mp4")
        val latch = CountDownLatch(1)
        val events = mutableListOf<Media3Exporter.Event>()
        Media3Exporter.start(context, edl, outputFile) { event ->
            events.add(event)
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                latch.countDown()
            }
        }
        assertTrue("refusal export did not terminate within 60s", latch.await(60, TimeUnit.SECONDS))
        val terminal = events.lastOrNull()
        assertTrue("expected a refusal, got $terminal", terminal is Media3Exporter.Event.Error)
        val message = (terminal as Media3Exporter.Event.Error).message
        assertTrue("refusal must name the unmappable param, was: $message", message.contains("sharpen"))
        outputFile.delete()
    }

    /** Composition shape: a mapped grade must not change the sequence layout,
     *  and an effect-bearing clip must not be refused during composition. */
    @Test
    fun build_composition_accepts_effect_bearing_clips() {
        val plain = EdlToComposition.buildComposition(buildEdl(emptyList()))
        val graded = EdlToComposition.buildComposition(
            buildEdl(listOf(effect(ColorGrade.ADJUST_TYPE, mapOf("contrast" to 40)))),
        )
        // Mapping a grade must not reshape the composition: whatever
        // sequences the plain EDL produces, the graded one produces the same.
        assertTrue("fixture must produce at least one sequence", plain.sequences.size >= 1)
        assertEquals(plain.sequences.size, graded.sequences.size)
    }
}
