package app.cutlyra.editor.export

import androidx.media3.common.C
import androidx.media3.common.audio.SpeedProvider

/**
 * A single constant speed for a clip's whole duration — `EdlClip.speed` is
 * one rational per clip (no speed *ramp* within a clip in v1; that's a
 * keyframed-animation feature and out of v1's effect surface, plan §2.3
 * rule 4). Media3's `SpeedProvider` interface is designed for
 * variable-rate speed ramps (`getNextSpeedChangeTimeUs`); a constant-rate
 * clip just always answers "no more changes."
 */
class ConstantSpeedProvider(private val speed: Float) : SpeedProvider {
    init {
        require(speed > 0f) { "speed must be > 0, got $speed" }
    }

    override fun getSpeed(timeUs: Long): Float = speed

    override fun getNextSpeedChangeTimeUs(timeUs: Long): Long {
        // Stage 11 physical QA (iQOO I2221): returning `Long.MAX_VALUE` here
        // made media3's SpeedProviderMapper treat "no more changes" as a real
        // change at +infinity — its `next > inputUs` precondition then failed
        // (MAX_VALUE > MAX_VALUE) and `Transformer.start()` threw an
        // IllegalStateException, aborting EVERY export that contained a clip
        // with a speed change. The "no more changes" sentinel media3
        // understands is C.TIME_UNSET, not MAX_VALUE.
        return C.TIME_UNSET
    }
}
