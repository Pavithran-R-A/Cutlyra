package app.cutlyra.editor.export

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.cutlyra.editor.backup.BackupArchive
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
import app.cutlyra.editor.media.voiceover.VoiceoverPcmSource
import app.cutlyra.editor.media.voiceover.VoiceoverRecorder
import app.cutlyra.editor.test.R
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Voiceover end to end, proven on DECODED OUTPUT of a real exported MP4.
 *
 * Each test records its take through the PRODUCTION recorder
 * ([VoiceoverRecorder]) into the PRODUCTION custody directory
 * (`noBackupFilesDir/generated/voiceover-*.wav`), attaching it to the EDL
 * exactly as `media/voiceover.ts` attaches the committed asset (a file-backed
 * audio clip on an audio track at the record position), then exports through
 * the real Media3 pipeline and decodes the MP4's audio PCM.
 *
 * What the microphone itself cannot prove in CI: an emulator has no acoustic
 * input, so the recorder is driven by a deterministic PCM source
 * ([TonePcmSource]) instead of `AudioRecord`. That exercises every line of the
 * recorder except the AudioRecord read itself, and the `AudioRecordPcmSource`
 * read loop is a direct delegate. Live mic capture is therefore an OPEN
 * LIMITATION, not a verified claim.
 *
 * ## Documented mixing policy these tests pin
 *
 * The voiceover is mixed at UNITY gain and summed with the clip audio under
 * it — no automatic ducking. So: both tones are present in the same window,
 * the voiceover's 1 kHz amplitude is within ~3 dB of the bed's 300 Hz
 * amplitude when both clips are built at the same amplitude, and the bed does
 * NOT drop while the voiceover plays.
 */
@RunWith(AndroidJUnit4::class)
class ExportVoiceoverInstrumentedTest {
    private lateinit var context: Context
    private lateinit var testContext: Context
    private lateinit var sourceClip: File
    private lateinit var videoOnly: File
    private lateinit var workDir: File
    private val generatedTakeFiles = mutableListOf<File>()
    private val restoredDirs = mutableListOf<File>()

    private val ticksPerSecond = 120_000L
    private val bedHz = 300.0
    private val voiceHz = 1_000.0
    private val toneAmplitude = 8_000.0

    private fun ms(value: Long): Long = value * ticksPerSecond / 1000

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        testContext = InstrumentationRegistry.getInstrumentation().context
        workDir = File(context.cacheDir, "voiceover_${System.nanoTime()}").apply { mkdirs() }
        sourceClip = File(workDir, "source.mp4")
        testContext.resources.openRawResource(R.raw.test_clip).use { input ->
            sourceClip.outputStream().use { output -> input.copyTo(output) }
        }
        videoOnly = createVideoOnlyFixture(sourceClip)
    }

    @After
    fun tearDown() {
        generatedTakeFiles.forEach { it.delete() }
        restoredDirs.forEach { it.deleteRecursively() }
        workDir.deleteRecursively()
        recreatedOutputs.forEach { it.delete() }
    }

    private val recreatedOutputs = mutableListOf<File>()

    // --------------------------------------------------------------- fixtures

    /** Deterministic mono 16-bit PCM at 44.1 kHz, ending after a fixed count. */
    private class TonePcmSource(
        private val hz: Double,
        private val amplitude: Double,
        private val totalSamples: Long,
        private val sampleRate: Int = 44_100,
    ) : VoiceoverPcmSource {
        private var emitted = 0L

        override fun read(buffer: ShortArray, offset: Int, count: Int): Int {
            if (emitted >= totalSamples) return 0
            val n = minOf(count.toLong(), totalSamples - emitted).toInt()
            for (i in 0 until n) {
                val t = (emitted + i) / sampleRate.toDouble()
                buffer[offset + i] = (amplitude * sin(2 * PI * hz * t)).toInt().toShort()
            }
            emitted += n
            return n
        }
    }

    /**
     * Records a take with the PRODUCTION recorder, into the real custody dir.
     * Waits for the source to end (or the limit) and collects the take.
     */
    private fun recordTake(
        hz: Double,
        seconds: Double,
        amplitude: Double = toneAmplitude,
    ): Pair<File, Long> {
        val takeId = "voiceover-test-${System.nanoTime()}"
        val source = TonePcmSource(hz, amplitude, (seconds * 44_100).toLong())
        val recorder = VoiceoverRecorder(context.noBackupFilesDir, source)
        recorder.start(takeId, maxDurationMs = 30_000)
        val deadline = System.currentTimeMillis() + 30_000
        while (recorder.isRecording && System.currentTimeMillis() < deadline) Thread.sleep(10)
        val take = recorder.stop()
        val file = File(context.noBackupFilesDir, take.relativePath)
        generatedTakeFiles.add(file)
        assertTrue("recorder must publish the take into custody", file.isFile)
        assertEquals(
            "recorder take must live under generated/voiceover-*",
            true,
            take.relativePath.startsWith("generated/voiceover-") && take.relativePath.endsWith(".wav"),
        )
        assertTrue(
            "recorded take should be ~${seconds}s, was ${take.durationMs}ms",
            abs(take.durationMs - (seconds * 1000).toLong()) < 120,
        )
        return file to take.durationMs
    }

    /** A mono 16-bit WAV of a constant tone, written straight to cache. */
    private fun synthesizeWav(hz: Double, seconds: Double, name: String): File {
        val sampleRate = 44_100
        val samples = (seconds * sampleRate).toInt()
        val file = File(workDir, name)
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
        file.outputStream().use { out ->
            out.write(header.array())
            val bytes = ByteBuffer.allocate(samples * 2).order(ByteOrder.LITTLE_ENDIAN)
            for (i in 0 until samples) {
                val t = i / sampleRate.toDouble()
                bytes.putShort((toneAmplitude * sin(2 * PI * hz * t)).toInt().toShort())
            }
            out.write(bytes.array())
        }
        return file
    }

    private fun createVideoOnlyFixture(source: File): File {
        val destination = File(workDir, "video_only.mp4")
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
                val mime = extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME)
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
            val requested = if (videoFormat.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
                videoFormat.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE)
            } else {
                0
            }
            val buffer = ByteBuffer.allocate(maxOf(1_048_576, requested))
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

    // ------------------------------------------------------------------- EDL

    private fun identityTransform() = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0)

    private fun audioClip(
        clipId: String,
        assetId: String,
        startMs: Long,
        durationMs: Long,
        sourceStartMs: Long,
    ): EdlClip = EdlClip(
        clipId = clipId,
        kind = "audio",
        assetId = assetId,
        name = clipId,
        startTicks = ms(startMs),
        durationTicks = ms(durationMs),
        sourceStartTicks = ms(sourceStartMs),
        sourceEndTicks = ms(sourceStartMs + durationMs),
        speed = EdlRational(1, 1),
        maintainPitch = false,
        // Unity gain: the documented voiceover mix policy.
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

    private fun audioAsset(assetId: String, file: File, durationMs: Long): EdlAsset = EdlAsset(
        assetId = assetId,
        kind = EdlAssetKind.AUDIO,
        name = file.name,
        sourceUri = file.toURI().toString(),
        codec = null,
        width = 0,
        height = 0,
        durationTicks = ms(durationMs),
        rotationDegrees = 0,
        hasAudio = true,
    )

    /**
     * Video main track + a 300 Hz "clip audio" bed + the voiceover on its own
     * audio track, positioned exactly as `commitVoiceoverTake` places it.
     */
    private fun buildEdl(
        bed: File,
        projectDurationMs: Long,
        voiceover: File,
        voiceoverDurationMs: Long,
        voiceoverStartMs: Long,
        voiceoverSourceStartMs: Long = 0,
        voiceoverClipDurationMs: Long = voiceoverDurationMs,
    ): Edl {
        val videoAsset = EdlAsset(
            assetId = "asset-video",
            kind = EdlAssetKind.VIDEO,
            name = videoOnly.name,
            sourceUri = videoOnly.toURI().toString(),
            codec = null,
            width = 320,
            height = 240,
            durationTicks = ms(2_000),
            rotationDegrees = 0,
            hasAudio = false,
        )
        val videoClip = EdlClip(
            clipId = "clip-video",
            kind = "video",
            assetId = videoAsset.assetId,
            name = "v",
            startTicks = 0,
            durationTicks = ms(projectDurationMs),
            sourceStartTicks = 0,
            sourceEndTicks = ms(projectDurationMs),
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
        val bedAsset = audioAsset("asset-bed", bed, projectDurationMs)
        val voiceAsset = audioAsset("asset-voice", voiceover, voiceoverDurationMs)
        return Edl(
            meta = EdlMeta(
                edlVersion = 1,
                generator = "cutlyra-voiceover-test",
                ticksPerSecond = ticksPerSecond,
                frameRate = EdlRational(30, 1),
                canvasWidth = 320,
                canvasHeight = 240,
                projectId = "proj-voiceover",
                projectName = "Voiceover Fixture",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = ms(projectDurationMs),
            ),
            assets = listOf(videoAsset, bedAsset, voiceAsset),
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
                    trackId = "track-bed",
                    kind = EdlTrackKind.AUDIO,
                    trackType = EdlTrackType.AUDIO,
                    name = "Clip audio",
                    zIndex = 1,
                    muted = false,
                    hidden = false,
                    clips = listOf(
                        audioClip("clip-bed", bedAsset.assetId, 0, projectDurationMs, 0),
                    ),
                ),
                EdlTrack(
                    trackId = "track-voice",
                    kind = EdlTrackKind.AUDIO,
                    trackType = EdlTrackType.AUDIO,
                    name = "Voiceover",
                    zIndex = 2,
                    muted = false,
                    hidden = false,
                    clips = listOf(
                        audioClip(
                            "clip-voice",
                            voiceAsset.assetId,
                            voiceoverStartMs,
                            voiceoverClipDurationMs,
                            voiceoverSourceStartMs,
                        ),
                    ),
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
        val output = File(workDir, "export_${System.nanoTime()}.mp4")
        recreatedOutputs.add(output)
        val latch = CountDownLatch(1)
        val events = mutableListOf<Media3Exporter.Event>()
        Media3Exporter.start(context, edl, output) { event ->
            events.add(event)
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                latch.countDown()
            }
        }
        assertTrue("voiceover export did not terminate within 90s", latch.await(90, TimeUnit.SECONDS))
        val terminal = events.lastOrNull()
        assertTrue("expected voiceover export to succeed, got: $terminal", terminal is Media3Exporter.Event.Done)
        return output
    }

    // --------------------------------------------------------------- decoding

    private data class DecodedAudio(
        val samples: DoubleArray,
        val sampleRate: Int,
    ) {
        fun seconds(): Double = samples.size / sampleRate.toDouble()
    }

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
        val mimeType = sourceFormat.getString(MediaFormat.KEY_MIME)!!
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
        while (System.currentTimeMillis() < deadline) {
            if (!sawEos) {
                val inIndex = codec.dequeueInputBuffer(1_000)
                if (inIndex >= 0) {
                    val input = codec.getInputBuffer(inIndex)!!
                    val size = extractor.readSampleData(input, 0)
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
                    while (outputBuffer.remaining() >= 2) collected.add(outputBuffer.short)
                    codec.releaseOutputBuffer(outIndex, false)
                }
            }
        }
        codec.stop()
        codec.release()
        extractor.release()
        val channels = channelCount.coerceAtLeast(1)
        val mono = ArrayList<Double>(collected.size / channels + 1)
        var index = 0
        while (index + channels <= collected.size) {
            mono.add(collected[index].toDouble())
            index += channels
        }
        return DecodedAudio(mono.toDoubleArray(), sampleRate)
    }

    /** Goertzel amplitude of `hz` over a slice of mono PCM, in Int16 units. */
    private fun toneAmplitude(samples: DoubleArray, sampleRate: Int, hz: Double): Double {
        if (samples.isEmpty() || sampleRate <= 0) return 0.0
        val omega = 2.0 * PI * hz / sampleRate
        val coefficient = 2.0 * cos(omega)
        var s1 = 0.0
        var s2 = 0.0
        for (sample in samples) {
            val s0 = sample + coefficient * s1 - s2
            s2 = s1
            s1 = s0
        }
        val real = s1 - s2 * cos(omega)
        val imaginary = s2 * sin(omega)
        return 2.0 * sqrt(real * real + imaginary * imaginary) / samples.size
    }

    private fun slice(audio: DecodedAudio, fromSec: Double, toSec: Double): DoubleArray {
        val from = max(0, (fromSec * audio.sampleRate).toInt())
        val to = minOf(audio.samples.size, (toSec * audio.sampleRate).toInt())
        if (to <= from) return DoubleArray(0)
        return audio.samples.copyOfRange(from, to)
    }

    /** (startSec, amplitude) for 50 ms windows every 10 ms. */
    private fun toneWindows(
        audio: DecodedAudio,
        hz: Double,
        windowSec: Double = 0.05,
        hopSec: Double = 0.01,
    ): List<Pair<Double, Double>> {
        val window = (windowSec * audio.sampleRate).toInt()
        val hop = (hopSec * audio.sampleRate).toInt()
        val result = mutableListOf<Pair<Double, Double>>()
        var start = 0
        while (start + window <= audio.samples.size) {
            val slice = audio.samples.copyOfRange(start, start + window)
            result.add(
                start / audio.sampleRate.toDouble() to toneAmplitude(slice, audio.sampleRate, hz),
            )
            start += hop
        }
        return result
    }

    /** First window where `hz` is clearly present. */
    private fun firstOnsetSeconds(
        audio: DecodedAudio,
        hz: Double,
        threshold: Double,
    ): Double? = toneWindows(audio, hz).firstOrNull { it.second > threshold }?.first

    private fun lastOnsetSeconds(
        audio: DecodedAudio,
        hz: Double,
        threshold: Double,
    ): Double? = toneWindows(audio, hz).lastOrNull { it.second > threshold }?.first

    private fun db(value: Double): Double = 20.0 * kotlin.math.log10(value.coerceAtLeast(1e-9))

    // ----------------------------------------------------------------- tests

    @Test
    fun voiceover_is_mixed_at_its_offset_with_unity_gain_and_no_ducking() {
        val voiceoverSeconds = 0.6
        val (take, takeMs) = recordTake(voiceHz, voiceoverSeconds)
        val projectMs = 1_500L
        val startMs = 400L
        val bed = synthesizeWav(bedHz, projectMs / 1000.0, "bed300.wav")

        val decoded = decodeAudio(
            export(
                buildEdl(
                    bed = bed,
                    projectDurationMs = projectMs,
                    voiceover = take,
                    voiceoverDurationMs = takeMs,
                    voiceoverStartMs = startMs,
                ),
            ),
        )
        assertTrue("decoded no audio samples", decoded.samples.size > 0)
        println(
            "VOICEOVER decoded ${decoded.samples.size} samples @ ${decoded.sampleRate}Hz " +
                "(${"%.2f".format(decoded.seconds())}s)",
        )

        // 1. Present at all, and only from its timeline position on.
        val voiceBefore = toneAmplitude(slice(decoded, 0.0, 0.30), decoded.sampleRate, voiceHz)
        val voiceAfter = toneAmplitude(
            slice(decoded, (startMs + 100) / 1000.0, (startMs + 100 + 400) / 1000.0),
            decoded.sampleRate,
            voiceHz,
        )
        val bedBefore = toneAmplitude(slice(decoded, 0.0, 0.30), decoded.sampleRate, bedHz)
        val bedDuring = toneAmplitude(
            slice(decoded, (startMs + 100) / 1000.0, (startMs + 100 + 400) / 1000.0),
            decoded.sampleRate,
            bedHz,
        )
        println(
            "VOICEOVER 1kHz before=${"%.0f".format(voiceBefore)} during=${"%.0f".format(voiceAfter)}; " +
                "BED 300Hz before=${"%.0f".format(bedBefore)} during=${"%.0f".format(bedDuring)}",
        )
        assertTrue("the bed clip audio must be audible in the export ($bedBefore)", bedBefore > 2_000.0)
        assertTrue(
            "the voiceover must not be audible before its timeline position ($voiceBefore)",
            voiceBefore < bedBefore * 0.15,
        )
        assertTrue(
            "the voiceover is missing from the decoded export ($voiceAfter)",
            voiceAfter > 2_000.0,
        )

        // 2. Its onset is the element's timeline position (tolerance stated:
        //    ±80 ms — encoder priming plus the 50 ms analysis window).
        val onset = firstOnsetSeconds(decoded, voiceHz, threshold = 1_500.0)
        assertTrue("could not find a voiceover onset in the decoded audio", onset != null)
        println(
            "VOICEOVER onset=${"%.3f".format(onset!!)}s expected=${"%.3f".format(startMs / 1000.0)}s",
        )
        assertTrue(
            "voiceover onset ${onset}s is not within 80ms of its element position ${startMs}ms",
            abs(onset - startMs / 1000.0) <= 0.080,
        )

        // 3. Unity gain relative to the clip audio: both clips were built at
        //    the same amplitude, so the decoded 1 kHz amplitude sits within
        //    3 dB of the 300 Hz bed. (A gain-staged mix would land elsewhere.)
        val gainDelta = db(voiceAfter) - db(bedDuring)
        println("VOICEOVER gain delta vs bed = ${"%.2f".format(gainDelta)} dB")
        assertTrue(
            "voiceover is not mixed at unity gain relative to the clip audio " +
                "(${"%.2f".format(gainDelta)} dB, expected |delta| <= 3 dB)",
            abs(gainDelta) <= 3.0,
        )

        // 4. No ducking: the bed under the voiceover keeps its level.
        val duckingDelta = db(bedDuring) - db(bedBefore)
        println("VOICEOVER ducking check: bed level change ${"%.2f".format(duckingDelta)} dB")
        assertTrue(
            "the bed must not be ducked under the voiceover (${"%.2f".format(duckingDelta)} dB change)",
            abs(duckingDelta) <= 3.0,
        )
    }

    @Test
    fun a_trimmed_voiceover_starts_and_ends_at_its_element_bounds() {
        // Take is 1.0s; the element starts 0.3s into the take, is 0.4s long,
        // and sits at 0.2s on the timeline — so audible 0.2s..0.6s.
        val (take, takeMs) = recordTake(voiceHz, 1.0)
        val projectMs = 1_200L
        val bed = synthesizeWav(bedHz, projectMs / 1000.0, "bed300.wav")
        val decoded = decodeAudio(
            export(
                buildEdl(
                    bed = bed,
                    projectDurationMs = projectMs,
                    voiceover = take,
                    voiceoverDurationMs = takeMs,
                    voiceoverStartMs = 200,
                    voiceoverSourceStartMs = 300,
                    voiceoverClipDurationMs = 400,
                ),
            ),
        )

        val onset = firstOnsetSeconds(decoded, voiceHz, threshold = 1_500.0)
        val end = lastOnsetSeconds(decoded, voiceHz, threshold = 1_500.0)
        assertTrue("trimmed voiceover has no onset", onset != null)
        assertTrue("trimmed voiceover has no end", end != null)
        println(
            "VOICEOVER trimmed onset=${"%.3f".format(onset!!)}s (expect 0.200) " +
                "last=${"%.3f".format(end!!)}s (expect ~0.600)",
        )
        assertTrue(
            "trimmed voiceover must start at its element position, got ${onset}s",
            abs(onset - 0.200) <= 0.080,
        )
        assertTrue(
            "trimmed voiceover must stop at its trimmed end (~0.6s), got ${end}s",
            abs(end - 0.600) <= 0.120,
        )
        val afterEnd = toneAmplitude(slice(decoded, 0.75, 1.1), decoded.sampleRate, voiceHz)
        println("VOICEOVER after trimmed end amplitude=${"%.0f".format(afterEnd)}")
        assertTrue("voiceover must not continue past its trimmed end ($afterEnd)", afterEnd < 500.0)
    }

    @Test
    fun voiceover_survives_archive_and_restore_and_still_exports() {
        val (take, takeMs) = recordTake(voiceHz, 0.6)
        val takePath = "generated/${take.name}"
        val projectMs = 1_200L
        val bed = synthesizeWav(bedHz, projectMs / 1000.0, "bed300.wav")
        val destination = File(workDir, "voiceover.cutlyra-backup")
        val projectJson = """{"metadata":{"id":"proj-voiceover","name":"Voiceover Backup"}}"""

        val manifest = BackupArchive.export(
            context = context,
            destinationUri = Uri.fromFile(destination),
            projectJson = projectJson,
            media = listOf(
                BackupArchive.MediaDescriptor(
                    assetId = "asset-voice",
                    proxyPath = null,
                    sourcePath = takePath,
                    thumbnailPath = null,
                    name = "Voiceover",
                    type = "audio",
                    sizeBytes = take.length(),
                    lastModified = 0L,
                    width = null,
                    height = null,
                    duration = takeMs / 1000.0,
                    fps = null,
                    hasAudio = true,
                    sourceRotationDegrees = 0,
                    sourceWidth = null,
                    sourceHeight = null,
                ),
            ),
            appVersion = "instrumentation",
        )
        assertTrue("the archive must be written to disk", destination.length() > 0L)
        val archivedAsset = manifest.getJSONArray("projects")
            .getJSONObject(0)
            .getJSONArray("assets")
            .getJSONObject(0)
        assertEquals("Voiceover", archivedAsset.getString("name"))
        val files = archivedAsset.getJSONArray("files")
        assertEquals(1, files.length())
        assertEquals("source", files.getJSONObject(0).getString("role"))

        // Fresh install: the archived take is gone.
        assertTrue("the original take must be removable", take.delete())
        assertFalse(take.exists())

        val imported = BackupArchive.import(context, Uri.fromFile(destination))
        val restored = imported.restoredFiles.single { it.role == "source" }
        val restoredFile = File(context.noBackupFilesDir, restored.newPath)
        restored.newPath.substringBeforeLast('/').let { dir ->
            restoredDirs.add(File(context.noBackupFilesDir, dir))
        }
        assertTrue("restored voiceover must exist at ${restored.newPath}", restoredFile.isFile)
        assertTrue(
            "restore must use a fresh custody path, got ${restored.newPath}",
            restored.newPath != takePath,
        )
        generatedTakeFiles.add(restoredFile)

        val decoded = decodeAudio(
            export(
                buildEdl(
                    bed = bed,
                    projectDurationMs = projectMs,
                    voiceover = restoredFile,
                    voiceoverDurationMs = takeMs,
                    voiceoverStartMs = 300,
                ),
            ),
        )
        val presence = toneAmplitude(slice(decoded, 0.4, 0.8), decoded.sampleRate, voiceHz)
        println("VOICEOVER after restore: 1kHz amplitude=${"%.0f".format(presence)}")
        assertTrue(
            "a restored voiceover must still be mixed into the export ($presence)",
            presence > 2_000.0,
        )
    }
}
