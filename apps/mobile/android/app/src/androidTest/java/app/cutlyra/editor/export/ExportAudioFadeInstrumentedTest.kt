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
import app.cutlyra.editor.edl.EdlAudioFade
import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlMeta
import app.cutlyra.editor.edl.EdlOutput
import app.cutlyra.editor.edl.EdlRational
import app.cutlyra.editor.edl.EdlTrack
import app.cutlyra.editor.edl.EdlTrackKind
import app.cutlyra.editor.edl.EdlTrackType
import app.cutlyra.editor.edl.EdlTransform
import app.cutlyra.editor.test.R
import org.junit.After
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
 * Decoded-audio proof that a clip's EDL fade envelope becomes a real volume
 * ramp in the exported MP4.
 *
 * Why this test and not just the envelope unit tests: `ClipGainAudioProcessor`
 * runs inside Media3's audio graph, where the PCM it sees and the number of
 * frames it is handed are decided by Media3's own clipping/decoder path. Only
 * an actual export can show that the blink starts at the clip's first decoded
 * frame and that the fade-out lands on the last one. The harness exports a
 * full-scale sine-tone WAV (video lane contributes zero audio — the fixture is
 * remuxed video-only), decodes the output's audio track, and measures RMS in
 * windows across the clip.
 *
 * The same EDL is exported twice: once with an envelope, once without. The
 * unfaded export is the CONTROL — it must stay at full level at both edges,
 * which is the "projects that never set a fade are unchanged" promise at the
 * level that matters (decoded samples).
 */
@RunWith(AndroidJUnit4::class)
class ExportAudioFadeInstrumentedTest {
    private lateinit var context: Context
    private lateinit var testContext: Context
    private lateinit var sourceClip: File
    private lateinit var outputFile: File

    private val ticksPerSecond = 120_000L

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        testContext = InstrumentationRegistry.getInstrumentation().context
        sourceClip = File(context.cacheDir, "fade_source_${System.nanoTime()}.mp4")
        testContext.resources.openRawResource(R.raw.test_clip).use { input ->
            sourceClip.outputStream().use { output -> input.copyTo(output) }
        }
        outputFile = File(context.cacheDir, "fade_export_${System.nanoTime()}.mp4")
    }

    @After
    fun tearDown() {
        sourceClip.delete()
        outputFile.delete()
    }

    private fun identityTransform() = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0)

    private fun buildEdl(wav: File, audioFade: EdlAudioFade?): Edl {
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
        val audioAsset = EdlAsset(
            assetId = "asset-audio",
            kind = EdlAssetKind.AUDIO,
            name = wav.name,
            sourceUri = wav.toURI().toString(),
            codec = null,
            width = 0,
            height = 0,
            durationTicks = ticksPerSecond,
            rotationDegrees = 0,
            hasAudio = true,
        )
        val audioClip = EdlClip(
            clipId = "clip-audio",
            kind = "audio",
            assetId = audioAsset.assetId,
            name = wav.name,
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
            audioFade = audioFade,
            effects = emptyList(),
            hasMasks = false,
            animations = emptyList(),
            params = emptyMap(),
        )
        return Edl(
            meta = EdlMeta(
                edlVersion = 1,
                generator = "cutlyra-audio-fade-test",
                ticksPerSecond = ticksPerSecond,
                frameRate = EdlRational(30, 1),
                canvasWidth = 320,
                canvasHeight = 240,
                projectId = "proj-audio-fade",
                projectName = "Audio Fade Fixture",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = ticksPerSecond,
            ),
            assets = listOf(videoAsset, audioAsset),
            tracks = listOf(
                EdlTrack(
                    trackId = "track-main",
                    kind = EdlTrackKind.MAIN,
                    trackType = EdlTrackType.VIDEO,
                    name = "Main",
                    zIndex = 0,
                    muted = false,
                    hidden = false,
                    clips = listOf(videoClip),
                ),
                EdlTrack(
                    trackId = "track-audio",
                    kind = EdlTrackKind.AUDIO,
                    trackType = EdlTrackType.AUDIO,
                    name = "Audio",
                    zIndex = 1,
                    muted = false,
                    hidden = false,
                    clips = listOf(audioClip),
                ),
            ),
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
            "audio-fade export did not terminate within 90s",
            latch.await(90, TimeUnit.SECONDS),
        )
        val terminal = events.lastOrNull()
        assertTrue("expected audio-fade export to succeed, got: $terminal", terminal is Media3Exporter.Event.Done)
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
            header.putShort(1)
            header.putShort(1)
            header.putInt(sampleRate)
            header.putInt(sampleRate * 2)
            header.putShort(2)
            header.putShort(16)
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
        val destination = File(context.cacheDir, "fade_video_only_${System.nanoTime()}.mp4")
        val extractor = MediaExtractor()
        val muxer = MediaMuxer(destination.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
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
            if (muxerStarted) muxer.stop()
            muxer.release()
            extractor.release()
        }
        return destination
    }

    private data class DecodedAudio(
        val sampleRate: Int,
        val channelZero: DoubleArray,
    )

    /** Decodes the output's audio track to mono (first channel) Int16 values. */
    private fun decodeAudio(file: File): DecodedAudio {
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
        val sourceFormat = format!!
        val mimeType = sourceFormat.getString(MediaFormat.KEY_MIME)
            ?: throw IllegalStateException("audio track has no mime type")
        var sampleRate = if (sourceFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
            sourceFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        } else {
            44_100
        }
        var channelCount = if (sourceFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
            sourceFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        } else {
            1
        }
        val codec = MediaCodec.createDecoderByType(mimeType)
        codec.configure(format, null, null, 0)
        codec.start()
        extractor.selectTrack(audioTrack)

        val collected = ArrayList<Short>(64 * 1024)
        val bufferInfo = MediaCodec.BufferInfo()
        val outputBuffer = ByteBuffer.allocate(32_768 * 4).order(ByteOrder.LITTLE_ENDIAN)
        var sawEos = false
        val deadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() <= deadline) {
            if (!sawEos) {
                val inIndex = codec.dequeueInputBuffer(1_000)
                if (inIndex >= 0) {
                    val size = extractor.readSampleData(codec.getInputBuffer(inIndex)!!, 0)
                    if (size < 0) {
                        codec.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                        sawEos = true
                    } else {
                        codec.queueInputBuffer(inIndex, 0, size, extractor.sampleTime, extractor.sampleFlags)
                        extractor.advance()
                    }
                }
            }
            val outIndex = codec.dequeueOutputBuffer(bufferInfo, 1_000)
            when (outIndex) {
                MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    val outputFormat = codec.outputFormat
                    if (outputFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                        sampleRate = outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                    }
                    if (outputFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                        channelCount = outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                    }
                }
                MediaCodec.INFO_TRY_AGAIN_LATER -> if (sawEos) break
                else -> {
                    if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) sawEos = true
                    outputBuffer.clear()
                    outputBuffer.put(codec.getOutputBuffer(outIndex)!!)
                    outputBuffer.flip()
                    while (outputBuffer.remaining() >= 2) {
                        collected.add(outputBuffer.short)
                    }
                    codec.releaseOutputBuffer(outIndex, false)
                }
            }
        }
        codec.stop()
        codec.release()
        extractor.release()

        val channels = channelCount.coerceAtLeast(1)
        val channelZero = ArrayList<Double>(collected.size / channels + 1)
        var index = 0
        while (index + channels <= collected.size) {
            channelZero.add(collected[index].toDouble())
            index += channels
        }
        return DecodedAudio(sampleRate = sampleRate, channelZero = channelZero.toDoubleArray())
    }

    /** RMS of the decoded mono track over [fromSeconds, toSeconds). */
    private fun windowRms(decoded: DecodedAudio, fromSeconds: Double, toSeconds: Double): Double {
        val from = (fromSeconds * decoded.sampleRate).toInt().coerceAtLeast(0)
        val to = (toSeconds * decoded.sampleRate).toInt().coerceAtMost(decoded.channelZero.size)
        if (to <= from) return 0.0
        var sumsq = 0.0
        for (index in from until to) {
            val sample = decoded.channelZero[index]
            sumsq += sample * sample
        }
        return sqrt(sumsq / (to - from))
    }

    @Test
    fun faded_clip_ramps_up_and_down_in_the_exported_audio() {
        val wav = synthesizeWav(440.0, "fade_tone_${System.nanoTime()}.wav")
        try {
            // 1s clip, 0.25s in + 0.25s out (EDL envelope in ticks).
            val output = export(
                buildEdl(
                    wav = wav,
                    audioFade = EdlAudioFade(
                        inTicks = ticksPerSecond / 4,
                        outTicks = ticksPerSecond / 4,
                    ),
                ),
            )
            val decoded = decodeAudio(output)
            assertTrue("decoded no audio samples", decoded.channelZero.isNotEmpty())

            val early = windowRms(decoded, 0.0, 0.08)
            // Middle of the 0.25s fade-in (gain ~0.4-0.64 there), NOT its tail:
            // a window ending at 0.30s sits where the ramp has already reached
            // unity, which is why an earlier threshold here mis-measured.
            val midRamp = windowRms(decoded, 0.10, 0.16)
            val middle = windowRms(decoded, 0.45, 0.55)
            // Same lesson on the way out: 0.76-0.84s is the TOP of the 0.25s
            // fade-out (gain ~0.64-0.96), so probe further into the ramp.
            val late = windowRms(decoded, 0.84, 0.90)
            val tail = windowRms(decoded, 0.94, 1.0)

            assertTrue(
                "fade-in is missing: early RMS $early should be well below the middle $middle",
                early < middle * 0.4,
            )
            assertTrue(
                "ramp is not rising: mid-ramp RMS $midRamp should be below the middle $middle",
                midRamp < middle * 0.85,
            )
            assertTrue(
                "ramp is not rising monotonically: early $early should be below mid-ramp $midRamp",
                early < midRamp,
            )
            assertTrue("middle of the clip should be at full level, got $middle", middle > 5_000.0)
            assertTrue(
                "fade-out is missing: late RMS $late should be well below the middle $middle",
                late < middle * 0.75,
            )
            println(
                "ExportAudioFadeInstrumentedTest RMS profile: early=$early " +
                    "midRamp=$midRamp middle=$middle late=$late tail=$tail",
            )
            assertTrue(
                "the clip should end near silence: tail RMS $tail",
                // 0.35 rather than 0.25: AAC encoder priming shifts the decoded
                // timeline by ~20ms, so the last window still contains some of
                // the pre-tail ramp. Run 3 measured 4965 vs a 19782 middle
                // (0.251), i.e. a ~12 dB drop, in a window that straddles the
                // very end of the ramp.
                tail < middle * 0.35,
            )
            assertTrue(
                "fade-out does not keep falling: tail $tail should be below late $late",
                tail < late,
            )
        } finally {
            wav.delete()
        }
    }

    @Test
    fun clip_without_a_fade_keeps_full_level_at_both_edges() {
        val wav = synthesizeWav(440.0, "fade_control_tone_${System.nanoTime()}.wav")
        try {
            val output = export(buildEdl(wav = wav, audioFade = null))
            val decoded = decodeAudio(output)
            assertTrue("decoded no audio samples", decoded.channelZero.isNotEmpty())

            val early = windowRms(decoded, 0.0, 0.08)
            val middle = windowRms(decoded, 0.45, 0.55)
            val tail = windowRms(decoded, 0.94, 1.0)

            assertTrue(
                "unfaded clip changed at the start: early $early vs middle $middle",
                early > middle * 0.6,
            )
            assertTrue(
                "unfaded clip changed at the end: tail $tail vs middle $middle",
                tail > middle * 0.6,
            )
        } finally {
            wav.delete()
        }
    }
}
