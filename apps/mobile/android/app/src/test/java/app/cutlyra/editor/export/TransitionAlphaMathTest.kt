package app.cutlyra.editor.export

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The one part of the cross-fade compositor (plan M9 risk #4) that is fully
 * verifiable on a plain JVM — see `TransitionAlphaMath`'s doc comment for
 * why everything downstream of this math (the actual Media3
 * `VideoCompositorSettings` wiring) cannot be.
 */
class TransitionAlphaMathTest {

    @Test
    fun `wipe is the only new kind painted above the base besides slide and push`() {
        assertTrue(TransitionAlphaMath.paintsHeadAboveBase("wipe"))
        assertTrue(TransitionAlphaMath.usesAlpha("fade"))
        assertTrue(TransitionAlphaMath.usesAlpha("dip-black"))
        assertTrue(TransitionAlphaMath.usesAlpha("dip-white"))
        assertTrue(TransitionAlphaMath.usesAlpha("blur"))
        assertFalse(TransitionAlphaMath.usesAlpha("wipe"))
    }

    @Test
    fun `dip colours are black and white and null for other kinds`() {
        assertEquals(0f, TransitionAlphaMath.dipColour("dip-black")!![0], 0.0001f)
        assertEquals(1f, TransitionAlphaMath.dipColour("dip-white")!![0], 0.0001f)
        assertEquals(null, TransitionAlphaMath.dipColour("blur"))
        assertEquals(TransitionAlphaMath.TransitionKind.BLUR, TransitionAlphaMath.classify("blur"))
        assertEquals(
            TransitionAlphaMath.TransitionKind.UNSUPPORTED_HARD_CUT,
            TransitionAlphaMath.classify("spiral"),
        )
    }

    @Test
    fun `dip ramps mirror around the midpoint`() {
        val start = 1_000_000L
        val end = 2_000_000L
        assertEquals(0f, TransitionAlphaMath.outgoingDipAmount(start, end, start), 0.0001f)
        assertEquals(1f, TransitionAlphaMath.outgoingDipAmount(start, end, 1_500_000), 0.0001f)
        assertEquals(1f, TransitionAlphaMath.outgoingDipAmount(start, end, end), 0.0001f)
        assertEquals(1f, TransitionAlphaMath.incomingDipAmount(start, end, start), 0.0001f)
        assertEquals(1f, TransitionAlphaMath.incomingDipAmount(start, end, 1_500_000), 0.0001f)
        assertEquals(0f, TransitionAlphaMath.incomingDipAmount(start, end, end), 0.0001f)
    }

    @Test
    fun `blur sigma is 12px at 1080p and resolves to zero by the window end`() {
        assertEquals(40f, TransitionAlphaMath.blurSigmaPixels(1080), 0.01f)
        assertEquals(20f, TransitionAlphaMath.blurSigmaPixels(540), 0.01f)
        assertEquals(
            40f,
            TransitionAlphaMath.incomingBlurSigma(1080, 0, 1_000_000, 0),
            0.01f,
        )
        assertEquals(
            20f,
            TransitionAlphaMath.incomingBlurSigma(1080, 0, 1_000_000, 500_000),
            0.01f,
        )
        assertEquals(
            0f,
            TransitionAlphaMath.incomingBlurSigma(1080, 0, 1_000_000, 1_000_000),
            0.01f,
        )
    }

    @Test
    fun `alpha is 0 at window start`() {
        val window = TransitionAlphaMath.Window(startUs = 1_000_000, endUs = 1_500_000)
        assertEquals(0f, TransitionAlphaMath.alphaAt(window, 1_000_000), 0.0001f)
    }

    @Test
    fun `alpha is 1 at window end`() {
        val window = TransitionAlphaMath.Window(startUs = 1_000_000, endUs = 1_500_000)
        assertEquals(1f, TransitionAlphaMath.alphaAt(window, 1_500_000), 0.0001f)
    }

    @Test
    fun `alpha is linear at the midpoint`() {
        val window = TransitionAlphaMath.Window(startUs = 0, endUs = 1_000_000)
        assertEquals(0.5f, TransitionAlphaMath.alphaAt(window, 500_000), 0.0001f)
    }

    @Test
    fun `alpha is linear at an asymmetric point`() {
        // 300ms into a 1200ms window -> 25%.
        val window = TransitionAlphaMath.Window(startUs = 2_000_000, endUs = 3_200_000)
        assertEquals(0.25f, TransitionAlphaMath.alphaAt(window, 2_300_000), 0.0001f)
    }

    @Test
    fun `alpha clamps to 0 before the window (defensive against timestamp jitter)`() {
        val window = TransitionAlphaMath.Window(startUs = 1_000_000, endUs = 2_000_000)
        assertEquals(0f, TransitionAlphaMath.alphaAt(window, 999_000), 0.0001f)
    }

    @Test
    fun `alpha clamps to 1 after the window (defensive against timestamp jitter)`() {
        val window = TransitionAlphaMath.Window(startUs = 1_000_000, endUs = 2_000_000)
        assertEquals(1f, TransitionAlphaMath.alphaAt(window, 2_000_500), 0.0001f)
    }

    @Test
    fun `window requires endUs greater than startUs`() {
        assertThrows(IllegalArgumentException::class.java) {
            TransitionAlphaMath.Window(startUs = 1_000, endUs = 1_000)
        }
        assertThrows(IllegalArgumentException::class.java) {
            TransitionAlphaMath.Window(startUs = 2_000, endUs = 1_000)
        }
    }

    @Test
    fun `classify recognizes crossfade spellings`() {
        assertEquals(TransitionAlphaMath.TransitionKind.CROSSFADE, TransitionAlphaMath.classify("crossfade"))
        assertEquals(TransitionAlphaMath.TransitionKind.CROSSFADE, TransitionAlphaMath.classify("cross-fade"))
        assertEquals(TransitionAlphaMath.TransitionKind.CROSSFADE, TransitionAlphaMath.classify("cross_fade"))
        assertEquals(TransitionAlphaMath.TransitionKind.CROSSFADE, TransitionAlphaMath.classify("dissolve"))
        assertEquals(TransitionAlphaMath.TransitionKind.CROSSFADE, TransitionAlphaMath.classify("CrossFade"))
    }

    @Test
    fun `classify recognizes the Phase 3 motion kinds`() {
        assertEquals(TransitionAlphaMath.TransitionKind.SLIDE, TransitionAlphaMath.classify("slide"))
        assertEquals(TransitionAlphaMath.TransitionKind.PUSH, TransitionAlphaMath.classify("push"))
        assertEquals(TransitionAlphaMath.TransitionKind.ZOOM, TransitionAlphaMath.classify("zoom"))
        assertEquals(TransitionAlphaMath.TransitionKind.CROSSFADE, TransitionAlphaMath.classify("fade"))
    }

    @Test
    fun `classify degrades unknown kinds to a hard cut, not a crash`() {
        assertEquals(TransitionAlphaMath.TransitionKind.UNSUPPORTED_HARD_CUT, TransitionAlphaMath.classify("spiral"))
        assertEquals(TransitionAlphaMath.TransitionKind.UNSUPPORTED_HARD_CUT, TransitionAlphaMath.classify("dip_to_purple"))
        assertEquals(TransitionAlphaMath.TransitionKind.UNSUPPORTED_HARD_CUT, TransitionAlphaMath.classify(""))
        assertEquals(TransitionAlphaMath.TransitionKind.UNSUPPORTED_HARD_CUT, TransitionAlphaMath.classify("nonsense"))
    }

    @Test
    fun `only crossfade and zoom ramp the base alpha`() {
        assertTrue(TransitionAlphaMath.usesAlpha("cross_fade"))
        assertTrue(TransitionAlphaMath.usesAlpha("fade"))
        assertTrue(TransitionAlphaMath.usesAlpha("zoom"))
        assertFalse(TransitionAlphaMath.usesAlpha("slide"))
        assertFalse(TransitionAlphaMath.usesAlpha("push"))
    }

    @Test
    fun `slide and push paint their incoming head above the base`() {
        assertTrue(TransitionAlphaMath.paintsHeadAboveBase("slide"))
        assertTrue(TransitionAlphaMath.paintsHeadAboveBase("push"))
        assertFalse(TransitionAlphaMath.paintsHeadAboveBase("cross_fade"))
        assertFalse(TransitionAlphaMath.paintsHeadAboveBase("zoom"))
    }
}
