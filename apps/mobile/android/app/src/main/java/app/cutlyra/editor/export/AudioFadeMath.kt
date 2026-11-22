package app.cutlyra.editor.export

import app.cutlyra.editor.edl.EdlAudioFade
import app.cutlyra.editor.edl.EdlRational
import kotlin.math.roundToLong

/**
 * The per-sample fade envelope, mirroring the TS `audioFadeGainAt` in
 * `packages/editor-core/src/timeline/audio-fades.ts` exactly.
 *
 * It lives in its own object, with no Android imports, so the ramp shape is
 * covered by a plain JVM unit test (`AudioFadeMathTest`) rather than only by
 * an emulator run. `ClipGainAudioProcessor` is the only production consumer.
 *
 * Why sample counting instead of a Media3 time API: an audio processor sees
 * PCM, not timestamps. For an export each clip's stream is decoded once from
 * its trim start and played through without seeking, so the count of frames
 * pushed through the processor IS the clip's elapsed audio. `onFlush`
 * resets it, which is the one point Media3 can restart that stream.
 */
internal object AudioFadeMath {

    /**
     * Linear ramp from 0 to unity over `fadeInFrames`, and from unity back to
     * 0 over the last `fadeOutFrames`. Where the two ramps overlap, the
     * SMALLER gain wins (a min, not a sum), matching the TS implementation so
     * a heavily faded short clip dips through silence rather than
     * overshooting.
     *
     * `frameIndex` is 0-based; `frameCount` is the clip's total decoded
     * frames. A stream longer than expected keeps the fade-out at 0 (silence)
     * rather than wrapping back up, which fails loudly in the ramp tests
     * instead of producing a surprise burst.
     */
    fun gainAt(
        frameIndex: Long,
        frameCount: Long,
        fadeInFrames: Long,
        fadeOutFrames: Long,
    ): Float {
        if (frameCount <= 0L) return 1f
        val fadeInGain =
            if (fadeInFrames > 0L) {
                (frameIndex.toDouble() / fadeInFrames.toDouble()).coerceIn(0.0, 1.0)
            } else {
                1.0
            }
        val remaining = frameCount - frameIndex
        val fadeOutGain =
            if (fadeOutFrames > 0L) {
                (remaining.toDouble() / fadeOutFrames.toDouble()).coerceIn(0.0, 1.0)
            } else {
                1.0
            }
        return minOf(fadeInGain, fadeOutGain).toFloat()
    }

    /**
     * Fade length in TICKS on the clip's TIMELINE -> decoded SOURCE frames.
     *
     * The envelope is authored against the timeline span, but a processor
     * sees source PCM. At `speed` 2/1 twice as many source seconds pass per
     * timeline second, so the window grows by the same rational. This is the
     * one conversion between the two clocks; nothing downstream re-derives
     * it.
     */
    fun sourceFramesForTicks(
        ticks: Long,
        ticksPerSecond: Long,
        sampleRate: Int,
        speed: EdlRational,
    ): Long {
        if (ticks <= 0L || ticksPerSecond <= 0L || sampleRate <= 0) return 0L
        val seconds = ticks.toDouble() / ticksPerSecond.toDouble()
        val sourceSeconds = seconds * speed.toDouble()
        return (sourceSeconds * sampleRate).roundToLong().coerceAtLeast(0L)
    }

    /** Convenience for the processor: both fade windows of an EDL clip, in
     *  source frames, plus the total source frame count the ramps are
     *  measured against. */
    data class Windows(
        val fadeInFrames: Long,
        val fadeOutFrames: Long,
        val totalFrames: Long,
    )

    fun windowsFor(
        fade: EdlAudioFade,
        sourceDurationTicks: Long,
        ticksPerSecond: Long,
        sampleRate: Int,
        speed: EdlRational,
    ): Windows = Windows(
        fadeInFrames = sourceFramesForTicks(fade.inTicks, ticksPerSecond, sampleRate, speed),
        fadeOutFrames = sourceFramesForTicks(fade.outTicks, ticksPerSecond, sampleRate, speed),
        totalFrames = sourceFramesForTicks(sourceDurationTicks, ticksPerSecond, sampleRate, speed),
    )
}
