package app.cutlyra.editor.export

import app.cutlyra.editor.edl.EdlAnimationChannel
import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlCrop
import app.cutlyra.editor.edl.EdlKeyframe
import app.cutlyra.editor.edl.EdlMask
import app.cutlyra.editor.edl.EdlRational
import app.cutlyra.editor.edl.EdlTransform
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The exporter's mask geometry and alpha ramp, asserted with the same math the
 * GL shader runs (`MaskMath.alphaAt`). The decoded-MP4 proof that the shader
 * actually produces these pixels is `ExportMaskInstrumentedTest`.
 *
 * Everything here is in INPUT (cropped-frame) pixels: Media3 applies
 * `EdlTransformEffect`/`Presentation` as a `MatrixTransformation` to the
 * finished effect chain, so the mask pass sees the un-transformed cropped
 * frame and the matrix then moves the masked picture as one unit. Element
 * position and rotation therefore must NOT move the mask geometry.
 */
class MaskMathTest {
    private fun clip(
        transform: EdlTransform = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0),
        crop: EdlCrop = EdlCrop(),
        animations: List<EdlAnimationChannel> = emptyList(),
    ) = EdlClip(
        clipId = "clip-1",
        kind = "video",
        assetId = "asset-1",
        name = "clip",
        startTicks = 0,
        durationTicks = 1_200_000L,
        sourceStartTicks = 0,
        sourceEndTicks = 1_200_000L,
        speed = EdlRational(1, 1),
        maintainPitch = false,
        volumeDb = 0.0,
        muted = true,
        hidden = false,
        transform = transform,
        opacity = 1.0,
        crop = crop,
        effects = emptyList(),
        hasMasks = true,
        animations = animations,
        params = emptyMap(),
    )

    private fun mask(type: String, params: Map<String, Any?>) = EdlMask(
        maskId = "mask-1",
        type = type,
        params = params,
    )

    private fun box(
        type: String,
        centerX: Double = 0.0,
        centerY: Double = 0.0,
        width: Double = 0.6,
        height: Double = 0.6,
        rotation: Double = 0.0,
        feather: Double = 0.0,
        inverted: Boolean = false,
    ) = mask(
        type,
        mapOf(
            "centerX" to centerX,
            "centerY" to centerY,
            "width" to width,
            "height" to height,
            "rotation" to rotation,
            "feather" to feather,
            "inverted" to inverted,
        ),
    )

    private fun uniforms(
        mask: EdlMask,
        transform: EdlTransform = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0),
        crop: EdlCrop = EdlCrop(),
        /** Full source size; `crop` turns it into the cropped frame. */
        inputWidth: Int = 1000,
        inputHeight: Int = 1000,
        canvasWidth: Int = 1000,
        canvasHeight: Int = 1000,
    ) = MaskMath.uniformsFor(
        // Media3's `Crop` resizes the frame inline, so this pass receives the
        // cropped frame — the space these expectations are written in.
        inputWidth = Math.round(inputWidth * crop.width).toInt(),
        inputHeight = Math.round(inputHeight * crop.height).toInt(),
        mask = mask,
        transform = transform,
        framing = "fit",
        canvasWidth = canvasWidth,
        canvasHeight = canvasHeight,
    )

    @Test
    fun rectangle_centreIsOpaqueOutsideIsTransparent() {
        val u = uniforms(box("rectangle"))!!
        assertEquals(500f, u.centerX, 0.01f)
        assertEquals(500f, u.centerY, 0.01f)
        assertEquals(300f, u.halfWidth, 0.01f)
        assertEquals(300f, u.halfHeight, 0.01f)
        assertEquals(1f, MaskMath.alphaAt(u, 500f, 500f), 0.001f)
        assertEquals(1f, MaskMath.alphaAt(u, 790f, 500f), 0.001f)
        assertEquals(1f, MaskMath.alphaAt(u, 500f, 790f), 0.001f)
        assertEquals(0f, MaskMath.alphaAt(u, 810f, 500f), 0.001f)
        assertEquals(0f, MaskMath.alphaAt(u, 10f, 10f), 0.001f)
    }

    @Test
    fun centerOffsetsAreFractionsOfTheInputFrame() {
        val u = uniforms(box("rectangle", centerX = 0.25, centerY = -0.1))!!
        assertEquals(750f, u.centerX, 0.01f)
        assertEquals(400f, u.centerY, 0.01f)
        assertEquals(1f, MaskMath.alphaAt(u, 750f, 400f), 0.001f)
        assertEquals(0f, MaskMath.alphaAt(u, 100f, 400f), 0.001f)
    }

    @Test
    fun featherIsCentredOnTheEdge() {
        val u = uniforms(box("rectangle", feather = 40.0))!!
        assertEquals(1f, MaskMath.alphaAt(u, 500f, 500f), 0.001f)
        // Edge at 800: exactly half-way through a 40px ramp.
        assertEquals(0.5f, MaskMath.alphaAt(u, 800f, 500f), 0.01f)
        // 10px inside / outside the ramp.
        val inside = MaskMath.alphaAt(u, 790f, 500f)
        val outside = MaskMath.alphaAt(u, 810f, 500f)
        assertTrue("inside=$inside outside=$outside", inside > 0.65f && outside < 0.35f)
        // The ramp is monotonic across its whole width.
        val ramp = (770..830).map { MaskMath.alphaAt(u, it.toFloat(), 500f) }
        ramp.zipWithNext().forEach { (a, b) ->
            assertTrue("ramp must not increase outward: $a -> $b", b <= a + 1e-4f)
        }
    }

    @Test
    fun invertedRectSwapsInsideAndOutside() {
        val u = uniforms(box("rectangle", feather = 0.0, inverted = true))!!
        assertEquals(0f, MaskMath.alphaAt(u, 500f, 500f), 0.001f)
        assertEquals(1f, MaskMath.alphaAt(u, 10f, 10f), 0.001f)
    }

    @Test
    fun rotationRotatesTheRectangle() {
        val u = uniforms(box("rectangle", width = 1.0, height = 0.2, rotation = 90.0))!!
        assertEquals(500f, u.halfWidth, 0.01f)
        assertEquals(100f, u.halfHeight, 0.01f)
        // Long axis is now vertical: a point 350px above centre is inside.
        assertEquals(1f, MaskMath.alphaAt(u, 500f, 150f), 0.001f)
        // ...and 350px to the side is outside.
        assertEquals(0f, MaskMath.alphaAt(u, 150f, 500f), 0.001f)
    }

    @Test
    fun rotationDirectionMatchesThePreviewNormal() {
        // Preview: normal = (cos rotation, sin rotation) with y pointing DOWN,
        // inside = dot(p - centre, normal) >= 0. 30 degrees therefore puts the
        // long-axis edge at (centre + h*cos30, centre + h*sin30).
        val u = uniforms(box("rectangle", width = 0.6, height = 0.4, rotation = 30.0))!!
        val edgeX = (500.0 + 300.0 * Math.cos(Math.toRadians(30.0))).toFloat()
        val edgeY = (500.0 + 300.0 * Math.sin(Math.toRadians(30.0))).toFloat()
        assertEquals(1f, MaskMath.alphaAt(u, 500f, 500f), 0.001f)
        // Just inside / outside that edge along the rotated axis.
        assertTrue(MaskMath.alphaAt(u, edgeX - 10f, edgeY - 5.8f) > 0.9f)
        assertTrue(MaskMath.alphaAt(u, edgeX + 10f, edgeY + 5.8f) < 0.1f)
        // The mirrored point (rotation the other way) is outside.
        assertTrue(MaskMath.alphaAt(u, edgeX, 500f - 300.0f * 0.5f) < 0.1f)
    }

    @Test
    fun ellipseUsesMajorAndMinorAxes() {
        val ellipse = uniforms(box("ellipse", width = 0.8, height = 0.4))!!
        assertEquals(400f, ellipse.halfWidth, 0.01f)
        assertEquals(200f, ellipse.halfHeight, 0.01f)
        assertEquals(1f, MaskMath.alphaAt(ellipse, 500f, 500f), 0.001f)
        assertEquals(1f, MaskMath.alphaAt(ellipse, 850f, 500f), 0.001f)
        assertEquals(0f, MaskMath.alphaAt(ellipse, 500f, 850f), 0.001f)
    }

    @Test
    fun circleIsRoundInInputPixelsOnANonSquareFrame() {
        // 1000x500 source: a "circle" of width 0.5 is a 250px radius in source
        // pixels, so the matrix restores a round circle on canvas.
        val circle = uniforms(
            box("circle", width = 0.5, height = 0.5),
            inputWidth = 1000,
            inputHeight = 500,
        )!!
        assertEquals(circle.halfWidth, circle.halfHeight, 0.01f)
        assertEquals(125f, circle.halfWidth, 0.5f)
        assertEquals(1f, MaskMath.alphaAt(circle, 500f, 250f), 0.001f)
        assertEquals(0f, MaskMath.alphaAt(circle, 500f, 400f), 0.001f)
    }

    @Test
    fun linearMaskSplitsOnTheRotatedNormal() {
        val u = uniforms(
            mask(
                "split",
                mapOf(
                    "centerX" to 0.0,
                    "centerY" to 0.0,
                    "rotation" to 0.0,
                    "feather" to 0.0,
                    "inverted" to false,
                ),
            ),
        )!!
        assertEquals(0f, MaskMath.alphaAt(u, 100f, 500f), 0.001f)
        assertEquals(1f, MaskMath.alphaAt(u, 900f, 500f), 0.001f)
        // The half-plane is independent of y.
        assertEquals(1f, MaskMath.alphaAt(u, 900f, 10f), 0.001f)

        val feathered = uniforms(
            mask(
                "linear",
                mapOf(
                    "centerX" to 0.0,
                    "centerY" to 0.0,
                    "rotation" to 0.0,
                    "feather" to 40.0,
                    "inverted" to false,
                ),
            ),
        )!!
        assertEquals(0.5f, MaskMath.alphaAt(feathered, 500f, 500f), 0.01f)

        // 90 degrees turns the cut into a horizontal one: +y is inside.
        val vertical = uniforms(
            mask(
                "split",
                mapOf("centerX" to 0.0, "centerY" to 0.0, "rotation" to 90.0),
            ),
        )!!
        assertEquals(1f, MaskMath.alphaAt(vertical, 500f, 900f), 0.001f)
        assertEquals(0f, MaskMath.alphaAt(vertical, 500f, 100f), 0.001f)
    }

    @Test
    fun croppedFrameIsTheMaskSpace() {
        // Crop keeps the left half of a 1000x1000 source, so this pass receives
        // a 500x1000 frame: the same normalised mask is half as wide.
        val cropped = uniforms(
            box("rectangle", width = 0.6),
            crop = EdlCrop(x = 0.0, y = 0.0, width = 0.5, height = 1.0),
        )!!
        assertEquals(250f, cropped.centerX, 0.01f)
        assertEquals(500f, cropped.centerY, 0.01f)
        assertEquals(150f, cropped.halfWidth, 0.01f)
        assertEquals(300f, cropped.halfHeight, 0.01f)

        // Keeping the RIGHT half gives the same 500-wide frame, so a mask at
        // the element's centre is still at x = 250 of that frame.
        val offsetCrop = uniforms(
            box("rectangle", width = 0.6),
            crop = EdlCrop(x = 0.5, y = 0.0, width = 0.5, height = 1.0),
        )!!
        assertEquals(250f, offsetCrop.centerX, 0.01f)
        assertEquals(150f, offsetCrop.halfWidth, 0.01f)
    }

    @Test
    fun cropAndScaleCombineForFeather() {
        // Left-half crop (500 source px wide) fitted into a 1000px canvas is
        // 2 canvas px per source px; a 0.5x element halves that again, so an
        // authored 40px feather is 40 / 1.0 = 40 source px on screen...
        val cropped = uniforms(
            box("rectangle", feather = 40.0),
            crop = EdlCrop(x = 0.0, y = 0.0, width = 0.5, height = 1.0),
        )!!
        // framingScale = min(1000/500, 1000/1000) = 1 -> 40px stays 40px.
        assertEquals(40f, cropped.featherPixels, 0.01f)

        val scaled = uniforms(
            box("rectangle", feather = 40.0),
            crop = EdlCrop(x = 0.0, y = 0.0, width = 0.5, height = 1.0),
            transform = EdlTransform(0.0, 0.0, 0.25, 0.25, 0.0),
        )!!
        // 0.25x on top of 1:1 -> 160 source px, which the matrix shrinks back
        // to the authored 40px on canvas.
        assertEquals(160f, scaled.featherPixels, 0.01f)
    }

    @Test
    fun elementPositionAndRotationRideTheMatrixAndDoNotMoveTheMask() {
        val moved = uniforms(
            box("rectangle"),
            transform = EdlTransform(75.0, -40.0, 1.0, 1.0, 42.0),
        )!!
        assertEquals(500f, moved.centerX, 0.01f)
        assertEquals(500f, moved.centerY, 0.01f)
        assertEquals(0f, moved.rotationRadians, 0.0001f)
        assertEquals(1f, MaskMath.alphaAt(moved, 500f, 500f), 0.001f)
    }

    @Test
    fun elementScaleShrinksFeatherToTheAuthoredCanvasWidth() {
        // Feather 80 canvas px on a 0.5x element: the matrix doubles it again,
        // so the input-space ramp must be 160px wide.
        val scaled = uniforms(
            box("rectangle", feather = 80.0),
            transform = EdlTransform(0.0, 0.0, 0.5, 0.5, 0.0),
        )!!
        assertEquals(160f, scaled.featherPixels, 0.01f)
        // The ramp still straddles the edge at 800, now 160px wide.
        assertEquals(0.5f, MaskMath.alphaAt(scaled, 800f, 500f), 0.01f)
        assertEquals(1f, MaskMath.alphaAt(scaled, 700f, 500f), 0.001f)
        assertEquals(0f, MaskMath.alphaAt(scaled, 900f, 500f), 0.001f)
    }

    @Test
    fun keyframedTransformIsResolvedPerFrame() {
        val keyframes = listOf(
            EdlKeyframe("k0", 0L, 0.5, "linear", null, null),
            EdlKeyframe("k1", 1_200_000L, 1.0, "linear", null, null),
        )
        val channels = listOf(
            EdlAnimationChannel(
                propertyPath = "transform.scaleX",
                componentKey = null,
                extrapolationBefore = "hold",
                extrapolationAfter = "hold",
                keyframes = keyframes,
            ),
            EdlAnimationChannel(
                propertyPath = "transform.scaleY",
                componentKey = null,
                extrapolationBefore = "hold",
                extrapolationAfter = "hold",
                keyframes = keyframes,
            ),
        )
        val animated = clip(animations = channels)
        val loaded = KeyframeEvaluator.visualChannels(animated)
        assertEquals(2, loaded.size)

        val atStart = KeyframeEvaluator.resolveTransform(animated.transform, loaded, 0L)
        val atEnd = KeyframeEvaluator.resolveTransform(animated.transform, loaded, 1_200_000L)
        assertEquals(0.5, atStart.scaleX, 0.001)
        assertEquals(1.0, atEnd.scaleX, 0.001)

        // Scale only changes the feather mapping, never the centre.
        val startUniforms = uniforms(box("rectangle", feather = 80.0), transform = atStart)!!
        val endUniforms = uniforms(box("rectangle", feather = 80.0), transform = atEnd)!!
        assertEquals(500f, startUniforms.centerX, 0.01f)
        assertEquals(500f, endUniforms.centerX, 0.01f)
        assertEquals(160f, startUniforms.featherPixels, 0.01f)
        assertEquals(80f, endUniforms.featherPixels, 0.01f)
    }

    @Test
    fun unknownShapeIsNotMapped() {
        assertNull(uniforms(mask("heart", mapOf("width" to 0.5, "height" to 0.5))))
    }

    @Test
    fun degenerateInputIsNotMapped() {
        assertNull(uniforms(box("rectangle"), inputWidth = 0, inputHeight = 0))
        assertNull(uniforms(box("rectangle"), canvasWidth = 0, canvasHeight = 0))
    }
}
