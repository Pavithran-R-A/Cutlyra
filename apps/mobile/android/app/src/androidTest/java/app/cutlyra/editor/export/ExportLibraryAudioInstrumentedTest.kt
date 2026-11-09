package app.cutlyra.editor.export

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
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
import app.cutlyra.editor.edl.EdlRational
import app.cutlyra.editor.edl.EdlTrack
import app.cutlyra.editor.edl.EdlTrackKind
import app.cutlyra.editor.edl.EdlTrackType
import app.cutlyra.editor.edl.EdlTransform
import app.cutlyra.editor.media.MediaProbe
import app.cutlyra.editor.test.R
import org.junit.After
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.PI
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * GitHub #63: bundled library sounds played in the preview but were
 * silently absent from every exported MP4, because a library element
 * carried no `mediaId`, so the EDL clip had a null `assetId` and
 * `EdlToComposition.audibleClips` filtered it out of the audio lane.
 *
 * The fix materializes each bundled sound into a real media asset (a WAV
 * in native custody) at insert/export time, so the clip reaches the
 * exporter as an ordinary file-backed audio asset. This harness encodes
 * the user-visible end-to-end contract that test guarantees:
 *
 *   1. Standalone library audio is present in the exported MP4 as
 *      decoded non-silent audio (decoded-PCM RMS, not just track
 *      presence) — what the buggy build did not do at all.
 *   2. Two library sounds mixed together measure strictly louder than
 *      the same single sound (real mixing, not a swallowed track).
 *   3. A muted library sound produces no audible output (mute
 *      semantics), while an image/visual-only composition with NO
 *      library audio still exports cleanly (no collateral damage).
 *
 * The test source is a synthesized sine-tone WAV (the same shape the
 * library now materializes), written at runtime like the in-memory tone
 * the TS library synthesizes — no new binary fixture enters the repo.
 * The visual is the existing `test_clip.mp4` fixture remuxed to
 * video-only (`createVideoOnlyFixture`), so the video itself
 * contributes ZERO audio and every decibel measured comes from the
 * library sound under test.
 */
@RunWith(AndroidJUnit4::class)
class ExportLibraryAudioInstrumentedTest {
    private lateinit var context: Context
    private lateinit var testContext: Context
    private lateinit var sourceClip: File
    private lateinit var outputFile: File

    private val ticksPerSecond = 120_000L

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        testContext = InstrumentationRegistry.getInstrumentation().context
        sourceClip = File(context.cacheDir, "lib63_source_${System.nanoTime()}.mp4")
        // R is the instrumentation APK's generated R class
        // (ExportGoldenFrameInstrumentedTest rationale).
        testContext.resources.openRawResource(R.raw.test_clip).use { input ->
            sourceClip.outputStream().use { output -> input.copyTo(output) }
        }
        outputFile = File(context.cacheDir, "lib63_export_${System.nanoTime()}.mp4")
    }

    @After
    fun tearDown() {
        sourceClip.delete()
        outputFile.delete()
    }

    private fun identityTransform() = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0)

    private fun clip(
        clipId: String,
        assetId: String?,
        durationTicks: Long = ticksPerSecond,
        startTicks: Long = 0,
        muted: Boolean = false,
        speed: EdlRational = EdlRational(1, 1),
    ): EdlClip = EdlClip(
        clipId = clipId,
        kind = "audio",
        assetId = assetId,
        name = clipId,
        startTicks = startTicks,
        durationTicks = durationTicks,
        sourceStartTicks = 0,
        sourceEndTicks = durationTicks,
        speed = speed,
        maintainPitch = false,
        volumeDb = 0.0,
        muted = muted,
        hidden = false,
        transform = identityTransform(),
        opacity = 1.0,
        effects = emptyList(),
        hasMasks = false,
        animations = emptyList(),
        params = emptyMap(),
    )

    private fun buildEdl(
        wav: File?,
        includeLibraryClip: Boolean = true,
        muted: Boolean = false,
        additionalWav: File? = null,
        mixed: Boolean = false,
    ): Edl {
        // The visual lane is the video-only remux of the fixture clip:
        // it contributes no audio, so the WAV is the ONLY sound source.
        val videoOnly = createVideoOnlyFixture(sourceClip)
        val videoAsset = EdlAsset(
            assetId = "asset-video",
            kind = EdlAssetKind.VIDEO,
            name = videoOnly.name,
            sourceUri = videoOnly.toURI().toString(),
            codec = null,
            width = 320,
            height = 240,
            durationTicks = 2 * ticksPerSecond,
            rotationDegrees = 0,
            hasAudio = false,
        )
        val videoClip = EdlClip(
            clipId = "clip-video",
            kind = "video",
            assetId = videoAsset.assetId,
            name = "v",
            startTicks = 0,
            durationTicks = ticksPerSecond,
            sourceStartTicks = 0,
            sourceEndTicks = ticksPerSecond,
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
            clips = listOf(videoClip),
        )

        val assets = mutableListOf(videoAsset)
        val tracks = mutableListOf(mainTrack)

        fun libraryTrack(trackId: String, wavFile: File, clipId: String, i: Int) {
            val asset = EdlAsset(
                assetId = "asset-lib-$i",
                kind = EdlAssetKind.AUDIO,
                name = wavFile.name,
                sourceUri = wavFile.toURI().toString(),
                codec = null,
                width = 0,
                height = 0,
                durationTicks = ticksPerSecond,
                rotationDegrees = 0,
                hasAudio = true,
            )
            assets.add(asset)
            tracks.add(
                EdlTrack(
                    trackId = trackId,
                    kind = EdlTrackKind.AUDIO,
                    trackType = EdlTrackType.AUDIO,
                    name = trackId,
                    zIndex = i + 1,
                    muted = false,
                    hidden = false,
                    clips = listOf(
                        clip(
                            clipId = clipId,
                            assetId = asset.assetId,
                            muted = muted,
                        ),
                    ),
                ),
            )
        }

        if (includeLibraryClip) {
            requireNotNull(wav) { "A WAV is required whenever a library clip is requested" }
            libraryTrack("track-lib-1", wav, "clip-lib-1", 1)
        }
        if (mixed && additionalWav != null) {
            libraryTrack("track-lib-2", additionalWav, "clip-lib-2", 2)
        }

        return Edl(
            meta = EdlMeta(
                edlVersion = 1,
                generator = "cutlyra-library-audio-test",
                ticksPerSecond = ticksPerSecond,
                frameRate = EdlRational(30, 1),
                canvasWidth = 320,
                canvasHeight = 240,
                projectId = "proj-lib63",
                projectName = "Library Audio Fixture",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = ticksPerSecond,
            ),
            assets = assets.toList(),
            tracks = tracks.toList(),
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

    private fun export(edl: Edl): File {
        val latch = CountDownLatch(1)
        val events = mutableListOf<Media3Exporter.Event>()
        Media3Exporter.start(context, edl, outputFile) { event ->
            events.add(event)
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                latch.countDown()
            }
        }
        assertTrue(
            "library-audio export did not terminate within 90s",
            latch.await(90, TimeUnit.SECONDS),
        )
        val terminal = events.lastOrNull()
        assertTrue(
            "expected library-audio export to succeed, got: $terminal",
            terminal is Media3Exporter.Event.Done,
        )
        return (terminal as Media3Exporter.Event.Done).outputFile
    }

    /** Full-scale-ish 1s sine tone at 44100 Hz / 16-bit PCM mono. */
    private fun synthesizeWav(toneHz: Double, name: String): File {
        val sampleRate = 44_100
        val seconds = 1.0
        val samples = (seconds * sampleRate).toInt()
        val file = File(context.cacheDir, name)
        file.outputStream().use { out ->
            val dataSize = samples * 2
            val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            header.put("RIFF".toByteArray(Charsets.US_ASCII))
            header.putInt(36 + dataSize)
            header.put("WAVE".toByteArray(Charsets.US_ASCII))
            header.put("fmt ".toByteArray(Charsets.US_ASCII))
            header.putInt(16)
            header.putShort(1) // PCM
            header.putShort(1) // mono
            header.putInt(sampleRate)
            header.putInt(sampleRate * 2) // byte rate
            header.putShort(2) // block align
            header.putShort(16) // bits per sample
            header.put("data".toByteArray(Charsets.US_ASCII))
            header.putInt(dataSize)
            out.write(header.array())
            val amplitude = 28_000.0
            val bytes = ByteBuffer.allocate(4096 * 2).order(ByteOrder.LITTLE_ENDIAN)
            var n = 0
            while (n < samples) {
                bytes.clear()
                var written = 0
                while (written < 2048 && n + written < samples) {
                    val t = (n + written) / sampleRate.toDouble()
                    val value = (amplitude * sin(2 * PI * toneHz * t)).toInt()
                    bytes.putShort(value.toShort())
                    written++
                }
                bytes.flip()
                out.write(bytes.array(), 0, bytes.remaining())
                n += written
            }
        }
        return file
    }

    private fun createVideoOnlyFixture(source: File): File {
        val destination = File(context.cacheDir, "lib63_video_only_${System.nanoTime()}.mp4")
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
                info.set(0, size, extractor.sampleTime, extractor.sampleFlags)
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
     * Decodes the output MP4's audio track and returns
     * `(sampleCount, rootMeanSquare of Int16 samples)`.
     */
    private fun decodeAudioRms(file: File): Pair<Long, Double> {
        val extractor = MediaExtractor()
        extractor.setDataSource(file.absolutePath)
        var audioTrack = -1
        var format: MediaFormat? = null
        for (index in 0 until extractor.trackCount) {
            val trackFormat = extractor.getTrackFormat(index)
            val mime = trackFormat.getString(MediaFormat.KEY_MIME)
            if (mime?.startsWith("audio/") == true) {
                audioTrack = index
                format = trackFormat
                break
            }
        }
        assertTrue("exported file has no audio track", audioTrack >= 0)
        val codec = MediaCodec.createDecoderByType(format!!.getString(MediaFormat.KEY_MIME))
        codec.configure(format, null, null, 0)
        codec.start()
        extractor.selectTrack(audioTrack)

        var sumsq = 0L
        var count = 0L
        val bufferInfo = MediaCodec.BufferInfo()
        val outputBuffer = ByteBuffer.allocate(32_768 * 4)
        var sawEos = false
        val deadline = System.currentTimeMillis() + 30_000
        while (!sawEos || true) {
            if (System.currentTimeMillis() > deadline) break
            if (!sawEos) {
                val inIndex = codec.dequeueInputBuffer(1_000)
                if (inIndex >= 0) {
                    val size = extractor.readSampleData(codec.getInputBuffer(inIndex)!!, 0)
                    if (size < 0) {
                        codec.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                        sawEos = true
                    } else {
                        codec.queueInputBuffer(
                            inIndex, 0, size, extractor.sampleTime, extractor.sampleFlags,
                        )
                        extractor.advance()
                    }
                }
            }
            val outIndex = codec.dequeueOutputBuffer(bufferInfo, 1_000)
            when (outIndex) {
                MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> codec.outputFormat
                MediaCodec.INFO_TRY_LATER_AGAIN -> if (sawEos) break
                else -> {
                    if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                        sawEos = true
                    }
                    outputBuffer.clear()
                    outputBuffer.put(codec.getOutputBuffer(outIndex)!!)
                    outputBuffer.flip()
                    while (outputBuffer.remaining() >= 2) {
                        val sample = outputBuffer.short.toLong()
                        sumsq += sample * sample
                        count++
                    }
                    codec.releaseOutputBuffer(outIndex, false)
                }
            }
        }
        codec.stop()
        codec.release()
        extractor.release()
        val rms = if (count == 0L) 0.0 else sqrt(sumsq.toDouble() / count.toDouble())
        return count to rms
    }

    @Test
    fun standalone_library_sound_appears_in_export_as_decoded_audio() {
        val wav = synthesizeWav(440.0, "lib63_tone440_${System.nanoTime()}.wav")
        try {
            val output = export(buildEdl(wav))
            val probe = MediaProbe.probe(output, mimeTypeHint = "video/mp4")
            assertTrue("export should carry an audio track: $probe", probe.hasAudio)
            val (count, rms) = decodeAudioRms(output)
            assertTrue("decoded no audio samples", count > 0)
            assertTrue(
                "library sound was swallowed by export (decoded RMS is silence): $rms",
                rms > 5_000.0,
            )
        } finally {
            wav.delete()
        }
    }

    @Test
    fun two_library_sounds_mixed_together_get_louder_than_either_alone() {
        val wavA = synthesizeWav(440.0, "lib63_tone440_${System.nanoTime()}.wav")
        val wavB = synthesizeWav(880.0, "lib63_tone880_${System.nanoTime()}.wav")
        try {
            val single = decodeAudioRms(export(buildEdl(wavA)))
            val (unusedSingle) = single
            assertTrue("single decoded no audio", unusedSingle > 0)
            val singleRms = single.second

            val mixed = decodeAudioRms(export(buildEdl(wavA, mixed = true, additionalWav = wavB)))
            assertTrue("mixed decoded no audio", mixed.first > 0)
            assertTrue(
                "two equal-energy tones mixed should measure louder than one (single=$singleRms, mixed=${mixed.second})",
                mixed.second > singleRms * 1.12,
            )
        } finally {
            wavA.delete()
            wavB.delete()
        }
    }

    @Test
    fun muted_library_sound_produces_no_audible_output() {
        val wav = synthesizeWav(440.0, "lib63_tone440_${System.nanoTime()}.wav")
        try {
            val output = export(buildEdl(wav, muted = true))
            val probe = MediaProbe.probe(output, mimeTypeHint = "video/mp4")
            if (probe.hasAudio) {
                val (_, rms) = decodeAudioRms(output)
                assertTrue(
                    "muted library sound decoded non-silence (RMS $rms)",
                    rms < 100.0,
                )
            }
            assertTrue(output.length() > 0)
        } finally {
            wav.delete()
        }
    }

    @Test
    fun visual_only_composition_without_library_audio_still_exports() {
        // No library clip requested at all: the export is untouched by
        // the fix and must keep working.
        val edl = buildEdl(wav = null, includeLibraryClip = false)
        val output = export(edl)
        val probe = MediaProbe.probe(output, mimeTypeHint = "video/mp4")
        assertNotNull(probe)
        assertTrue(output.length() > 0)
    }
}
