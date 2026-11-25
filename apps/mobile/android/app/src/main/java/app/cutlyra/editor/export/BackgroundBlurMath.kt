package app.cutlyra.editor.export

import kotlin.math.max
import kotlin.math.min

/**
 * Geometry and intensity for Background Blur, kept pure so a plain JVM test can
 * pin it.
 *
 * Preview computes the same numbers from `background/blur.ts`
 * (`backgroundBlurSigma`) and the preview compositor's own fit/fill rect, and
 * both sides are tested against the SAME fixtures. Intensity is unitless:
 * 0 = off, 500 = heaviest. Sigma follows
 * `intensity / 5 * (resolution / reference)` exactly like the preview.
 *
 * The foreground is the SHARP layer: the processed frame (after crop,
 * rotation and transform, which is why this is computed from the frame the
 * shader actually receives) scaled to FIT the canvas. The backdrop is the same
 * frame scaled to FILL the canvas and blurred, so a portrait clip on a
 * landscape canvas gets a filled, blurred landscape backdrop behind a sharp,
 * fully visible portrait foreground — and the reverse for landscape-on-portrait.
 */
object BackgroundBlurMath {
    const val SIGMA_DIVISOR = 5.0f
    const val REFERENCE_WIDTH = 1920
    const val REFERENCE_HEIGHT = 1080
    const val INTENSITY_MIN = 0.0f
    const val INTENSITY_MAX = 500.0f

    data class Layout(
        val outputWidth: Int,
        val outputHeight: Int,
        /** Half-extents of the sharp foreground rect, as fractions of output. */
        val foregroundHalfU: Float,
        val foregroundHalfV: Float,
        /** Extents of the fill-cropped backdrop, as fractions of output. */
        val backdropScaleU: Float,
        val backdropScaleV: Float,
        /** One blur standard deviation in normalised backdrop UV. */
        val blurStepU: Float,
        val blurStepV: Float,
    )

    fun sigmaPixels(intensity: Float, resolution: Int, reference: Int): Float {
        val safe = intensity.coerceIn(INTENSITY_MIN, INTENSITY_MAX)
        return (safe / SIGMA_DIVISOR) * (resolution.toFloat() / reference.toFloat())
    }

    fun layout(
        sourceWidth: Int,
        sourceHeight: Int,
        outputWidth: Int,
        outputHeight: Int,
        intensity: Float,
    ): Layout {
        require(sourceWidth > 0 && sourceHeight > 0) { "source dimensions must be positive" }
        require(outputWidth > 0 && outputHeight > 0) { "output dimensions must be positive" }

        val fit = min(
            outputWidth.toFloat() / sourceWidth.toFloat(),
            outputHeight.toFloat() / sourceHeight.toFloat(),
        )
        val fill = max(
            outputWidth.toFloat() / sourceWidth.toFloat(),
            outputHeight.toFloat() / sourceHeight.toFloat(),
        )

        val foregroundWidth = sourceWidth * fit
        val foregroundHeight = sourceHeight * fit
        val backdropWidth = sourceWidth * fill
        val backdropHeight = sourceHeight * fill

        val sigmaX = sigmaPixels(intensity, outputWidth, REFERENCE_WIDTH)
        val sigmaY = sigmaPixels(intensity, outputHeight, REFERENCE_HEIGHT)

        return Layout(
            outputWidth = outputWidth,
            outputHeight = outputHeight,
            foregroundHalfU = (foregroundWidth / outputWidth) / 2f,
            foregroundHalfV = (foregroundHeight / outputHeight) / 2f,
            backdropScaleU = backdropWidth / outputWidth,
            backdropScaleV = backdropHeight / outputHeight,
            blurStepU = sigmaX / backdropWidth,
            blurStepV = sigmaY / backdropHeight,
        )
    }
}
