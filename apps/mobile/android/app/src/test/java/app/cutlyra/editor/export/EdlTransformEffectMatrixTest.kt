package app.cutlyra.editor.export

import app.cutlyra.editor.edl.EdlTransform
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Geometry of [EdlTransformEffect.matrixValues] on NON-SQUARE canvases.
 *
 * `ExportTransformParityInstrumentedTest` proves rotation/mirror conventions on
 * a square canvas, where an NDC rotation happens to be a pixel-space rotation.
 * On a 16:9 canvas it is not: rotating in NDC shears the picture, which is what
 * a POCO M4 Pro 5G export showed (a +90° 1280x720 clip filled the frame with
 * stretched colour bars instead of the 720x1280 portrait footprint the preview
 * renders). These tests pin the mapping down in pixels.
 */
class EdlTransformEffectMatrixTest {
    private val canvasWidth = 1280
    private val canvasHeight = 720

    /** Applies row-major 3x3 `values` to an NDC point. */
    private fun applyNdc(values: FloatArray, u: Double, v: Double): Pair<Double, Double> {
        val x = values[0] * u + values[1] * v + values[2]
        val y = values[3] * u + values[4] * v + values[5]
        return x.toDouble() to y.toDouble()
    }

    private fun pixelToNdc(x: Double, y: Double, w: Int, h: Int): Pair<Double, Double> =
        (2.0 * x / w - 1.0) to (1.0 - 2.0 * y / h)

    private fun ndcToPixel(u: Double, v: Double, w: Int, h: Int): Pair<Double, Double> =
        ((u + 1.0) / 2.0 * w) to ((1.0 - v) / 2.0 * h)

    /**
     * Where a pixel lands under `degrees` clockwise on screen, in the Y-down
     * pixel space the preview renders in (the convention
     * `ExportTransformParityInstrumentedTest` proves for positive rotations).
     */
    private fun rotatePixel(x: Double, y: Double, degrees: Double, w: Int, h: Int): Pair<Double, Double> {
        val radians = Math.toRadians(degrees)
        val dx = x - w / 2.0
        val dy = y - h / 2.0
        val rx = dx * Math.cos(radians) - dy * Math.sin(radians)
        val ry = dx * Math.sin(radians) + dy * Math.cos(radians)
        return (rx + w / 2.0) to (ry + h / 2.0)
    }

    private fun mapPixel(
        transform: EdlTransform,
        x: Double,
        y: Double,
        w: Int = canvasWidth,
        h: Int = canvasHeight,
    ): Pair<Double, Double> {
        val values = EdlTransformEffect.matrixValues(transform, w, h)
        val (u, v) = pixelToNdc(x, y, w, h)
        val (mu, mv) = applyNdc(values, u, v)
        return ndcToPixel(mu, mv, w, h)
    }

    /** Which source- (canvas-space) pixel a canvas point samples, by inverting `values`. */
    private fun sourcePixelFor(
        values: FloatArray,
        x: Double,
        y: Double,
        w: Int,
        h: Int,
    ): Pair<Double, Double> {
        val (u, v) = pixelToNdc(x, y, w, h)
        val a = values[0].toDouble()
        val b = values[1].toDouble()
        val tx = values[2].toDouble()
        val c = values[3].toDouble()
        val d = values[4].toDouble()
        val ty = values[5].toDouble()
        val det = a * d - b * c
        val su = (d * (u - tx) - b * (v - ty)) / det
        val sv = (-c * (u - tx) + a * (v - ty)) / det
        return ndcToPixel(su, sv, w, h)
    }

    private fun assertPixel(expected: Pair<Double, Double>, actual: Pair<Double, Double>, label: String) {
        assertEquals("$label x", expected.first, actual.first, 1.0)
        assertEquals("$label y", expected.second, actual.second, 1.0)
    }

    @Test
    fun `plus 90 degrees on a landscape canvas is a pixel-space rotation`() {
        val transform = EdlTransform(0.0, 0.0, 1.0, 1.0, 90.0)
        // The asymmetric marker used in qa-evidence on the 12 s colour-bar fixture.
        assertPixel(rotatePixel(335.0, 540.0, 90.0, canvasWidth, canvasHeight), mapPixel(transform, 335.0, 540.0), "+90 marker")
        assertPixel(rotatePixel(0.0, 0.0, 90.0, canvasWidth, canvasHeight), mapPixel(transform, 0.0, 0.0), "+90 top-left")
    }

    @Test
    fun `minus 90 degrees on a landscape canvas is a pixel-space rotation`() {
        val transform = EdlTransform(0.0, 0.0, 1.0, 1.0, -90.0)
        assertPixel(rotatePixel(335.0, 540.0, -90.0, canvasWidth, canvasHeight), mapPixel(transform, 335.0, 540.0), "-90 marker")
    }

    @Test
    fun `180 degrees never needed aspect correction and still matches`() {
        val transform = EdlTransform(0.0, 0.0, 1.0, 1.0, 180.0)
        assertPixel(rotatePixel(335.0, 540.0, 180.0, canvasWidth, canvasHeight), mapPixel(transform, 335.0, 540.0), "180 marker")
    }

    @Test
    fun `the sheared NDC rotation is what this fix rules out`() {
        // Pre-fix behaviour: the same probe landed where a bare NDC rotation put
        // it (the 12 s export put the marker at ~320,188 instead of ~460,55).
        val transform = EdlTransform(0.0, 0.0, 1.0, 1.0, 90.0)
        val actual = mapPixel(transform, 335.0, 540.0)
        assertNotEquals("must not land at the sheared NDC position (x)", 320.0, actual.first, 5.0)
        assertNotEquals("must not land at the sheared NDC position (y)", 188.0, actual.second, 5.0)
    }

    @Test
    fun `square canvases keep the plain rotation the instrumentation suite proves`() {
        val transform = EdlTransform(0.0, 0.0, 1.0, 1.0, 90.0)
        val actual = mapPixel(transform, 64.0, 200.0, 256, 256)
        assertPixel(rotatePixel(64.0, 200.0, 90.0, 256, 256), actual, "square +90")
        // The exact numbers the pre-fix `Matrix.postRotate(-90f)` produced on a
        // square canvas: the aspect conjugation must not perturb them, and the
        // rotation must stay CLOCKWISE for a positive `rotateDegrees`.
        assertPixel(56.0 to 64.0, actual, "square +90 pre-fix parity")
    }

    @Test
    fun `mirrors are unaffected by the aspect correction`() {
        val flipH = EdlTransform(0.0, 0.0, -1.0, 1.0, 0.0)
        assertPixel((1280.0 - 200.0) to 300.0, mapPixel(flipH, 200.0, 300.0), "flip H")

        val flipV = EdlTransform(0.0, 0.0, 1.0, -1.0, 0.0)
        assertPixel(200.0 to (720.0 - 300.0), mapPixel(flipV, 200.0, 300.0), "flip V")
    }

    @Test
    fun `identity keeps every pixel in place`() {
        val identity = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0)
        assertPixel(400.0 to 260.0, mapPixel(identity, 400.0, 260.0), "identity")
    }

    @Test
    fun `fill framing keeps a quarter turn covering a portrait canvas`() {
        // `ExportTransformParityInstrumentedTest.fillMismatchedCanvas_coversCanvas`
        // asserts a fill + 90 clip still covers a 1080x1920 canvas.
        val w = 1080
        val h = 1920
        val transform = EdlTransform(0.0, 0.0, 1.0, 1.0, 90.0)
        val fit = EdlTransformEffect.matrixValues(transform, w, h, fillFraming = false)
        val fill = EdlTransformEffect.matrixValues(transform, w, h, fillFraming = true)

        fun insideCanvas(p: Pair<Double, Double>) =
            p.first >= -1.0 && p.first <= w + 1.0 && p.second >= -1.0 && p.second <= h + 1.0

        val canvasCorners = listOf(
            0.0 to 0.0,
            (w - 1).toDouble() to 0.0,
            0.0 to (h - 1).toDouble(),
            (w - 1).toDouble() to (h - 1).toDouble(),
        )
        val filledMisses = canvasCorners.count { !insideCanvas(sourcePixelFor(fill, it.first, it.second, w, h)) }
        val fittedMisses = canvasCorners.count { !insideCanvas(sourcePixelFor(fit, it.first, it.second, w, h)) }

        assertEquals("fill must sample picture at every canvas corner", 0, filledMisses)
        assertTrue("fit must still show bars at some corner, got $fittedMisses misses", fittedMisses > 0)
        // The cover growth is a uniform scale: both off-diagonals grow by h/w.
        val cover = h.toFloat() / w.toFloat()
        assertEquals("cover scales the rotated x term", fill[1], fit[1] * cover, 1e-4f)
        assertEquals("cover scales the rotated y term", fill[3], fit[3] * cover, 1e-4f)
    }

    @Test
    fun `fill cover does not apply without a quarter turn`() {
        val w = 1080
        val h = 1920
        for (rotation in listOf(0.0, 180.0, -180.0, 45.0)) {
            val transform = EdlTransform(0.0, 0.0, 1.0, 1.0, rotation)
            val fit = EdlTransformEffect.matrixValues(transform, w, h, fillFraming = false)
            val fill = EdlTransformEffect.matrixValues(transform, w, h, fillFraming = true)
            for (i in fit.indices) {
                assertEquals("rotation $rotation value $i", fit[i], fill[i], 1e-6f)
            }
        }
    }

    @Test
    fun `pixel offsets stay canvas-pixel offsets`() {
        val moved = EdlTransform(160.0, -90.0, 1.0, 1.0, 0.0)
        assertPixel(560.0 to 170.0, mapPixel(moved, 400.0, 260.0), "offset")
    }
}
