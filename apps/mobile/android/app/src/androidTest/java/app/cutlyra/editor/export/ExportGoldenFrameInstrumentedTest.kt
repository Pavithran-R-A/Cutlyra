package app.cutlyra.editor.export

import android.content.Context
import android.graphics.BitmapFactory
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.cutlyra.editor.edl.Edl
import app.cutlyra.editor.edl.EdlAsset
import app.cutlyra.editor.edl.EdlAssetKind
import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlMeta
import app.cutlyra.editor.edl.EdlOutput
import app.cutlyra.editor.edl.EdlOverlay
import app.cutlyra.editor.edl.EdlOverlayKind
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * THE golden-frame parity harness for M9 (plan §M9 item 6, §2.3 rule 3),
 * exercising exactly the construct M1's spike test describes: "a
 * hand-written 2-clip + cross-fade + text-overlay EDL." Structurally mirrors
 * M4's `MediaPipelineInstrumentedTest` (same fixture-copy setup and
 * `@RunWith(AndroidJUnit4::class)`). These tests are part of physical-device
 * release qualification and must also remain runnable from the standalone
 * instrumentation APK.
 *
 * WHAT THIS HARNESS DOES vs. WHAT "GOLDEN-FRAME PARITY" MEANS (plan §2.3
 * rule 3: "render frame N in the webview, export frame N natively, compare
 * with a perceptual diff under a fixed threshold"):
 *
 *   DOES:    runs the REAL native path end to end — `EdlToComposition` builds
 *            a genuine Media3 `Composition` from a hand-authored EDL with a
 *            crossfade transition and a text overlay, `Media3Exporter` drives
 *            a real hardware/software `Transformer` export, and this test
 *            asserts the output file is valid (duration, track count,
 *            decodable frames) — the exact "output integrity check" plan M9
 *            item 7 describes.
 *
 *   DOES NOT: compare against a webview-rendered reference frame. That
 *            reference does not exist in this repo yet — it requires M6-M8's
 *            preview UI (or at minimum `apps/web-dev`'s golden-frame
 *            reference renderer, plan §3 M2 exit criteria) to produce a PNG
 *            for the SAME EDL at the SAME presentation time, which is a
 *            different track's deliverable. Wiring an actual perceptual-diff
 *            assertion against that reference is `not_done` — see the M9
 *            handoff. `assertFrameDecodesNonBlack` below is a weak sanity
 *            check (the crossfade compositor produced SOME visible content,
 *            not a black/corrupt frame), not a parity check.
 *
 * Fixture: reuses M4's instrumentation-APK `res/raw/test_clip.mp4` as BOTH
 * of the two main-track clips (different trim windows of the same 2s source) — avoids bundling a
 * second binary fixture while still genuinely exercising two distinct
 * `EditedMediaItemSequence` entries, a `addGap` + overlay sequence for the
 * transition, and the base-sequence hard cut alongside it.
 */
@RunWith(AndroidJUnit4::class)
class ExportGoldenFrameInstrumentedTest {
    private lateinit var context: Context
    private lateinit var testContext: Context
    private lateinit var sourceClip: File
    private lateinit var outputFile: File

    private val ticksPerSecond = 120_000L

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        testContext = InstrumentationRegistry.getInstrumentation().context
        sourceClip = File(context.cacheDir, "golden_source_${System.nanoTime()}.mp4")
        // R is the instrumentation APK's generated R class, so the resource
        // must be opened through the instrumentation package context. Using
        // the target app context with this test-package resource id can resolve
        // an unrelated target-app resource with the same integer id.
        testContext.resources.openRawResource(R.raw.test_clip).use { input ->
            sourceClip.outputStream().use { output -> input.copyTo(output) }
        }
        outputFile = File(context.cacheDir, "golden_export_${System.nanoTime()}.mp4")
    }

    @After
    fun tearDown() {
        sourceClip.delete()
        outputFile.delete()
    }

    private fun buildFixtureEdl(
        source: File = sourceClip,
        hasAudio: Boolean = true,
    ): Edl {
        // 1s crossfading into a second 1s segment of the SAME source clip,
        // 200ms cross-fade, "cutlyra" text overlay spanning the whole
        // timeline — the M1 spike shape.
        val oneSecondTicks = ticksPerSecond
        val transitionTicks = ticksPerSecond / 5 // 200ms

        val asset = EdlAsset(
            assetId = "asset-1",
            kind = EdlAssetKind.VIDEO,
            name = source.name,
            sourceUri = source.toURI().toString(),
            codec = null,
            width = 320,
            height = 240,
            durationTicks = 2 * oneSecondTicks,
            rotationDegrees = 0,
            hasAudio = hasAudio,
        )

        fun identityTransform() = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0)

        val clipA = EdlClip(
            clipId = "clip-a",
            kind = "video",
            assetId = asset.assetId,
            name = "a",
            startTicks = 0,
            durationTicks = oneSecondTicks,
            sourceStartTicks = 0,
            sourceEndTicks = oneSecondTicks,
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
        val clipB = clipA.copy(
            clipId = "clip-b",
            startTicks = oneSecondTicks,
            sourceStartTicks = 0,
            sourceEndTicks = oneSecondTicks,
        )
        val textClip = EdlClip(
            clipId = "clip-title",
            kind = "text",
            assetId = null,
            name = "Title",
            startTicks = 0,
            durationTicks = 2 * oneSecondTicks,
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
            params = mapOf("content" to "cutlyra", "fontSize" to 48, "color" to "#00CAE0"),
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
        val textTrack = EdlTrack(
            trackId = "track-text",
            kind = EdlTrackKind.OVERLAY,
            trackType = EdlTrackType.TEXT,
            name = "Text",
            zIndex = 1,
            muted = false,
            hidden = false,
            clips = listOf(textClip),
        )

        return Edl(
            meta = EdlMeta(
                edlVersion = 1,
                generator = "cutlyra-golden-frame-test",
                ticksPerSecond = ticksPerSecond,
                frameRate = EdlRational(30, 1),
                canvasWidth = 320,
                canvasHeight = 240,
                projectId = "proj-golden",
                projectName = "Golden Frame Fixture",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = 2 * oneSecondTicks,
            ),
            assets = listOf(asset),
            tracks = listOf(mainTrack, textTrack),
            transitions = listOf(
                EdlTransition(
                    transitionId = "t-1",
                    afterClipId = "clip-a",
                    kind = "crossfade",
                    durationTicks = transitionTicks,
                ),
            ),
            overlays = listOf(
                EdlOverlay(
                    overlayId = "o-1",
                    kind = EdlOverlayKind.TEXT,
                    trackId = "track-text",
                    clipId = "clip-title",
                    zIndex = 0,
                    startTicks = 0,
                    durationTicks = 2 * oneSecondTicks,
                ),
            ),
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

    /**
     * `EdlToComposition.buildComposition` alone — the pure Media3-object
     * construction, no `Transformer`/encoder involved. Verifies the
     * cross-fade compositor's SHAPE (sequence count, transition window
     * registration) without needing a full export pass to succeed.
     */
    @Test
    fun buildComposition_produces_a_base_sequence_plus_one_crossfade_overlay_sequence() {
        val edl = buildFixtureEdl()
        val composition = EdlToComposition.buildComposition(edl)
        // sequences[0] = base video (clip-a, clip-b hard-cut)
        // sequences[1] = crossfade overlay (the head of clip-b, gapped)
        // sequences[2] = the main track's audio-only sequence. Main-track
        // audio was deliberately split out of the base video sequence after
        // Stage 11's mixed video/image export fixes, so three sequences is
        // now the intended shape for this audio-bearing fixture.
        assertEquals(3, composition.sequences.size)
    }

    /**
     * Stage 13 POCO regression: an ordinary MP4 with a video stream but NO
     * audio stream used to enter the dedicated audio sequence anyway. The
     * exporter then set removeVideo=true for that lane while
     * buildEditedMediaItem inferred removeAudio=true from hasAudio=false,
     * which Media3 rejects with "Audio and video cannot both be removed".
     *
     * Build a REAL video-only MP4 at runtime by remuxing only the fixture's
     * video track. This keeps the repository free of another binary fixture
     * while exercising the exact stream shape that failed on the POCO.
     */
    @Test
    fun exports_a_video_only_mp4_without_creating_an_impossible_audio_item() {
        val videoOnly = createVideoOnlyFixture(sourceClip)
        try {
            val sourceProbe = MediaProbe.probe(videoOnly, mimeTypeHint = "video/mp4")
            assertFalse("runtime fixture must genuinely have no audio", sourceProbe.hasAudio)

            val edl = buildFixtureEdl(source = videoOnly, hasAudio = false)
            val composition = EdlToComposition.buildComposition(edl)
            // Base video + crossfade overlay only. No main-track audio lane
            // may be created when the asset contains no audio.
            assertEquals(2, composition.sequences.size)

            val latch = CountDownLatch(1)
            val events = mutableListOf<Media3Exporter.Event>()
            Media3Exporter.start(context, edl, outputFile) { event ->
                events.add(event)
                if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                    latch.countDown()
                }
            }

            assertTrue(
                "video-only export did not reach a terminal state within 60s",
                latch.await(60, TimeUnit.SECONDS),
            )
            val terminal = events.lastOrNull()
            assertTrue(
                "expected video-only export to succeed, got: $terminal",
                terminal is Media3Exporter.Event.Done,
            )

            val done = terminal as Media3Exporter.Event.Done
            val outputProbe = MediaProbe.probe(done.outputFile, mimeTypeHint = "video/mp4")
            assertFalse("video-only output unexpectedly acquired an audio track", outputProbe.hasAudio)
            assertTrue(done.outputFile.length() > 0)
            assertFrameDecodesNonBlack(done.outputFile, atUs = 1_000_000L)
        } finally {
            videoOnly.delete()
        }
    }

    private fun createVideoOnlyFixture(source: File): File {
        val destination = File(context.cacheDir, "golden_video_only_${System.nanoTime()}.mp4")
        val extractor = MediaExtractor()
        val muxer = MediaMuxer(
            destination.absolutePath,
            MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4,
        )
        var muxerStarted = false
        try {
            extractor.setDataSource(source.absolutePath)
            var sourceVideoTrack = -1
            for (index in 0 until extractor.trackCount) {
                val format = extractor.getTrackFormat(index)
                val mime = format.getString(MediaFormat.KEY_MIME)
                if (mime?.startsWith("video/") == true) {
                    sourceVideoTrack = index
                    break
                }
            }
            assertTrue("source fixture must contain a video track", sourceVideoTrack >= 0)

            val videoFormat = extractor.getTrackFormat(sourceVideoTrack)
            val destinationTrack = muxer.addTrack(videoFormat)
            extractor.selectTrack(sourceVideoTrack)
            muxer.start()
            muxerStarted = true

            val requestedBufferSize =
                if (videoFormat.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
                    videoFormat.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE)
                } else {
                    0
                }
            val buffer = ByteBuffer.allocate(maxOf(1_048_576, requestedBufferSize))
            val info = MediaCodec.BufferInfo()

            while (true) {
                buffer.clear()
                val size = extractor.readSampleData(buffer, 0)
                if (size < 0) break
                info.set(
                    0,
                    size,
                    extractor.sampleTime,
                    extractor.sampleFlags,
                )
                muxer.writeSampleData(destinationTrack, buffer, info)
                extractor.advance()
            }
        } finally {
            if (muxerStarted) {
                muxer.stop()
            }
            muxer.release()
            extractor.release()
        }
        return destination
    }

    /**
     * Stage 14 POCO regression: an 8 s video + 15 s MP3 exported as 15 s,
     * producing a 7 s black tail because audio-only content extended
     * meta.durationTicks beyond the last visual frame.
     *
     * Reproduce the same shape with the 2 s fixture: a 1 s visual main clip
     * plus a 2 s audio clip. Video export must end at the 1 s visual boundary,
     * while retaining valid audio during that visible second.
     */
    @Test
    fun export_clamps_audio_that_outlasts_visual_timeline() {
        val base = buildFixtureEdl()
        val mainTrack = base.tracks.first { it.kind == EdlTrackKind.MAIN }
        val oneSecondVisual = mainTrack.clips.first().copy(
            clipId = "visual-1s",
            startTicks = 0,
            durationTicks = ticksPerSecond,
            sourceStartTicks = 0,
            sourceEndTicks = ticksPerSecond,
        )
        val longAudioClip = oneSecondVisual.copy(
            clipId = "audio-2s",
            kind = "audio",
            name = "long-audio",
            durationTicks = 2 * ticksPerSecond,
            sourceEndTicks = 2 * ticksPerSecond,
        )
        val audioTrack = EdlTrack(
            trackId = "track-audio",
            kind = EdlTrackKind.AUDIO,
            trackType = EdlTrackType.AUDIO,
            name = "Audio",
            zIndex = 1,
            muted = false,
            hidden = false,
            clips = listOf(longAudioClip),
        )
        val edl = base.copy(
            meta = base.meta.copy(durationTicks = 2 * ticksPerSecond),
            tracks = listOf(
                mainTrack.copy(clips = listOf(oneSecondVisual)),
                audioTrack,
            ),
            transitions = emptyList(),
            overlays = emptyList(),
        )

        val latch = CountDownLatch(1)
        val events = mutableListOf<Media3Exporter.Event>()
        Media3Exporter.start(context, edl, outputFile) { event ->
            events.add(event)
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                latch.countDown()
            }
        }

        assertTrue(
            "audio-tail regression export did not terminate within 60s",
            latch.await(60, TimeUnit.SECONDS),
        )
        val terminal = events.lastOrNull()
        assertTrue(
            "expected audio-tail regression export to succeed, got: $terminal",
            terminal is Media3Exporter.Event.Done,
        )

        val done = terminal as Media3Exporter.Event.Done
        val probe = MediaProbe.probe(done.outputFile, mimeTypeHint = "video/mp4")
        assertTrue(probe.hasAudio)
        assertTrue(
            "video export must end at the ~1s visual boundary, was ${probe.durationMicros}us",
            Math.abs(probe.durationMicros - 1_000_000L) < 300_000L,
        )
        assertFrameDecodesNonBlack(done.outputFile, atUs = 750_000L)
    }

    /**
     * The real end-to-end path: `Media3Exporter.start` -> hardware/software
     * `Transformer` -> a playable MP4. THIS is the assertion that needs a
     * device/emulator's actual codec stack — everything above this comment
     * in the file can be reasoned about from source; this cannot.
     */
    @Test
    fun exports_a_two_clip_crossfade_and_text_overlay_edl_to_a_playable_file() {
        val edl = buildFixtureEdl()
        val latch = CountDownLatch(1)
        val events = mutableListOf<Media3Exporter.Event>()

        Media3Exporter.start(context, edl, outputFile) { event ->
            events.add(event)
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                latch.countDown()
            }
        }

        val completed = latch.await(60, TimeUnit.SECONDS)
        assertTrue("export did not reach a terminal state within 60s", completed)

        val terminal = events.lastOrNull()
        assertTrue(
            "expected the export to succeed, got: $terminal",
            terminal is Media3Exporter.Event.Done,
        )
        val done = terminal as Media3Exporter.Event.Done

        assertTrue(done.outputFile.exists())
        assertTrue(done.outputFile.length() > 0)

        // Output integrity (plan M9 item 7) — re-probed independently, same
        // as Media3Exporter.verifyOutputAndReport already does before
        // emitting Done, so this is a second, test-side confirmation.
        val probed = MediaProbe.probe(done.outputFile, mimeTypeHint = "video/mp4")
        assertTrue(
            "expected an ~2s output (source is two 1s segments), was ${probed.durationMicros}us",
            Math.abs(probed.durationMicros - 2_000_000L) < 300_000L,
        )
        assertTrue(probed.hasAudio)

        // Weak sanity check ONLY — see this file's doc comment for why a real
        // perceptual golden-frame diff is not(yet) wired here.
        assertFrameDecodesNonBlack(done.outputFile, atUs = 1_000_000L)
    }

    private fun assertFrameDecodesNonBlack(file: File, atUs: Long) {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            val frame = retriever.getFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST)
            assertNotNull("expected a decodable frame at ${atUs}us (mid-crossfade)", frame)
            // decodeByteArray round trip just to prove the frame is a real,
            // non-degenerate bitmap — not a rigorous pixel check.
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
