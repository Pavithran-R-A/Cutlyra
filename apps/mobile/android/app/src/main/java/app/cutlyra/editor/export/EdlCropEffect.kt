package app.cutlyra.editor.export

import androidx.media3.effect.Crop
import app.cutlyra.editor.edl.EdlCrop

/**
 * `EdlClip.crop` (normalised, top-left origin, y-down) -> Media3's
 * [Crop] (NDC, origin at the frame centre, y-up).
 *
 * Media3's `Crop(left, right, bottom, top)` is a vertex-shader crop: the
 * cropped region becomes the effect's output frame (its `configure` returns
 * `input * (right-left)/2 x input * (top-bottom)/2`), so placing it BEFORE
 * `EdlTransformEffect` and the per-item `Presentation` gives exactly the
 * preview's semantics — crop first, then framing/transform into the canvas.
 *
 * Kept as a pure object so the axis mapping is unit-testable off-device.
 */
internal object EdlCropEffect {
    /** Full-frame crop — the exporter then emits no effect at all. */
    fun isFull(crop: EdlCrop): Boolean =
        crop.x <= EPSILON &&
            crop.y <= EPSILON &&
            crop.width >= 1.0 - EPSILON &&
            crop.height >= 1.0 - EPSILON

    /**
     * NDC edges in `[left, right, bottom, top]` order, matching Media3's
     * constructor. Values are clamped exactly like the TypeScript reader
     * (`readCropFromParams`), so preview and export agree even if a project
     * file carries an out-of-range rectangle.
     */
    fun ndcBounds(crop: EdlCrop): FloatArray {
        val x = crop.x.coerceIn(0.0, 1.0 - MIN_SIZE)
        val y = crop.y.coerceIn(0.0, 1.0 - MIN_SIZE)
        val width = crop.width.coerceIn(MIN_SIZE, 1.0 - x)
        val height = crop.height.coerceIn(MIN_SIZE, 1.0 - y)
        val left = (-1.0 + 2.0 * x).toFloat()
        val right = (-1.0 + 2.0 * (x + width)).toFloat()
        // Image UV is y-down; NDC is y-up, so the TOP edge maps to `top`.
        val top = (1.0 - 2.0 * y).toFloat()
        val bottom = (1.0 - 2.0 * (y + height)).toFloat()
        return floatArrayOf(left, right, bottom, top)
    }

    /** `null` when the crop covers the whole frame (no effect to add). */
    fun create(crop: EdlCrop): Crop? {
        if (isFull(crop)) return null
        val bounds = ndcBounds(crop)
        return Crop(bounds[0], bounds[1], bounds[2], bounds[3])
    }

    private const val MIN_SIZE = 0.01
    private const val EPSILON = 1e-6
}
