package app.cutlyra.editor.export

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * These fixtures are duplicated in `background/__tests__/blur.test.ts`. Both
 * suites assert the SAME numbers, so preview and export cannot drift apart on
 * intensity or on foreground/backdrop geometry.
 */
class BackgroundBlurMathTest {
    private fun assertClose(expected: Float, actual: Float, tolerance: Float = 1e-5f) {
        assertEquals(expected.toDouble(), actual.toDouble(), tolerance.toDouble())
    }

    @Test
    fun sigmaMatchesTheSharedFormula() {
        // intensity 200 at 1280x720 -> 200/5 * (1280/1920), 200/5 * (720/1080)
        assertClose(26.666667f, BackgroundBlurMath.sigmaPixels(200f, 1280, 1920), 1e-4f)
        assertClose(26.666667f, BackgroundBlurMath.sigmaPixels(200f, 720, 1080), 1e-4f)
        // Clamped at the UI maximum (500 / 5 * 1920/1920 = 100).
        assertClose(100f, BackgroundBlurMath.sigmaPixels(9999f, 1920, 1920), 1e-4f)
        assertEquals(0f, BackgroundBlurMath.sigmaPixels(-5f, 1920, 1920), 1e-6f)
    }

    @Test
    fun portraitSourceOnLandscapeCanvasFitsAndFillsCorrectly() {
        val layout = BackgroundBlurMath.layout(
            sourceWidth = 240,
            sourceHeight = 320,
            outputWidth = 1280,
            outputHeight = 720,
            intensity = 200f,
        )
        // fit = min(5.333, 2.25) = 2.25 -> 540x720 foreground, half extents.
        assertClose(0.2109375f, layout.foregroundHalfU)
        assertClose(0.5f, layout.foregroundHalfV)
        // fill = max(5.333, 2.25) = 5.333 -> backdrop is 1280x1706.67.
        assertClose(1.0f, layout.backdropScaleU)
        assertClose(2.3703704f, layout.backdropScaleV, 1e-5f)
        assertClose(26.666667f / 1280f, layout.blurStepU, 1e-7f)
        assertClose(26.666667f / 1706.6667f, layout.blurStepV, 1e-7f)
    }

    @Test
    fun landscapeSourceOnPortraitCanvasFitsAndFillsCorrectly() {
        val layout = BackgroundBlurMath.layout(
            sourceWidth = 320,
            sourceHeight = 240,
            outputWidth = 720,
            outputHeight = 1280,
            intensity = 200f,
        )
        assertClose(0.5f, layout.foregroundHalfU)
        assertClose(0.2109375f, layout.foregroundHalfV)
        assertClose(2.3703704f, layout.backdropScaleU, 1e-5f)
        assertClose(1.0f, layout.backdropScaleV)
    }

    @Test
    fun matchingAspectIsAFullFrameNoOpGeometry() {
        val layout = BackgroundBlurMath.layout(1280, 720, 1280, 720, 100f)
        assertClose(0.5f, layout.foregroundHalfU)
        assertClose(0.5f, layout.foregroundHalfV)
        assertClose(1.0f, layout.backdropScaleU)
        assertClose(1.0f, layout.backdropScaleV)
    }
}
