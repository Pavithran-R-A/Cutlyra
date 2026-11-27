package app.cutlyra.editor.export

import android.content.Context
import android.graphics.Bitmap
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cutlyra.editor.edl.Edl
import app.cutlyra.editor.edl.EdlAnimationChannel
import app.cutlyra.editor.edl.EdlAsset
import app.cutlyra.editor.edl.EdlAssetKind
import app.cutlyra.editor.edl.EdlBackground
import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlCrop
import app.cutlyra.editor.edl.EdlKeyframe
import app.cutlyra.editor.edl.EdlMask
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
 * Masks proven on DECODED MP4 pixels.
 *
 * Every fixture is a solid bright foreground (luma 235) over a solid dark
 * background (luma 16), both deterministic H.264 clips. The overlay is masked;
 * where the mask is opaque the decoded frame is bright, where it is cut away
 * the base clip shows through as dark, and a feathered edge lands between the
 * two. That is the same centre/edge/feather/outside contract the preview mask
 * has, measured after Media3 encoding and decoding rather than from a unit
 * test.
 */
@RunWith(AndroidJUnit4::class)
class ExportMaskInstrumentedTest {
    private lateinit var context: Context
    private lateinit var background: File
    private lateinit var foreground: File
    private val outputs = mutableListOf<File>()

    companion object {
        private const val CANVAS = 320
        private const val TICKS_PER_SECOND = 120_000L
        private const val DURATION_TICKS = 144_000L // 1.2s
        private const val LENGTH_TICKS = 144_000L
        private const val DARK = 16
        private const val BRIGHT = 235
    }

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        background = PatternVideoFactory.create(
            File(context.cacheDir, "mask_bg_${System.nanoTime()}.mp4"),
            width = CANVAS,
            height = CANVAS,
            durationUs = 1_200_000L,
            brightLuma = DARK,
            darkLuma = DARK,
        )
        foreground = PatternVideoFactory.create(
            File(context.cacheDir, "mask_fg_${System.nanoTime()}.mp4"),
            width = CANVAS,
            height = CANVAS,
            durationUs = 1_200_000L,
            brightLuma = BRIGHT,
            darkLuma = BRIGHT,
        )
    }

    @After
    fun tearDown() {
        background.delete()
        foreground.delete()
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

    private fun clip(
        id: String,
        assetId: String,
        transform: EdlTransform = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0),
        opacity: Double = 1.0,
        crop: EdlCrop = EdlCrop(),
        mask: EdlMask? = null,
        animations: List<EdlAnimationChannel> = emptyList(),
    ) = EdlClip(
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
        transform = transform,
        opacity = opacity,
        crop = crop,
        effects = emptyList(),
        hasMasks = mask != null,
        masks = listOfNotNull(mask),
        animations = animations,
        params = emptyMap(),
    )

    private fun mask(type: String, params: Map<String, Any?>) = EdlMask("mask-1", type, params)

    private fun box(
        type: String,
        centerX: Double = 0.0,
        centerY: Double = 0.0,
        width: Double = 0.5,
        height: Double = 0.5,
        rotation: Double = 0.0,
        feather: Double = 0.0,
        inverted: Boolean = false,
    ) = mask(
        type,
        mapOf(
            "centerX" to centerX,
            "centerY" to centerY,
            "width" to width,
            "height" to height,
            "rotation" to rotation,
            "feather" to feather,
            "inverted" to inverted,
            "strokeWidth" to 0,
        ),
    )

    private fun buildEdl(overlays: List<EdlClip>, mainAssetId: String = "asset-bg"): Edl {
        val bg = asset("asset-bg", background)
        val fg = asset("asset-fg", foreground)
        val main = EdlTrack(
            trackId = "track-main",
            kind = EdlTrackKind.MAIN,
            trackType = EdlTrackType.VIDEO,
            name = "Main",
            zIndex = 0,
            muted = false,
            hidden = false,
            clips = listOf(clip("main", mainAssetId)),
        )
        val overlayTracks = overlays.mapIndexed { index, overlay ->
            EdlTrack(
                trackId = "track-overlay-$index",
                kind = EdlTrackKind.OVERLAY,
                trackType = EdlTrackType.VIDEO,
                name = "Overlay $index",
                zIndex = index + 1,
                muted = false,
                hidden = false,
                clips = listOf(overlay),
            )
        }
        return Edl(
            meta = EdlMeta(
                edlVersion = 1,
                generator = "cutlyra-mask-test",
                ticksPerSecond = TICKS_PER_SECOND,
                frameRate = EdlRational(30, 1),
                canvasWidth = CANVAS,
                canvasHeight = CANVAS,
                projectId = "proj-mask",
                projectName = "Masks",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = DURATION_TICKS,
                background = EdlBackground(),
            ),
            assets = listOf(bg, fg),
            tracks = listOf(main) + overlayTracks,
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
        val output = File(context.cacheDir, "mask_${label}_${System.nanoTime()}.mp4")
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

    private fun luma(frame: Bitmap, x: Int, y: Int): Int {
        val color = frame.getPixel(
            x.coerceIn(0, frame.width - 1),
            y.coerceIn(0, frame.height - 1),
        )
        val r = (color shr 16) and 0xFF
        val g = (color shr 8) and 0xFF
        val b = color and 0xFF
        return (r * 299 + g * 587 + b * 114) / 1000
    }

    private fun assertBright(value: Int, message: String) {
        assertTrue("$message: expected bright (>=180) but was $value", value >= 180)
    }

    private fun assertDark(value: Int, message: String) {
        assertTrue("$message: expected base to show through (<=70) but was $value", value <= 70)
    }

    @Test
    fun unmaskedFixturesAreActuallyVisible() {
        val baseFrame = PatternVideoFactory.frameAt(
            export(buildEdl(emptyList()), "base-only"),
            500_000L,
        )
        val plainOverlay = clip(id = "plain", assetId = "asset-fg")
        val overlayFrame = PatternVideoFactory.frameAt(
            export(buildEdl(listOf(plainOverlay)), "plain-overlay"),
            500_000L,
        )
        val brightMainFrame = PatternVideoFactory.frameAt(
            export(buildEdl(emptyList(), mainAssetId = "asset-fg"), "bright-main"),
            500_000L,
        )
        val maskedIdentity = clip(
            id = "masked-identity",
            assetId = "asset-fg",
            mask = box("rectangle"),
        )
        val maskedFrame = PatternVideoFactory.frameAt(
            export(buildEdl(listOf(maskedIdentity)), "masked-identity"),
            500_000L,
        )
        val base = luma(baseFrame, 160, 160)
        val overlay = luma(overlayFrame, 160, 160)
        val brightMain = luma(brightMainFrame, 160, 160)
        assertDark(base, "base fixture")
        assertBright(brightMain, "bright main fixture")
        assertBright(overlay, "unmasked overlay")
    }

    @Test
    fun rectangleEllipseAndCircle_cutAlphaOverTheBaseVideo() {
        // Three overlays in separate quadrants; each mask is 0.5 of the
        // 320px element, so centres are at (80,80), (240,80), (80,240).
        val rect = clip(
            id = "rect",
            assetId = "asset-fg",
            transform = EdlTransform(-80.0, -80.0, 1.0, 1.0, 0.0),
            mask = box("rectangle"),
        )
        val ellipse = clip(
            id = "ellipse",
            assetId = "asset-fg",
            transform = EdlTransform(80.0, -80.0, 1.0, 1.0, 0.0),
            mask = box("ellipse", width = 0.4, height = 0.4),
        )
        val circle = clip(
            id = "circle",
            assetId = "asset-fg",
            transform = EdlTransform(-80.0, 80.0, 1.0, 1.0, 0.0),
            mask = box("circle", width = 0.4),
        )
        val rectFrame = PatternVideoFactory.frameAt(
            export(buildEdl(listOf(rect)), "rect"),
            1_000_000L,
        )
        assertBright(luma(rectFrame, 80, 80), "rectangle centre")
        assertDark(luma(rectFrame, 170, 80), "rectangle outside")

        val ellipseFrame = PatternVideoFactory.frameAt(
            export(buildEdl(listOf(ellipse)), "ellipse"),
            1_000_000L,
        )
        assertBright(luma(ellipseFrame, 240, 80), "ellipse centre")
        assertDark(luma(ellipseFrame, 240, 170), "ellipse outside")

        val circleFrame = PatternVideoFactory.frameAt(
            export(buildEdl(listOf(circle)), "circle"),
            1_000_000L,
        )
        assertBright(luma(circleFrame, 80, 240), "circle centre")
        assertDark(luma(circleFrame, 160, 240), "circle outside")
    }

    @Test
    fun linearMaskKeepsOneHalfPlaneAndFeathersTheCut() {
        // rotation 0 => fill the right half of the canvas; feather 40px.
        val linear = clip(
            id = "linear",
            assetId = "asset-fg",
            mask = mask(
                "linear",
                mapOf(
                    "centerX" to 0.0,
                    "centerY" to 0.0,
                    "rotation" to 0.0,
                    "feather" to 40.0,
                    "inverted" to false,
                    "strokeWidth" to 0,
                ),
            ),
        )
        val frame = PatternVideoFactory.frameAt(
            export(buildEdl(listOf(linear)), "linear"),
            1_000_000L,
        )

        assertDark(luma(frame, 60, 160), "left of the half-plane")
        assertBright(luma(frame, 260, 160), "right of the half-plane")
        val edge = luma(frame, 160, 160)
        assertTrue("feather midpoint should be around mid-grey, was $edge", edge in 85..175)
    }

    @Test
    fun rotatedFeatheredInvertedRectangleCutsTheCentreAndKeepsTheCorners() {
        val inverted = clip(
            id = "inverted",
            assetId = "asset-fg",
            mask = box(
                "rectangle",
                width = 0.6,
                height = 0.4,
                rotation = 30.0,
                feather = 40.0,
                inverted = true,
            ),
        )
        val frame = PatternVideoFactory.frameAt(
            export(buildEdl(listOf(inverted)), "inverted"),
            1_000_000L,
        )

        assertDark(luma(frame, 160, 160), "inverted centre")
        assertBright(luma(frame, 8, 8), "inverted corner")
        // The rotated long edge is 96px from the centre along 30°:
        // (160 + 96*cos30, 160 + 96*sin30) = (243, 208), the feather midpoint.
        val edge = luma(frame, 243, 208)
        assertTrue("rotated feather midpoint should be around mid-grey, was $edge", edge in 75..185)
    }

    @Test
    fun centreYIsMeasuredFromTheTopOfTheFrame() {
        // Unmoved full-frame overlay; the mask sits a quarter of the frame
        // BELOW centre with half-height 0.1. If the shader's y ran bottom-up,
        // the bright band would appear above centre instead.
        val overlay = clip(
            id = "offset-y",
            assetId = "asset-fg",
            mask = box("rectangle", centerY = 0.25, width = 0.5, height = 0.2),
        )
        val frame = PatternVideoFactory.frameAt(
            export(buildEdl(listOf(overlay)), "offset-y"),
            1_000_000L,
        )
        val below = luma(frame, 160, 240)
        val above = luma(frame, 160, 80)
        assertBright(below, "mask centre below the frame centre")
        assertDark(above, "mirrored position above the frame centre")
    }

    @Test
    fun maskComposesWithCropTransformOpacityAndKeyframes() {
        // Keyframed positionX 0 -> 100 over the clip; base scale 0.5; crop keeps
        // the left half of the source; opacity 0.7. At 1s the element centre is
        // ~243px, the mask spans 40px around it (0.5 of the 80px-wide crop).
        val position = listOf(
            EdlAnimationChannel(
                propertyPath = "transform.positionX",
                componentKey = null,
                extrapolationBefore = "hold",
                extrapolationAfter = "hold",
                keyframes = listOf(
                    EdlKeyframe("k0", 0L, 0.0, "linear", null, null),
                    EdlKeyframe("k1", LENGTH_TICKS, 100.0, "linear", null, null),
                ),
            ),
        )
        val overlay = clip(
            id = "animated",
            assetId = "asset-fg",
            transform = EdlTransform(0.0, 0.0, 0.5, 0.5, 0.0),
            opacity = 0.7,
            crop = EdlCrop(x = 0.0, y = 0.0, width = 0.5, height = 1.0),
            mask = box("rectangle", width = 0.5, height = 0.5),
            animations = position,
        )
        val frame = PatternVideoFactory.frameAt(
            export(buildEdl(listOf(overlay)), "combined"),
            1_000_000L,
        )

        // The cropped 160x320 frame at 0.5x is an 80x160 quad at the animated
        // position; the 0.5-of-element mask is the middle 40x80 of it, which
        // measured as the bright band x 180..220, y 120..200 on decoded frames.
        val centre = luma(frame, 200, 160)
        // 0.7 * bright over the dark base.
        assertTrue("animated/cropped mask centre should be blended bright, was $centre", centre in 120..215)
        assertDark(luma(frame, 40, 160), "outside the transformed mask")
        assertDark(luma(frame, 170, 160), "inside the element, left of the mask")
        assertDark(luma(frame, 200, 226), "inside the element, below the mask")
    }
}
