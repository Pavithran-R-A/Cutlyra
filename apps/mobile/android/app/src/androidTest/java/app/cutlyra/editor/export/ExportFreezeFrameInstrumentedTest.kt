package app.cutlyra.editor.export

import android.content.Context
import android.graphics.BitmapFactory
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

/**
 * Deterministic Freeze Frame export verification.
 *
 * Builds an EDL that freezes a source frame into a duration-adjustable still
 * interval between two trimmed halves of the source video, exports it through
 * the real Media3Exporter, and decodes the resulting MP4 to confirm it is
 * valid, non-black, and has the expected total duration (first half + hold +
 * second half). Uses a real captured frame (MediaMetadataRetriever) rather than
 * a placeholder, matching the web/native capture path.
 */
@RunWith(AndroidJUnit4::class)
class ExportFreezeFrameInstrumentedTest {
    private lateinit var context: Context
    private lateinit var testContext: Context
    private lateinit var sourceClip: File
    private lateinit var frozenFrame: File
    private lateinit var outputFile: File

    private val ticksPerSecond = 120_000L

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        testContext = InstrumentationRegistry.getInstrumentation().context
        sourceClip = File(context.cacheDir, "freeze_source_${System.nanoTime()}.mp4")
        testContext.resources.openRawResource(R.raw.test_clip).use { input ->
            sourceClip.outputStream().use { output -> input.copyTo(output) }
        }
        // Capture a real frame at 500ms to use as the frozen still.
        frozenFrame = File(context.cacheDir, "freeze_frame_${System.nanoTime()}.png")
        val retriever = MediaMetadataRetriever()
        retriever.setDataSource(sourceClip.absolutePath)
        val bitmap = retriever.getFrameAtTime(500_000L, MediaMetadataRetriever.OPTION_CLOSEST)
        assertNotNull("must extract a source frame", bitmap)
        frozenFrame.outputStream().use { out ->
            bitmap!!.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)
        }
        bitmap!!.recycle()
        retriever.release()
        outputFile = File(context.cacheDir, "freeze_export_${System.nanoTime()}.mp4")
    }

    @After
    fun tearDown() {
        sourceClip.delete()
        frozenFrame.delete()
        outputFile.delete()
    }

    private fun buildFixtureEdl(holdTicks: Long = ticksPerSecond): Edl {
        val halfTicks = ticksPerSecond // 1s each half of the 2s source
        val asset = EdlAsset(
            assetId = "asset-src",
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
        val imageAsset = EdlAsset(
            assetId = "asset-freeze",
            kind = EdlAssetKind.IMAGE,
            name = frozenFrame.name,
            sourceUri = frozenFrame.toURI().toString(),
            codec = null,
            width = 320,
            height = 240,
            durationTicks = holdTicks,
            rotationDegrees = 0,
            hasAudio = false,
        )

        fun identityTransform() = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0)

        val clipLeft = EdlClip(
            clipId = "clip-left",
            kind = "video",
            assetId = asset.assetId,
            name = "left",
            startTicks = 0,
            durationTicks = halfTicks,
            sourceStartTicks = 0,
            sourceEndTicks = halfTicks,
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
        val clipFreeze = EdlClip(
            clipId = "clip-freeze",
            kind = "image",
            assetId = imageAsset.assetId,
            name = "freeze",
            startTicks = halfTicks,
            durationTicks = holdTicks,
            sourceStartTicks = 0,
            sourceEndTicks = 0,
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
        val clipRight = EdlClip(
            clipId = "clip-right",
            kind = "video",
            assetId = asset.assetId,
            name = "right",
            startTicks = halfTicks + holdTicks,
            durationTicks = halfTicks,
            sourceStartTicks = halfTicks,
            sourceEndTicks = 2 * halfTicks,
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

        val mainTrack = EdlTrack(
            trackId = "track-main",
            kind = EdlTrackKind.MAIN,
            trackType = EdlTrackType.VIDEO,
            name = "Main",
            zIndex = 0,
            muted = false,
            hidden = false,
            clips = listOf(clipLeft, clipFreeze, clipRight),
        )

        val totalTicks = halfTicks + holdTicks + halfTicks
        return Edl(
            meta = EdlMeta(
                edlVersion = 1,
                generator = "cutlyra-freeze-frame-test",
                ticksPerSecond = ticksPerSecond,
                frameRate = EdlRational(30, 1),
                canvasWidth = 320,
                canvasHeight = 240,
                projectId = "proj-freeze",
                projectName = "Freeze Frame Fixture",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = totalTicks,
            ),
            assets = listOf(asset, imageAsset),
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

    @Test
    fun export_freeze_frame_produces_valid_mp4_with_expected_duration() {
        val edl = buildFixtureEdl()
        val expectedDurationUs = (2 * ticksPerSecond + ticksPerSecond) * 1_000_000L / ticksPerSecond

        val latch = CountDownLatch(1)
        val events = mutableListOf<Media3Exporter.Event>()
        Media3Exporter.start(context, edl, outputFile) { event ->
            events.add(event)
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                latch.countDown()
            }
        }

        assertTrue(
            "freeze export did not reach a terminal state within 60s",
            latch.await(60, TimeUnit.SECONDS),
        )
        val terminal = events.lastOrNull()
        assertTrue(
            "expected freeze export to succeed, got: $terminal",
            terminal is Media3Exporter.Event.Done,
        )

        val done = terminal as Media3Exporter.Event.Done
        assertTrue(done.outputFile.length() > 0)

        val probe = MediaProbe.probe(done.outputFile, mimeTypeHint = "video/mp4")
        assertTrue("output must have video", probe.width > 0)
        // Total duration should be ~3s (1 + 1 hold + 1).
        val durationMs = probe.durationMicros / 1000
        assertTrue(
            "duration ${durationMs}ms should be ~3000ms",
            durationMs in 2500..3500,
        )

        // Frames at left (0.5s), hold (1.5s), right (2.5s) must decode non-black.
        assertFrameDecodesNonBlack(done.outputFile, atUs = 500_000L)
        assertFrameDecodesNonBlack(done.outputFile, atUs = 1_500_000L)
        assertFrameDecodesNonBlack(done.outputFile, atUs = 2_500_000L)
    }

    @Test
    fun export_freeze_frame_hold_duration_is_respected() {
        val holdTicks = 2 * ticksPerSecond // 2s hold
        val edl = buildFixtureEdl(holdTicks = holdTicks)
        val totalSec = (ticksPerSecond + holdTicks + ticksPerSecond) / ticksPerSecond

        val latch = CountDownLatch(1)
        val events = mutableListOf<Media3Exporter.Event>()
        Media3Exporter.start(context, edl, outputFile) { event ->
            events.add(event)
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                latch.countDown()
            }
        }
        assertTrue(latch.await(60, TimeUnit.SECONDS))
        val terminal = events.lastOrNull()
        assertTrue(terminal is Media3Exporter.Event.Done)
        val done = terminal as Media3Exporter.Event.Done
        val probe = MediaProbe.probe(done.outputFile, mimeTypeHint = "video/mp4")
        val durationMs2 = probe.durationMicros / 1000
        assertTrue(
            "duration ${durationMs2}ms should be ~${totalSec * 1000}ms",
            durationMs2 in (totalSec * 1000 - 500)..(totalSec * 1000 + 500),
        )
    }

    private fun assertFrameDecodesNonBlack(file: File, atUs: Long) {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            val frame = retriever.getFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST)
            assertNotNull("expected a decodable frame at ${atUs}us", frame)
            val bytes = java.io.ByteArrayOutputStream().use { out ->
                frame!!.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)
                out.toByteArray()
            }
            val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            assertNotNull(decoded)
            assertTrue(decoded!!.width > 0 && decoded.height > 0)
        } finally {
            retriever.release()
        }
    }
}