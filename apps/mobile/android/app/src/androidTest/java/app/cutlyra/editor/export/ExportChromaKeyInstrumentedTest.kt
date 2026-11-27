package app.cutlyra.editor.export

import android.content.Context
import android.graphics.Bitmap
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cutlyra.editor.edl.Edl
import app.cutlyra.editor.edl.EdlAsset
import app.cutlyra.editor.edl.EdlAssetKind
import app.cutlyra.editor.edl.EdlBackground
import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlCrop
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
 * Chroma key proven on DECODED MP4 pixels, over a real lower layer.
 *
 * Fixtures are deterministic H.264 clips: a blue base on the main track, and a
 * green-screen overlay (solid green with a red square) on the overlay track.
 * Keyed areas must reveal the BLUE base; the red square must survive. A control
 * export with the key colour set to blue proves the effect is what removed the
 * green — not an unrelated alpha bug. That is the same centre/outside contract
 * the preview's `chroma-key` pass is measured against in the parity harness.
 */
@RunWith(AndroidJUnit4::class)
class ExportChromaKeyInstrumentedTest {
    private lateinit var context: Context
    private lateinit var base: File
    private lateinit var greenScreen: File
    private val outputs = mutableListOf<File>()

    companion object {
        private const val CANVAS = 320
        private const val TICKS_PER_SECOND = 120_000L
        private const val DURATION_TICKS = 144_000L // 1.2s
        private val GREEN = Triple(0, 220, 0)
        private val RED = Triple(230, 0, 0)
        private val BLUE = Triple(0, 0, 200)
    }

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        base = ColorBlockVideoFactory.create(
            File(context.cacheDir, "chroma_base_${System.nanoTime()}.mp4"),
            background = BLUE,
            block = BLUE,
            width = CANVAS,
            height = CANVAS,
            blockLeft = 0,
            blockRight = 0,
            blockTop = 0,
            blockBottom = 0,
        )
        greenScreen = ColorBlockVideoFactory.create(
            File(context.cacheDir, "chroma_fg_${System.nanoTime()}.mp4"),
            background = GREEN,
            block = RED,
            width = CANVAS,
            height = CANVAS,
        )
    }

    @After
    fun tearDown() {
        base.delete()
        greenScreen.delete()
        outputs.forEach { it.delete() }
    }

    private fun asset(id: String, file: File) = EdlAsset(
        assetId = id,
        kind = EdlAssetKind.VIDEO,
        name = file.name,
        sourceUri = file.toURI().toString(),
        codec = null,
        width = CANVAS,
        height = CANVAS,
        durationTicks = DURATION_TICKS,
        rotationDegrees = 0,
        hasAudio = false,
    )

    private fun clip(id: String, assetId: String, effects: List<EdlEffect> = emptyList()) = EdlClip(
        clipId = id,
        kind = "video",
        assetId = assetId,
        name = id,
        startTicks = 0,
        durationTicks = DURATION_TICKS,
        sourceStartTicks = 0,
        sourceEndTicks = DURATION_TICKS,
        speed = EdlRational(1, 1),
        maintainPitch = false,
        volumeDb = 0.0,
        muted = true,
        hidden = false,
        transform = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0),
        opacity = 1.0,
        crop = EdlCrop(),
        effects = effects,
        hasMasks = false,
        animations = emptyList(),
        params = emptyMap(),
    )

    private fun chromaKey(
        keyColor: String = "#00ff00",
        similarity: Double = 45.0,
        softness: Double = 10.0,
        spill: Double = 60.0,
    ) = EdlEffect(
        effectId = "fx-chroma",
        type = "chroma-key",
        enabled = true,
        params = mapOf(
            "keyColor" to keyColor,
            "similarity" to similarity,
            "softness" to softness,
            "spill" to spill,
        ),
    )

    private fun buildEdl(overlayEffects: List<EdlEffect>): Edl {
        val main = EdlTrack(
            trackId = "track-main",
            kind = EdlTrackKind.MAIN,
            trackType = EdlTrackType.VIDEO,
            name = "Main",
            zIndex = 0,
            muted = false,
            hidden = false,
            clips = listOf(clip("base", "asset-base")),
        )
        val overlay = EdlTrack(
            trackId = "track-overlay",
            kind = EdlTrackKind.OVERLAY,
            trackType = EdlTrackType.VIDEO,
            name = "Overlay",
            zIndex = 1,
            muted = false,
            hidden = false,
            clips = listOf(clip("screen", "asset-screen", overlayEffects)),
        )
        return Edl(
            meta = EdlMeta(
                edlVersion = 1,
                generator = "cutlyra-chroma-test",
                ticksPerSecond = TICKS_PER_SECOND,
                frameRate = EdlRational(30, 1),
                canvasWidth = CANVAS,
                canvasHeight = CANVAS,
                projectId = "proj-chroma",
                projectName = "Chroma key",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = DURATION_TICKS,
                background = EdlBackground(),
            ),
            assets = listOf(asset("asset-base", base), asset("asset-screen", greenScreen)),
            tracks = listOf(main, overlay),
            transitions = emptyList(),
            overlays = emptyList(),
            output = EdlOutput(
                container = "mp4",
                videoCodec = "avc1",
                audioCodec = "mp4a",
                bitrate = 4_000_000,
                fps = EdlRational(30, 1),
                resolutionWidth = CANVAS,
                resolutionHeight = CANVAS,
                includeAudio = false,
            ),
        )
    }

    private fun export(edl: Edl, label: String): File {
        val output = File(context.cacheDir, "chroma_${label}_${System.nanoTime()}.mp4")
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

    private fun rgb(frame: Bitmap, x: Int, y: Int): Triple<Int, Int, Int> {
        val color = frame.getPixel(
            x.coerceIn(0, frame.width - 1),
            y.coerceIn(0, frame.height - 1),
        )
        return Triple((color shr 16) and 0xFF, (color shr 8) and 0xFF, color and 0xFF)
    }

    private fun assertBlue(pixel: Triple<Int, Int, Int>, message: String) {
        assertTrue(
            "$message: expected the blue base to show through, was rgb(${pixel.first},${pixel.second},${pixel.third})",
            pixel.third > 110 && pixel.first < 90 && pixel.second < 90,
        )
    }

    private fun assertRed(pixel: Triple<Int, Int, Int>, message: String) {
        assertTrue(
            "$message: expected the red subject to survive, was rgb(${pixel.first},${pixel.second},${pixel.third})",
            pixel.first > 110 && pixel.second < 100 && pixel.third < 100,
        )
    }

    private fun assertGreen(pixel: Triple<Int, Int, Int>, message: String) {
        assertTrue(
            "$message: expected the green screen to still cover the base, was rgb(${pixel.first},${pixel.second},${pixel.third})",
            			// The decoded green screen reads around rgb(3,104,0) after H.264, so
			// "green dominates" is the honest test, not a fixed level.
			pixel.second > 80 && pixel.second > pixel.first + 50 && pixel.second > pixel.third + 50,
        )
    }

    @Test
    fun keyedOverlayRevealsTheLowerVideoLayer() {
        val frame = PatternVideoFactory.frameAt(
            export(buildEdl(listOf(chromaKey())), "keyed"),
            500_000L,
        )
        // Screen corners -> the base video underneath.
        assertBlue(rgb(frame, 40, 40), "top-left screen")
        assertBlue(rgb(frame, 280, 280), "bottom-right screen")
        // The red subject in the middle is untouched by the key.
        assertRed(rgb(frame, 160, 160), "red subject")
    }

    @Test
    fun withoutTheKeyTheGreenScreenCoversTheBase() {
        val frame = PatternVideoFactory.frameAt(
            export(buildEdl(emptyList()), "control"),
            500_000L,
        )
        assertGreen(rgb(frame, 40, 40), "unkeyed screen")
        assertRed(rgb(frame, 160, 160), "unkeyed subject")
    }

    @Test
    fun keyingTheWrongColourLeavesTheScreenAlone() {
        // A blue key cannot remove a green screen: the control proves the
        // transparency above comes from THIS colour, not from an alpha bug.
        val frame = PatternVideoFactory.frameAt(
            export(buildEdl(listOf(chromaKey(keyColor = "#0000ff"))), "wrong-key"),
            500_000L,
        )
        assertGreen(rgb(frame, 40, 40), "screen with a blue key")
        assertRed(rgb(frame, 160, 160), "subject with a blue key")
    }
}
