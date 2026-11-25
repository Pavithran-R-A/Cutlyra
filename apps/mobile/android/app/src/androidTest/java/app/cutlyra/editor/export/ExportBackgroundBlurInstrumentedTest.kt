package app.cutlyra.editor.export

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cutlyra.editor.edl.Edl
import app.cutlyra.editor.edl.EdlAsset
import app.cutlyra.editor.edl.EdlBackground
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

/**
 * Background Blur proven on decoded pixels.
 *
 * A striped source is exported with `meta.background = blur` at two
 * intensities, in portrait-on-landscape and landscape-on-portrait. The output
 * MP4 is decoded and measured:
 *  - inside the fitted foreground rect the stripes stay SHARP (high edge
 *    energy) and correctly placed;
 *  - outside it the frame is not black: it contains the same source, blurred
 *    (much lower edge energy, mid-grey mean);
 *  - a stronger intensity blurs the backdrop measurably more.
 */
@RunWith(AndroidJUnit4::class)
class ExportBackgroundBlurInstrumentedTest {
    private lateinit var context: Context
    private lateinit var portraitSource: File
    private lateinit var landscapeSource: File
    private val outputs = mutableListOf<File>()

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        portraitSource = PatternVideoFactory.create(
            File(context.cacheDir, "blur_portrait_${System.nanoTime()}.mp4"),
            width = 240,
            height = 320,
        )
        landscapeSource = PatternVideoFactory.create(
            File(context.cacheDir, "blur_landscape_${System.nanoTime()}.mp4"),
            width = 320,
            height = 240,
        )
    }

    @After
    fun tearDown() {
        portraitSource.delete()
        landscapeSource.delete()
        outputs.forEach { it.delete() }
    }

    private fun buildEdl(
        source: File,
        sourceWidth: Int,
        sourceHeight: Int,
        canvasWidth: Int,
        canvasHeight: Int,
        intensity: Double,
    ): Edl {
        val asset = EdlAsset(
            assetId = "asset-src",
            kind = EdlAssetKind.VIDEO,
            name = source.name,
            sourceUri = source.toURI().toString(),
            codec = null,
            width = sourceWidth,
            height = sourceHeight,
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
            effects = emptyList(),
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
                generator = "cutlyra-background-blur-test",
                ticksPerSecond = 120_000L,
                frameRate = EdlRational(30, 1),
                canvasWidth = canvasWidth,
                canvasHeight = canvasHeight,
                projectId = "proj-blur",
                projectName = "Background Blur",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = 2_400_000L,
                background = EdlBackground(
                    type = "blur",
                    color = "#000000",
                    blurIntensity = intensity,
                ),
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
                resolutionWidth = canvasWidth,
                resolutionHeight = canvasHeight,
                includeAudio = false,
            ),
        )
    }

    private fun export(edl: Edl, label: String): File {
        val output = File(context.cacheDir, "blur_${label}_${System.nanoTime()}.mp4")
        outputs.add(output)
        val latch = CountDownLatch(1)
        var terminal: Media3Exporter.Event? = null
        Media3Exporter.start(context, edl, output) { event ->
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

    @Test
    fun portraitClipOnLandscapeCanvas_blursTheBackdropAndKeepsTheForegroundSharp() {
        // Foreground occupies x in [0.289, 0.711]; the side bands are backdrop.
        val medium = export(
            buildEdl(portraitSource, 240, 320, 1280, 720, intensity = 200.0),
            "portrait-medium",
        )
        val heavy = export(
            buildEdl(portraitSource, 240, 320, 1280, 720, intensity = 400.0),
            "portrait-heavy",
        )

        val mediumFrame = PatternVideoFactory.frameAt(medium, 1_000_000L)
        val heavyFrame = PatternVideoFactory.frameAt(heavy, 1_000_000L)

        val foreground = PatternVideoFactory.edgeEnergy(mediumFrame, 0.5, 0.35, 0.65)
        val backdrop = PatternVideoFactory.edgeEnergy(mediumFrame, 0.5, 0.02, 0.20)
        val backdropHeavy = PatternVideoFactory.edgeEnergy(heavyFrame, 0.5, 0.02, 0.20)
        val backdropMean = PatternVideoFactory.meanLuma(mediumFrame, 0.5, 0.02, 0.20)

        assertTrue(
            "foreground must stay sharp: fg=$foreground backdrop=$backdrop",
            foreground > backdrop * 2.0,
        )
        assertTrue(
            "backdrop must not be black: mean luma=$backdropMean",
            backdropMean in 30.0..225.0,
        )
        assertTrue(
            "stronger intensity must blur more: medium=$backdrop heavy=$backdropHeavy",
            backdropHeavy < backdrop,
        )
    }

    @Test
    fun landscapeClipOnPortraitCanvas_blursTheTopAndBottomBackdrop() {
        // Foreground is 720x540 centred vertically: y in [0.289, 0.711].
        val output = export(
            buildEdl(landscapeSource, 320, 240, 720, 1280, intensity = 300.0),
            "landscape",
        )
        val frame = PatternVideoFactory.frameAt(output, 1_000_000L)
        val foreground = PatternVideoFactory.edgeEnergy(frame, 0.5, 0.10, 0.90)
        val backdrop = PatternVideoFactory.edgeEnergy(frame, 0.10, 0.10, 0.90)
        val backdropMean = PatternVideoFactory.meanLuma(frame, 0.10, 0.10, 0.90)

        assertTrue(
            "foreground must stay sharp: fg=$foreground backdrop=$backdrop",
            foreground > backdrop * 2.0,
        )
        assertTrue(
            "backdrop must not be black: mean luma=$backdropMean",
            backdropMean in 30.0..225.0,
        )
    }
}
