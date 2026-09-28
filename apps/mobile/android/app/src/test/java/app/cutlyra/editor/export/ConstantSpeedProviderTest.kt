package app.cutlyra.editor.export

import androidx.media3.common.C
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Regression coverage for the Stage 11 iQOO physical-device export crash:
 *  `getNextSpeedChangeTimeUs` MUST answer media3's "no more changes" sentinel
 *  (`C.TIME_UNSET`), not `Long.MAX_VALUE`. `SpeedProviderMapper` treats any
 *  other value as a real speed change and fails its own `next > inputUs`
 *  precondition when the answer is `MAX_VALUE`, so `Transformer.start()`
 *  threw IllegalStateException and every export containing a speed-changed
 *  clip aborted before writing a single frame. */
class ConstantSpeedProviderTest {
    @Test
    fun `no-more-changes sentinel is C TIME_UNSET, not MAX_VALUE`() {
        val provider = ConstantSpeedProvider(1.91f)
        assertEquals(C.TIME_UNSET, provider.getNextSpeedChangeTimeUs(0L))
        assertEquals(C.TIME_UNSET, provider.getNextSpeedChangeTimeUs(1_000_000L))
        assertTrue("sentinel must not be Long.MAX_VALUE", provider.getNextSpeedChangeTimeUs(0L) != Long.MAX_VALUE)
    }

    @Test
    fun `getSpeed is constant across time`() {
        val provider = ConstantSpeedProvider(0.5f)
        assertEquals(0.5f, provider.getSpeed(0L))
        assertEquals(0.5f, provider.getSpeed(123_456L))
    }

    @Test
    fun `rejects non-positive speed`() {
        assertThrows(IllegalArgumentException::class.java) { ConstantSpeedProvider(0f) }
        assertThrows(IllegalArgumentException::class.java) { ConstantSpeedProvider(-1.5f) }
    }
}
