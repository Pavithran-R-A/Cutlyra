package app.cutlyra.editor.export

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import app.cutlyra.editor.edl.EdlAudioFade
import app.cutlyra.editor.edl.EdlRational
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * Media3 audio processors for the export's gain stage.
 *
 * Both sit at media3's PCM chain boundary, which is 16-bit: `AudioGraphInput`
 * asserts `C.ENCODING_PCM_16BIT` and rejects a processor that changes the
 * encoding ("AudioGraphInput reconfiguration" — hit for real when this first
 * declared float output). So the wire format stays int16 and the arithmetic
 * happens in float internally, which is the whole point: a boosted clip would
 * otherwise be clamped to the int16 range at this boundary, before anything
 * had a chance to limit it.
 */
internal abstract class Int16AudioProcessor : BaseAudioProcessor() {

    override fun onConfigure(
        inputAudioFormat: AudioProcessor.AudioFormat,
    ): AudioProcessor.AudioFormat {
        if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT) {
            throw AudioProcessor.UnhandledAudioFormatException(inputAudioFormat)
        }
        // Identity format — see the class comment.
        return inputAudioFormat
    }

    /** Transforms one block of interleaved samples, in place, in float. */
    protected abstract fun transform(samples: FloatArray, count: Int)

    private var scratch = FloatArray(0)

    override fun queueInput(inputBuffer: ByteBuffer) {
        val sampleCount = inputBuffer.remaining() / 2
        if (sampleCount == 0) return
        if (scratch.size < sampleCount) scratch = FloatArray(sampleCount)

        val shorts = inputBuffer.order(ByteOrder.nativeOrder()).asShortBuffer()
        for (i in 0 until sampleCount) scratch[i] = shorts.get(i) / 32768f
        inputBuffer.position(inputBuffer.limit())

        transform(scratch, sampleCount)

        val output = replaceOutputBuffer(sampleCount * 2)
        for (i in 0 until sampleCount) {
            // The limiter guarantees |sample| <= ceiling < 1, so this clamp is
            // a belt-and-braces guard against a NaN or an un-limited path,
            // never the thing shaping the audio.
            val clamped = scratch[i].coerceIn(-1f, 1f)
            output.putShort((clamped * 32767f).roundToInt().toShort())
        }
        output.flip()
    }
}

/**
 * Per-clip volume, limited in the same pass.
 *
 * Two bugs died here. iOS has applied `EdlClip.volumeDb` since M9 via
 * `AVMutableAudioMixInputParameters`; Android PARSED the field and then
 * dropped it, so the volume slider did nothing at all in an Android export.
 * And the boost has to be applied *into* the limiter rather than through a
 * separate upstream gain stage — media3's own `GainProcessor` narrows back to
 * int16 with a raw cast (its documented gain range is 0..1, it is built for
 * fades), so a +20 dB boost through it would wrap around before any limiter
 * downstream ever saw the signal.
 */
internal class ClipGainAudioProcessor(
    volumeDb: Double,
    /** Clip fade envelope, or `null` for a clip that never set one — the
     *  unchanged legacy path (a constant gain). */
    private val audioFade: EdlAudioFade? = null,
    private val ticksPerSecond: Long = 120_000L,
    private val speed: EdlRational = EdlRational(1, 1),
    /** Source ticks this item decodes; the fade-out is measured from its end. */
    private val sourceDurationTicks: Long = 0L,
) : Int16AudioProcessor() {
    private val linearGain: Float = 10.0.pow(volumeDb / 20.0).toFloat()
    private var limiter: LookaheadLimiter? = null

    /** Interleaved channels in the incoming PCM; the envelope is per FRAME. */
    private var channels: Int = 1
    /** Non-null only when this clip actually fades. */
    private var windows: AudioFadeMath.Windows? = null
    private var framesProcessed: Long = 0L

    private val hasFade: Boolean =
        audioFade != null && (audioFade.inTicks > 0L || audioFade.outTicks > 0L)

    override fun isActive(): Boolean =
        super.isActive() && (hasFade || kotlin.math.abs(linearGain - 1f) > 1e-4f)

    override fun onConfigure(
        inputAudioFormat: AudioProcessor.AudioFormat,
    ): AudioProcessor.AudioFormat {
        val format = super.onConfigure(inputAudioFormat)
        limiter = LookaheadLimiter(sampleRate = format.sampleRate)
        channels = format.channelCount.coerceAtLeast(1)
        framesProcessed = 0L
        val fade = audioFade
        windows = if (hasFade && fade != null) {
            AudioFadeMath.windowsFor(
                fade = fade,
                sourceDurationTicks = sourceDurationTicks,
                ticksPerSecond = ticksPerSecond,
                sampleRate = format.sampleRate,
                speed = speed,
            )
        } else {
            null
        }
        return format
    }

    override fun onFlush() {
        limiter = null
        // Media3 restarts the stream at flush; the fade clock restarts with
        // it (an export never seeks mid-clip, so this only happens between
        // items or on reconfiguration).
        framesProcessed = 0L
    }

    override fun transform(samples: FloatArray, count: Int) {
        val fade = windows
        if (fade == null) {
            for (i in 0 until count) samples[i] *= linearGain
        } else {
            val frameCount = count / channels
            for (frame in 0 until frameCount) {
                val envelope = AudioFadeMath.gainAt(
                    frameIndex = framesProcessed + frame,
                    frameCount = fade.totalFrames,
                    fadeInFrames = fade.fadeInFrames,
                    fadeOutFrames = fade.fadeOutFrames,
                )
                val gain = linearGain * envelope
                val base = frame * channels
                for (channel in 0 until channels) {
                    samples[base + channel] *= gain
                }
            }
            framesProcessed += frameCount
        }
        // Limited here too, not just at the mix: this processor's own output
        // goes back out as int16, so a boosted clip would be clamped at THIS
        // boundary before the mixer ever saw it.
        limiter?.process(samples, 0, count)
    }
}
