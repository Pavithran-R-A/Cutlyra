package app.cutlyra.editor.export

import app.cutlyra.editor.edl.EdlMask
import app.cutlyra.editor.edl.EdlTransform
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Shared, pure mask geometry for the Android exporter.
 *
 * WHERE THE MASK RUNS. The preview builds a mask texture at the element's
 * on-canvas size, draws the engine's own shape into it, and then places that
 * texture with the element's quad transform (see
 * `services/renderer/compositor/frame-descriptor.ts`: the mask canvas is
 * `Math.round(transform.width) x Math.round(transform.height)` and `params`
 * fractions are relative to it). Android's mask is a fragment pass, so it sees
 * whatever frame reaches that point in the effect chain:
 *
 *  - `Crop` changes the frame size, so Media3 runs it inline: the mask pass's
 *    input frame is the CROPPED frame (verified on decoded MP4s — a mask on a
 *    left-half crop lands inside the cropped frame, not on the source);
 *  - `EdlTransformEffect` and the per-item `Presentation` are size-preserving
 *    matrices that Media3 applies to the finished chain, so the mask runs
 *    BEFORE the element's scale/rotation/position. That is why an overlay
 *    offset by (-80,-80) keeps its mask on the clip once the mask pass comes
 *    first in the effect list (measured on decoded frames), and why element
 *    position/rotation must not move these uniforms.
 *
 * So the mask is authored in CROPPED-FRAME pixels, exactly like the preview's
 * element canvas:
 *  - centre = `(0.5 + centerX, 0.5 + centerY)` of the cropped frame;
 *  - size = `width`/`height` fractions of it (`circle` keeps
 *    `min(width*cropW, width*cropH)` so it stays round);
 *  - rotation = the mask's own rotation; the element rotation rides the matrix;
 *  - feather is authored in PROJECT-CANVAS pixels, so it is divided by the
 *    on-canvas pixels-per-cropped-pixel scale (`framingScale * |scale|`) and
 *    the deferred matrix restores the authored on-screen width.
 *
 * Pure Kotlin so the per-shape expectations are JVM-testable without an
 * emulator; `ExportMaskInstrumentedTest` proves the decoded MP4.
 */
object MaskMath {
    /** `shape` uniform values used by the GL shader. */
    const val SHAPE_RECTANGLE = 0f
    const val SHAPE_ELLIPSE = 1f
    const val SHAPE_LINEAR = 2f

    data class Uniforms(
        val shape: Float,
        /** Centre in cropped-frame pixels. */
        val centerX: Float,
        val centerY: Float,
        /** Half extents in cropped-frame pixels (ellipse/circle) or box half-size. */
        val halfWidth: Float,
        val halfHeight: Float,
        /** Mask rotation, radians (the element transform is applied later). */
        val rotationRadians: Float,
        /** Feather radius in cropped-frame pixels, centred on the edge. */
        val featherPixels: Float,
        val inverted: Boolean,
    )

    fun uniformsFor(
        /** The frame this pass receives: the clip's CROPPED frame. */
        inputWidth: Int,
        inputHeight: Int,
        mask: EdlMask,
        transform: EdlTransform,
        framing: String,
        /** Project canvas, where feather is authored. */
        canvasWidth: Int,
        canvasHeight: Int,
    ): Uniforms? {
        val type = mask.type
        val shape = when (type) {
            "rectangle" -> SHAPE_RECTANGLE
            "ellipse", "circle" -> SHAPE_ELLIPSE
            "split", "linear" -> SHAPE_LINEAR
            else -> return null
        }
        if (inputWidth <= 0 || inputHeight <= 0 || canvasWidth <= 0 || canvasHeight <= 0) {
            return null
        }

        // On-canvas pixels per CROPPED pixel: the cropped frame is fitted (or
        // filled) into the project canvas, then the element scale applies.
        // Feather is authored against that on-canvas element.
        val framingScale = if (framing == "fill") {
            max(canvasWidth.toDouble() / inputWidth, canvasHeight.toDouble() / inputHeight)
        } else {
            min(canvasWidth.toDouble() / inputWidth, canvasHeight.toDouble() / inputHeight)
        }
        val displayScaleX = max(1e-6, framingScale * abs(transform.scaleX))
        val displayScaleY = max(1e-6, framingScale * abs(transform.scaleY))

        val centerX = number(mask.params, "centerX")
        val centerY = number(mask.params, "centerY")
        val widthParam = number(mask.params, "width", 0.6)
        val heightParam = number(mask.params, "height", widthParam)
        val halfW: Double
        val halfH: Double
        when (type) {
            "circle" -> {
                // Round in cropped pixels; the deferred matrix restores the
                // on-canvas circle the preview draws.
                val radius = min(widthParam * inputWidth, widthParam * inputHeight) / 2.0
                halfW = radius
                halfH = radius
            }
            "rectangle", "ellipse" -> {
                halfW = widthParam * inputWidth / 2.0
                halfH = heightParam * inputHeight / 2.0
            }
            else -> {
                halfW = 0.0
                halfH = 0.0
            }
        }

        val feather = number(mask.params, "feather").coerceIn(0.0, 1000.0)
        val featherScale = (displayScaleX + displayScaleY) / 2.0
        return Uniforms(
            shape = shape,
            centerX = ((0.5 + centerX) * inputWidth).toFloat(),
            centerY = ((0.5 + centerY) * inputHeight).toFloat(),
            halfWidth = max(0.5f, halfW.toFloat()),
            halfHeight = max(0.5f, halfH.toFloat()),
            rotationRadians = (number(mask.params, "rotation") * PI / 180.0).toFloat(),
            featherPixels = (feather / featherScale).toFloat(),
            inverted = mask.params["inverted"] == true,
        )
    }

    /**
     * The exact alpha the fragment shader computes, in Kotlin, in cropped-frame
     * pixel space with y pointing DOWN. Used by the JVM tests so
     * centre/edge/outside/feather-ramp expectations are asserted against the
     * same math the GPU runs.
     */
    fun alphaAt(uniforms: Uniforms, pixelX: Float, pixelY: Float): Float {
        val px = pixelX - uniforms.centerX
        val py = pixelY - uniforms.centerY
        val c = cos(-uniforms.rotationRadians.toDouble())
        val s = sin(-uniforms.rotationRadians.toDouble())
        val rotatedX = px * c - py * s
        val rotatedY = px * s + py * c
        val halfW = uniforms.halfWidth.toDouble()
        val halfH = uniforms.halfHeight.toDouble()
        val distance = when (uniforms.shape) {
            SHAPE_RECTANGLE -> {
                val dx = abs(rotatedX) - halfW
                val dy = abs(rotatedY) - halfH
                val outside = Math.hypot(max(dx, 0.0), max(dy, 0.0))
                -(outside + min(max(dx, dy), 0.0))
            }
            SHAPE_ELLIPSE -> {
                val k = Math.hypot(rotatedX / halfW, rotatedY / halfH)
                (1.0 - k) * min(halfW, halfH)
            }
            else -> rotatedX
        }
        val halfFeather = uniforms.featherPixels / 2.0
        val t = if (halfFeather <= 1e-6) {
            if (distance >= 0.0) 1.0 else 0.0
        } else {
            val x = ((distance + halfFeather) / (2.0 * halfFeather)).coerceIn(0.0, 1.0)
            x * x * (3.0 - 2.0 * x)
        }
        val alpha = if (uniforms.inverted) 1.0 - t else t
        return alpha.toFloat()
    }

    private fun number(
        params: Map<String, Any?>,
        key: String,
        fallback: Double = 0.0,
    ): Double {
        val value = when (val raw = params[key]) {
            is Number -> raw.toDouble()
            is String -> raw.toDoubleOrNull()
            else -> null
        }
        return if (value != null && value.isFinite()) value else fallback
    }
}
