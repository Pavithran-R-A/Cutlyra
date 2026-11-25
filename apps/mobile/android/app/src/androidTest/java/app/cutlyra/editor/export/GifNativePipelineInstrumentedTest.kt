package app.cutlyra.editor.export

import android.content.Context
import android.graphics.BitmapFactory
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cutlyra.editor.edl.Edl
import app.cutlyra.editor.edl.EdlAsset
import app.cutlyra.editor.edl.EdlAssetKind
import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlEffect
import app.cutlyra.editor.edl.EdlGifAsset
import app.cutlyra.editor.edl.EdlGifFrame
import app.cutlyra.editor.edl.EdlMeta
import app.cutlyra.editor.edl.EdlOutput
import app.cutlyra.editor.edl.EdlRational
import app.cutlyra.editor.edl.EdlTrack
import app.cutlyra.editor.edl.EdlTrackKind
import app.cutlyra.editor.edl.EdlTrackType
import app.cutlyra.editor.edl.EdlTransform
import app.cutlyra.editor.media.MediaProbe
import app.cutlyra.editor.media.gif.GifAssetPreparer
import app.cutlyra.editor.media.gif.GifDecoder
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
 * Deterministic native GIF verification.
 *
 * Builds a real animated GIF on-device (solid RED / GREEN / BLUE frames at
 * declared delays), decodes it through the SAME native decoder the importer
 * uses, writes its frames as PNGs into media custody, drives a real
 * `Media3Exporter` EDL export, and decodes the MP4 at known timestamps to
 * assert the colour sequence, per-frame timing, loop/hold behaviour, trim
 * mapping and per-frame filters/transforms.
 *
 * This is the native counterpart of `ExportFreezeFrameInstrumentedTest`: the
 * assertions are on actual decoded pixels, not "some frame exists".
 */
@RunWith(AndroidJUnit4::class)
class GifNativePipelineInstrumentedTest {
    private lateinit var context: Context
    private lateinit var workDir: File
    private lateinit var outputFile: File

    private val ticksPerSecond = 120_000L
    private val gifWidth = 320
    private val gifHeight = 240

    /** ms -> EDL ticks (1 ms = 120 ticks at the repo's 120000 tps). */
    private fun ms(value: Long): Long = value * ticksPerSecond / 1000

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        workDir = File(context.cacheDir, "gif_native_${System.nanoTime()}").apply { mkdirs() }
        outputFile = File(workDir, "gif_export.mp4")
    }

    @After
    fun tearDown() {
        workDir.deleteRecursively()
    }

    private fun writeGif(
        indices: List<Int>,
        delaysMs: List<Int>,
        loopCount: Int,
        name: String = "fixture.gif",
    ): File {
        val bytes = TestGifEncoder.encodeSolidFrames(
            width = gifWidth,
            height = gifHeight,
            framePaletteIndices = indices,
            frameDelaysMs = delaysMs,
            loopCount = loopCount,
        )
        return File(workDir, name).apply { writeBytes(bytes) }
    }

    private fun prepare(gifFile: File): GifAssetPreparer.PreparedGif =
        GifAssetPreparer.prepareFromFile(
            gifFile = gifFile,
            outputRoot = workDir,
            assetId = "gif-asset",
        )

    private fun buildEdl(
        gifFile: File,
        prepared: GifAssetPreparer.PreparedGif,
        clipDurationMs: Long,
        sourceStartMs: Long = 0,
        effects: List<EdlEffect> = emptyList(),
        scale: Double = 1.0,
    ): Edl {
        val asset = EdlAsset(
            assetId = "gif-asset",
            kind = EdlAssetKind.IMAGE,
            name = gifFile.name,
            sourceUri = gifFile.toURI().toString(),
            codec = null,
            width = prepared.width,
            height = prepared.height,
            durationTicks = ms(prepared.totalDurationMs.toLong()),
            rotationDegrees = 0,
            hasAudio = false,
            gif = EdlGifAsset(
                loopCount = prepared.loopCount,
                frames = prepared.frames.map { frame ->
                    EdlGifFrame(
                        uri = File(workDir, frame.relativePath).toURI().toString(),
                        durationTicks = ms(frame.delayMs.toLong()),
                    )
                },
            ),
        )
        val clip = EdlClip(
            clipId = "clip-gif",
            kind = "image",
            assetId = asset.assetId,
            name = "gif",
            startTicks = 0,
            durationTicks = ms(clipDurationMs),
            sourceStartTicks = ms(sourceStartMs),
            sourceEndTicks = ms(sourceStartMs + clipDurationMs),
            speed = EdlRational(1, 1),
            maintainPitch = false,
            volumeDb = 0.0,
            muted = false,
            hidden = false,
            transform = EdlTransform(
                positionX = 0.0,
                positionY = 0.0,
                scaleX = scale,
                scaleY = scale,
                rotateDegrees = 0.0,
            ),
            opacity = 1.0,
            effects = effects,
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
                generator = "cutlyra-gif-native-test",
                ticksPerSecond = ticksPerSecond,
                frameRate = EdlRational(30, 1),
                canvasWidth = gifWidth,
                canvasHeight = gifHeight,
                projectId = "proj-gif",
                projectName = "GIF Fixture",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = ms(clipDurationMs),
            ),
            assets = listOf(asset),
            tracks = listOf(track),
            transitions = emptyList(),
            overlays = emptyList(),
            output = EdlOutput(
                container = "mp4",
                videoCodec = "avc1",
                audioCodec = "mp4a",
                bitrate = 4_000_000,
                fps = EdlRational(30, 1),
                resolutionWidth = gifWidth,
                resolutionHeight = gifHeight,
                includeAudio = false,
            ),
        )
    }

    private fun export(edl: Edl): File {
        val latch = CountDownLatch(1)
        val events = mutableListOf<Media3Exporter.Event>()
        Media3Exporter.start(context, edl, outputFile) { event ->
            events.add(event)
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                latch.countDown()
            }
        }
        assertTrue("GIF export did not finish within 90s", latch.await(90, TimeUnit.SECONDS))
        val terminal = events.lastOrNull()
        assertTrue("expected GIF export to succeed, got: $terminal", terminal is Media3Exporter.Event.Done)
        return (terminal as Media3Exporter.Event.Done).outputFile
    }

    private fun assertColor(file: File, atMs: Long, expected: String) {
        val actual = SolidColorVideoFactory.dominantChannelAt(file, atUs = atMs * 1000)
        assertTrue(
            "frame at ${atMs}ms should be $expected, dominant channel was $actual " +
                "(${SolidColorVideoFactory.centerPixelAt(file, atUs = atMs * 1000)})",
            actual == expected,
        )
    }

    @Test
    fun decoder_reports_gif_frames_delays_loop_count_and_pixels() {
        val gif = writeGif(
            indices = listOf(TestGifEncoder.RED, TestGifEncoder.GREEN, TestGifEncoder.BLUE),
            delaysMs = listOf(200, 300, 500),
            loopCount = 0,
        )

        val decoded = GifDecoder.decode(gif.readBytes())

        assertEquals(gifWidth, decoded.width)
        assertEquals(gifHeight, decoded.height)
        assertEquals(0, decoded.loopCount)
        assertEquals(listOf(200, 300, 500), decoded.frames.map { it.delayMs })
        assertEquals(1000, decoded.totalDurationMs)
        // First pixel of each frame is the frame's colour.
        assertEquals(0xFFFF0000.toInt(), decoded.frames[0].pixels[0])
        assertEquals(0xFF00FF00.toInt(), decoded.frames[1].pixels[0])
        assertEquals(0xFF0000FF.toInt(), decoded.frames[2].pixels[0])
    }

    @Test
    fun preparer_writes_one_decodable_png_per_frame() {
        val gif = writeGif(
            indices = listOf(TestGifEncoder.RED, TestGifEncoder.GREEN, TestGifEncoder.BLUE),
            delaysMs = listOf(200, 300, 500),
            loopCount = 0,
        )

        val prepared = prepare(gif)

        assertEquals(3, prepared.frames.size)
        assertEquals(listOf(200, 300, 500), prepared.frames.map { it.delayMs })
        val expected = listOf(0xFFFF0000.toInt(), 0xFF00FF00.toInt(), 0xFF0000FF.toInt())
        prepared.frames.forEachIndexed { index, frame ->
            val png = File(workDir, frame.relativePath)
            assertTrue("frame PNG must exist: ${frame.relativePath}", png.isFile)
            val bitmap = BitmapFactory.decodeFile(png.absolutePath)
            assertTrue("frame PNG must decode", bitmap != null)
            assertEquals(expected[index], bitmap!!.getPixel(0, 0))
            bitmap.recycle()
        }
    }

    @Test
    fun export_plays_frames_in_order_with_their_delays_and_loops() {
        val gif = writeGif(
            indices = listOf(TestGifEncoder.RED, TestGifEncoder.GREEN, TestGifEncoder.BLUE),
            delaysMs = listOf(200, 300, 500),
            loopCount = 0, // endless
        )
        val prepared = prepare(gif)
        // 2s clip over a 1s GIF => red,green,blue,red,green,blue (last blue
        // truncated at 2s).
        val edl = buildEdl(gif, prepared, clipDurationMs = 2_000)

        val output = export(edl)
        val probe = MediaProbe.probe(output, mimeTypeHint = "video/mp4")
        assertTrue(
            "export duration ${probe.durationMicros}us should be ~2s",
            abs(probe.durationMicros - 2_000_000L) < 300_000L,
        )

        assertColor(output, 100, "red") // 0.0-0.2s
        assertColor(output, 350, "green") // 0.2-0.5s
        assertColor(output, 750, "blue") // 0.5-1.0s
        assertColor(output, 1_100, "red") // loop 2: 1.0-1.2s
        assertColor(output, 1_350, "green") // 1.2-1.5s
        assertColor(output, 1_750, "blue") // 1.5-2.0s
    }

    @Test
    fun export_honours_trim_and_holds_the_last_frame_of_a_finite_gif() {
        val gif = writeGif(
            indices = listOf(TestGifEncoder.RED, TestGifEncoder.GREEN, TestGifEncoder.BLUE),
            delaysMs = listOf(200, 300, 500),
            loopCount = 1, // play exactly once
            name = "finite.gif",
        )
        val prepared = prepare(gif)
        // Trim 200ms in => starts on GREEN; 900ms clip => green 300ms, blue
        // 500ms, then the last frame held for the final 100ms.
        val edl = buildEdl(gif, prepared, clipDurationMs = 900, sourceStartMs = 200)

        val output = export(edl)
        assertColor(output, 100, "green")
        assertColor(output, 400, "blue")
        assertColor(output, 600, "blue")
        assertColor(output, 850, "blue") // held, NOT wrapped back to red
    }

    @Test
    fun export_applies_colour_filters_to_each_gif_frame() {
        val gif = writeGif(
            indices = listOf(TestGifEncoder.RED, TestGifEncoder.GREEN, TestGifEncoder.BLUE),
            delaysMs = listOf(200, 300, 500),
            loopCount = 1,
            name = "filtered.gif",
        )
        val prepared = prepare(gif)
        val mono = EdlEffect(
            effectId = "fx-mono",
            type = "adjust",
            enabled = true,
            params = mapOf("saturation" to -100.0),
        )
        val edl = buildEdl(gif, prepared, clipDurationMs = 1_000, effects = listOf(mono))

        val output = export(edl)
        // Every frame is grey (filter applied per frame), and the frames stay
        // distinguishable by luminance: green > red > blue.
        val red = SolidColorVideoFactory.centerPixelAt(output, atUs = 100_000L)
        val green = SolidColorVideoFactory.centerPixelAt(output, atUs = 350_000L)
        val blue = SolidColorVideoFactory.centerPixelAt(output, atUs = 750_000L)
        for ((name, pixel) in listOf("red" to red, "green" to green, "blue" to blue)) {
            val (r, g, b) = pixel
            assertTrue(
                "$name frame must be greyscale after saturation -100, got $pixel",
                abs(r - g) <= 24 && abs(g - b) <= 24,
            )
        }
        val luminance = { p: Triple<Int, Int, Int> -> (p.first + p.second + p.third) / 3 }
        assertTrue(
            "filtered green frame must be brighter than red ($green vs $red)",
            luminance(green) > luminance(red) + 20,
        )
        assertTrue(
            "filtered red frame must be brighter than blue ($red vs $blue)",
            luminance(red) > luminance(blue) + 20,
        )
    }

    @Test
    fun export_applies_transforms_to_each_gif_frame() {
        val gif = writeGif(
            indices = listOf(TestGifEncoder.RED, TestGifEncoder.GREEN, TestGifEncoder.BLUE),
            delaysMs = listOf(200, 300, 500),
            loopCount = 1,
            name = "scaled.gif",
        )
        val prepared = prepare(gif)
        val edl = buildEdl(gif, prepared, clipDurationMs = 1_000, scale = 0.5)

        val output = export(edl)
        assertColor(output, 100, "red")
        assertColor(output, 350, "green")
        // A per-frame 0.5-scale transform leaves the corners on the black base.
        val corner = SolidColorVideoFactory.pixelAt(
            output,
            atUs = 100_000L,
            xFraction = 0.03,
            yFraction = 0.03,
        )
        assertTrue(
            "scaled GIF frame must not reach the canvas corner, got $corner",
            corner.first < 60 && corner.second < 60 && corner.third < 60,
        )
    }
}
