package app.cutlyra.editor.media.voiceover

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder

/**
 * The production [VoiceoverPcmSource]: 44.1 kHz mono 16-bit capture from the
 * device microphone via `AudioRecord`.
 *
 * Kept separate from [VoiceoverRecorder] so the recorder's file/limit/cancel
 * behaviour is JVM-testable with a deterministic source — a microphone cannot
 * be driven by CI, and a recorder that only works with one is untestable.
 */
class AudioRecordPcmSource(
    private val sampleRate: Int = VoiceoverRecorder.SAMPLE_RATE,
) : VoiceoverPcmSource {

    private val record: AudioRecord

    init {
        val minBufferBytes = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBufferBytes <= 0) {
            throw VoiceoverRecordingException(
                "this device cannot open a 44.1kHz mono microphone input (min buffer $minBufferBytes)",
                "MIC_UNAVAILABLE",
            )
        }
        // Two of the frame source's chunks, or the platform minimum — never
        // unbounded: the caller's file, not memory, holds the take.
        val bufferBytes = maxOf(minBufferBytes * 2, VoiceoverRecorder.CHUNK_SAMPLES * 2 * 4)
        record = try {
            AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.MIC)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                        .build(),
                )
                .setBufferSizeInBytes(bufferBytes)
                .build()
        } catch (error: Exception) {
            throw VoiceoverRecordingException(
                "could not open the microphone: ${error.message}",
                "MIC_UNAVAILABLE",
            )
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            throw VoiceoverRecordingException(
                "microphone is not initialized (another app may be recording)",
                "MIC_UNAVAILABLE",
            )
        }
        try {
            record.startRecording()
        } catch (error: Exception) {
            record.release()
            throw VoiceoverRecordingException(
                "could not start the microphone: ${error.message}",
                "MIC_UNAVAILABLE",
            )
        }
        if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            record.release()
            throw VoiceoverRecordingException(
                "microphone did not enter the recording state",
                "MIC_UNAVAILABLE",
            )
        }
    }

    override fun read(buffer: ShortArray, offset: Int, count: Int): Int =
        record.read(buffer, offset, count)

    override fun release() {
        try {
            record.stop()
        } catch (_: IllegalStateException) {
            // Already stopped — release below is what matters.
        }
        record.release()
    }
}
