package app.cutlyra.editor.export

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cutlyra.editor.edl.Edl
import app.cutlyra.editor.edl.EdlAsset
import app.cutlyra.editor.edl.EdlAssetKind
import app.cutlyra.editor.edl.EdlBackground
import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlEffect
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

/**
 * Adjust-panel Sharpen and Vignette proven on decoded pixels.
 *
 * Both sliders used to make Android export throw `ExportUnsupportedException`
 * (GitHub #48) while the preview rendered them. They are now real GL passes
 * ([ColorGradeSpatialEffect]); this test exports the SAME striped source with
 * and without each slider and measures the decoded MP4:
 *
 *  - sharpen raises per-pixel edge contrast across the stripes (unsharp mask)
 *    without washing the average level out;
 *  - vignette darkens the corners while leaving the centre band untouched.
 *
 * The stripes are `PatternVideoFactory`'s deterministic ones, so a sharp copy
 * and a graded copy are directly comparable frame for frame.
 */
@RunWith(AndroidJUnit4::class)
class ExportSharpenVignetteInstrumentedTest {
    private lateinit var context: Context
    private lateinit var source: File
    private val extraSources = mutableListOf<File>()
    private val outputs = mutableListOf<File>()

    private val width = 320
    private val height = 240

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        source = PatternVideoFactory.create(
            File(context.cacheDir, "spatial_grade_${System.nanoTime()}.mp4"),
            width = width,
            height = height,
        )
    }

    @After
    fun tearDown() {
        source.delete()
        extraSources.forEach { it.delete() }
        outputs.forEach { it.delete() }
    }

    private fun buildEdl(effect: EdlEffect?): Edl {
        val asset = EdlAsset(
            assetId = "asset-src",
            kind = EdlAssetKind.VIDEO,
            name = source.name,
            sourceUri = source.toURI().toString(),
            codec = null,
            width = width,
            height = height,
            durationTicks = 2_400_000L,
            rotationDegrees = 0,
            hasAudio = false,
        )
        val clip = EdlClip(
            clipId = "clip-1",
            kind = "video",
            assetId = asset.assetId,
            name = "clip",
            startTicks = 0,
            durationTicks = 2_400_000L,
            sourceStartTicks = 0,
            sourceEndTicks = 2_400_000L,
            speed = EdlRational(1, 1),
            maintainPitch = false,
            volumeDb = 0.0,
            muted = true,
            hidden = false,
            transform = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0),
            opacity = 1.0,
            framing = "fit",
            effects = listOfNotNull(effect),
            hasMasks = false,
            animations = emptyList(),
            params = emptyMap(),
        )
        val track = EdlTrack(
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
                generator = "cutlyra-spatial-grade-test",
                ticksPerSecond = 120_000L,
                frameRate = EdlRational(30, 1),
                canvasWidth = width,
                canvasHeight = height,
                projectId = "proj-spatial",
                projectName = "Sharpen and Vignette",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = 2_400_000L,
                background = EdlBackground(type = "color", color = "#000000", blurIntensity = 0.0),
            ),
            assets = listOf(asset),
            tracks = listOf(track),
            transitions = emptyList(),
            overlays = emptyList(),
            output = EdlOutput(
                container = "mp4",
                videoCodec = "avc1",
                audioCodec = "mp4a",
                bitrate = 6_000_000,
                fps = EdlRational(30, 1),
                resolutionWidth = width,
                resolutionHeight = height,
                includeAudio = false,
            ),
        )
    }

    private fun export(effect: EdlEffect?, label: String): File {
        val output = File(context.cacheDir, "spatial_${label}_${System.nanoTime()}.mp4")
        outputs.add(output)
        val latch = CountDownLatch(1)
        var terminal: Media3Exporter.Event? = null
        Media3Exporter.start(context, buildEdl(effect), output) { event ->
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                terminal = event
                latch.countDown()
            }
        }
        assertTrue("$label export timed out", latch.await(240, TimeUnit.SECONDS))
        val ended = terminal
        assertTrue("$label export failed: $ended", ended is Media3Exporter.Event.Done)
        return output
    }

    private fun adjust(params: Map<String, Any?>): EdlEffect = EdlEffect(
        effectId = "effect-adjust",
        type = ColorGrade.ADJUST_TYPE,
        enabled = true,
        params = params,
    )

    @Test
    fun sharpen_raises_decoded_edge_contrast() {
        // Headroom matters: the default 235/16 stripes encode as a clipped
        // 254->0 step, which an unsharp mask cannot exaggerate any further.
        // Mid-grey stripes leave room for the overshoot the shader creates.
        val headroom = PatternVideoFactory.create(
            File(context.cacheDir, "spatial_headroom_${System.nanoTime()}.mp4"),
            width = width,
            height = height,
            brightLuma = 180,
            darkLuma = 70,
        )
        extraSources.add(headroom)
        source = headroom

        // Regression guard: this export used to fail outright.
        val plain = PatternVideoFactory.frameAt(export(null, "plain-sharpen"), 1_000_000L)
        val sharpened = PatternVideoFactory.frameAt(
            export(adjust(mapOf("sharpen" to 100)), "sharpen"),
            1_000_000L,
        )

        val plainEdges = PatternVideoFactory.edgeEnergy(plain, 0.5, 0.05, 0.95)
        val sharpEdges = PatternVideoFactory.edgeEnergy(sharpened, 0.5, 0.05, 0.95)
        val plainMean = PatternVideoFactory.meanLuma(plain, 0.5, 0.05, 0.95)
        val sharpMean = PatternVideoFactory.meanLuma(sharpened, 0.5, 0.05, 0.95)

        assertTrue(
            "sharpen must increase edge contrast: plain=$plainEdges sharp=$sharpEdges",
            sharpEdges > plainEdges * 1.10,
        )
        assertTrue(
            "sharpen must not wash the image out: plain=$plainMean sharp=$sharpMean",
            kotlin.math.abs(sharpMean - plainMean) < 25.0,
        )
    }

    @Test
    fun vignette_darkens_corners_and_leaves_the_centre_alone() {
        val plain = PatternVideoFactory.frameAt(export(null, "plain-vignette"), 1_000_000L)
        val vignetted = PatternVideoFactory.frameAt(
            export(adjust(mapOf("vignette" to 100)), "vignette"),
            1_000_000L,
        )

        // Top-left corner vs the centre band, same fixed row fractions.
        val plainCorner = PatternVideoFactory.meanLuma(plain, 0.03, 0.0, 0.12)
        val vignetteCorner = PatternVideoFactory.meanLuma(vignetted, 0.03, 0.0, 0.12)
        val plainCentre = PatternVideoFactory.meanLuma(plain, 0.5, 0.40, 0.60)
        val vignetteCentre = PatternVideoFactory.meanLuma(vignetted, 0.5, 0.40, 0.60)

        assertTrue(
            "a corner must be much darker: plain=$plainCorner vignette=$vignetteCorner",
            vignetteCorner < plainCorner * 0.60,
        )
        assertTrue(
            "the centre must keep its level: plain=$plainCentre vignette=$vignetteCentre",
            kotlin.math.abs(vignetteCentre - plainCentre) < 10.0,
        )
    }
}
