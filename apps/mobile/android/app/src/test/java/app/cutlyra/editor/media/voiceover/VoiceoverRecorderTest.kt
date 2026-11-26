package app.cutlyra.editor.media.voiceover

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * JVM tests for the production recorder driven by a DETERMINISTIC PCM source
 * (a sine generator) instead of a microphone. This is the record ->
 * custody -> WAV half of the voiceover contract; the exported-audio half is
 * `ExportVoiceoverInstrumentedTest`, which feeds the WAV this class writes
 * into the real Media3 exporter.
 */
class VoiceoverRecorderTest {
    private fun tempRoot(): File =
        File(System.getProperty("java.io.tmpdir"), "voicerec-${System.nanoTime()}").also { it.mkdirs() }

    /** A sine source that produces `totalSamples` samples then reads 0.
     *  Paced at 1:1 with wall clock, like AudioRecord: a recorder that
     *  enforces a duration limit can only be tested against a real-time
     *  source, otherwise it writes 10x the limit's worth of audio. */
    private class ToneSource(
        private val sampleRate: Int,
        private val hz: Double,
        private val amplitude: Double,
        private val totalSamples: Long,
        private val realtime: Boolean = true,
    ) : VoiceoverPcmSource {
        var emitted = 0L
            private set
        var released = false
            private set

        override fun read(buffer: ShortArray, offset: Int, count: Int): Int {
            if (emitted >= totalSamples) return 0
            val n = minOf(count.toLong(), totalSamples - emitted).toInt()
            for (i in 0 until n) {
                val t = (emitted + i) / sampleRate.toDouble()
                buffer[offset + i] = (amplitude * sin(2 * PI * hz * t)).toInt().toShort()
            }
            emitted += n
            if (realtime) Thread.sleep(n * 1000L / sampleRate)
            return n
        }

        override fun release() {
            released = true
        }
    }

    /** Waits until the capture thread is done (source ended or limit hit). */
    private fun awaitFinished(recorder: VoiceoverRecorder, timeoutMs: Long) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (recorder.isRecording && System.currentTimeMillis() < deadline) Thread.sleep(10)
    }

    private fun readWav(file: File): Pair<IntArray, ShortArray> {
        val bytes = file.readBytes()
        assertEquals("wav must carry a RIFF header", "RIFF", String(bytes, 0, 4, Charsets.US_ASCII))
        assertEquals("wav must be WAVE", "WAVE", String(bytes, 8, 4, Charsets.US_ASCII))
        val header = ByteBuffer.wrap(bytes, 0, 44).order(ByteOrder.LITTLE_ENDIAN)
        val riffSize = header.getInt(4)
        val sampleRate = header.getInt(24)
        val channels = header.getShort(22).toInt()
        val bits = header.getShort(34).toInt()
        val dataSize = header.getInt(40)
        assertEquals("riff size must match the file", bytes.size - 8, riffSize)
        assertEquals("payload must match the declared data size", bytes.size - 44, dataSize)
        val samples = ShortArray(dataSize / 2)
        val payload = ByteBuffer.wrap(bytes, 44, dataSize).order(ByteOrder.LITTLE_ENDIAN)
        for (i in samples.indices) samples[i] = payload.short
        return intArrayOf(sampleRate, channels, bits) to samples
    }

    @Test
    fun a_take_is_published_as_a_valid_44k_mono_wav_of_the_recorded_length() {
        val root = tempRoot()
        val source = ToneSource(44_100, 440.0, 12_000.0, 44_100L)
        val recorder = VoiceoverRecorder(root, source)
        recorder.start("voiceover-test-1", maxDurationMs = 5_000)
        awaitFinished(recorder, 10_000)
        val take = recorder.stop()

        assertEquals("generated/voiceover-test-1.wav", take.relativePath)
        val file = File(root, take.relativePath)
        assertTrue("take file must exist", file.isFile)
        assertTrue("release must reach the source", source.released)

        val (format, samples) = readWav(file)
        assertEquals(44_100, format[0])
        assertEquals(1, format[1])
        assertEquals(16, format[2])
        assertTrue("take should hold ~1s of audio, got ${samples.size}", samples.size in 40_000..45_000)
        assertEquals("take duration should follow the sample count", take.durationMs, samples.size * 1000L / 44_100)
        assertEquals(file.length(), take.sizeBytes)

        // The published bytes are the source's bytes, not noise: RMS of a
        // 12000-amplitude sine is ~8485.
        var sumsq = 0.0
        for (sample in samples) sumsq += sample.toDouble() * sample.toDouble()
        val rms = sqrt(sumsq / samples.size)
        assertTrue("decoded RMS should match the source tone, was $rms", rms in 7_000.0..9_500.0)
    }

    @Test
    fun cancel_deletes_the_partial_take_and_publishes_nothing() {
        val root = tempRoot()
        val source = ToneSource(44_100, 440.0, 12_000.0, 44_100L)
        val recorder = VoiceoverRecorder(root, source, chunkSamples = 512)
        recorder.start("voiceover-cancel", maxDurationMs = 5_000)
        Thread.sleep(60)
        recorder.cancel()
        val generated = File(root, "generated")
        val leftovers = generated.listFiles().orEmpty().map { it.name }
        assertTrue("cancel must leave no wav behind, found $leftovers", leftovers.isEmpty())
        try {
            recorder.stop()
            fail("stop after cancel must not return a take")
        } catch (error: VoiceoverRecordingException) {
            assertEquals("NO_TAKE", error.code)
        }
    }

    @Test
    fun the_duration_limit_stops_the_recorder_without_losing_the_take() {
        val root = tempRoot()
        // A long source: only the recorder's own limit may end this take.
        val source = ToneSource(44_100, 300.0, 9_000.0, 44_100L * 30)
        val recorder = VoiceoverRecorder(root, source, chunkSamples = 1024)
        recorder.start("voiceover-limit", maxDurationMs = 400)
        awaitFinished(recorder, 10_000)
        assertTrue("recorder must stop itself at the limit", !recorder.isRecording)
        val take = recorder.stop()
        assertTrue("auto-stopped take must be published, duration=${take.durationMs}", take.durationMs >= 250)
        assertTrue("auto-stopped take must respect the limit, duration=${take.durationMs}", take.durationMs <= 900)
        assertTrue(File(root, take.relativePath).isFile)
    }

    @Test
    fun a_sub_250ms_take_is_refused_and_deleted_instead_of_inserted_silently() {
        val root = tempRoot()
        val source = ToneSource(44_100, 440.0, 12_000.0, 4_410L) // 100 ms
        val recorder = VoiceoverRecorder(root, source)
        recorder.start("voiceover-short", maxDurationMs = 5_000)
        awaitFinished(recorder, 5_000)
        try {
            recorder.stop()
            fail("a 100ms take must be refused")
        } catch (error: VoiceoverRecordingException) {
            assertEquals("TOO_SHORT", error.code)
        }
        val leftovers = File(root, "generated").listFiles().orEmpty().map { it.name }
        assertTrue("refused take must not be published, found $leftovers", leftovers.isEmpty())
    }

    @Test
    fun prune_only_removes_voiceover_files_the_project_no_longer_references() {
        val root = tempRoot()
        val generated = File(root, "generated").also { it.mkdirs() }
        File(generated, "voiceover-keep.wav").writeText("keep")
        File(generated, "voiceover-drop.wav").writeText("drop")
        File(generated, "voiceover-killed.wav.tmp").writeText("partial")
        File(generated, "2b9f7a11-0000-4fff-8000-abcdefabcdef.wav").writeText("library sound")

        val removed = VoiceoverTakeCleanup.pruneTakes(
            root,
            referencedPaths = listOf("generated/voiceover-keep.wav"),
        )

        assertEquals(
            listOf("generated/voiceover-drop.wav", "generated/voiceover-killed.wav.tmp").sorted(),
            removed.sorted(),
        )
        assertTrue(File(generated, "voiceover-keep.wav").isFile)
        assertTrue(
            "a library sound shares generated/ and must never be swept",
            File(generated, "2b9f7a11-0000-4fff-8000-abcdefabcdef.wav").isFile,
        )
        assertTrue(!File(generated, "voiceover-drop.wav").exists())
    }
}
