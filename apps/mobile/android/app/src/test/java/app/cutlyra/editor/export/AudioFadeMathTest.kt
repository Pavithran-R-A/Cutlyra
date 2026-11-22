package app.cutlyra.editor.export

import app.cutlyra.editor.edl.EdlAudioFade
import app.cutlyra.editor.edl.EdlRational
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The fade envelope's ramp shape, at sample resolution. Plain JVM — no
 * emulator, no Android framework — so the math CI can run everywhere is
 * covered everywhere, while `ExportAudioFadeInstrumentedTest` covers the
 * part that needs a real Media3 export.
 *
 * These expectations are the same numbers the TS side asserts in
 * `packages/editor-core/src/timeline/__tests__/audio-fades.test.ts`
 * (`audioFadeGainAt`): 0 at the first sample, linear, unity in the middle,
 * 0 at the last sample, and the smaller gain where the two ramps overlap.
 */
class AudioFadeMathTest {

    @Test
    fun `ramp rises linearly and falls to silence at the end`() {
        val total = 1000L
        val fadeIn = 200L
        val fadeOut = 400L
        assertEquals(0f, AudioFadeMath.gainAt(0, total, fadeIn, fadeOut), 0f)
        assertEquals(0.5f, AudioFadeMath.gainAt(100, total, fadeIn, fadeOut), 1e-6f)
        assertEquals(1f, AudioFadeMath.gainAt(200, total, fadeIn, fadeOut), 1e-6f)
        assertEquals(1f, AudioFadeMath.gainAt(500, total, fadeIn, fadeOut), 1e-6f)
        assertEquals(0.5f, AudioFadeMath.gainAt(800, total, fadeIn, fadeOut), 1e-6f)
        assertEquals(0f, AudioFadeMath.gainAt(1000, total, fadeIn, fadeOut), 0f)
    }

    @Test
    fun `no fade is unity everywhere`() {
        val total = 1000L
        for (index in longArrayOf(0, 1, 500, 999, 1000)) {
            assertEquals(1f, AudioFadeMath.gainAt(index, total, 0, 0), 0f)
        }
    }

    @Test
    fun `overlapping ramps take the smaller gain, never above unity`() {
        val total = 1000L
        val gain = AudioFadeMath.gainAt(500, total, 800, 800)
        assertEquals(0.625f, gain, 1e-6f)
        for (index in 0L..total) {
            val sampled = AudioFadeMath.gainAt(index, total, 800, 800)
            assert(sampled in 0f..1f) { "gain out of range at $index: $sampled" }
        }
    }

    @Test
    fun `timeline ticks convert to source frames through the speed ratio`() {
        // 1s of timeline at 1x, 44.1 kHz.
        assertEquals(
            44_100L,
            AudioFadeMath.sourceFramesForTicks(
                ticks = 120_000,
                ticksPerSecond = 120_000,
                sampleRate = 44_100,
                speed = EdlRational(1, 1),
            ),
        )
        // Half a second of timeline at 2x consumes 1s of source.
        assertEquals(
            44_100L,
            AudioFadeMath.sourceFramesForTicks(
                ticks = 60_000,
                ticksPerSecond = 120_000,
                sampleRate = 44_100,
                speed = EdlRational(2, 1),
            ),
        )
    }

    @Test
    fun `windows carry both ramps and the clip's total source frames`() {
        val windows = AudioFadeMath.windowsFor(
            fade = EdlAudioFade(inTicks = 120_000, outTicks = 60_000),
            sourceDurationTicks = 240_000,
            ticksPerSecond = 120_000,
            sampleRate = 44_100,
            speed = EdlRational(1, 1),
        )
        assertEquals(44_100L, windows.fadeInFrames)
        assertEquals(22_050L, windows.fadeOutFrames)
        assertEquals(88_200L, windows.totalFrames)
    }
}
