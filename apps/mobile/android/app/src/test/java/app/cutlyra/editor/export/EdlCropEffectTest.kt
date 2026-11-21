package app.cutlyra.editor.export

import app.cutlyra.editor.edl.EdlCrop
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * `EdlCrop` (normalised, top-left origin, y-down) -> Media3 `Crop` NDC.
 *
 * Media3's constructor is `(left, right, bottom, top)` with a y-UP origin at
 * the frame centre, so the axis mapping is the easy thing to get wrong. The
 * preview shader samples `[x, y] .. [x+width, y+height]` in the same y-down
 * space, which is what these expectations mirror.
 */
class EdlCropEffectTest {
    @Test
    fun `full frame produces no effect`() {
        assertNull(EdlCropEffect.create(EdlCrop()))
        assertNull(EdlCropEffect.create(EdlCrop(0.0, 0.0, 1.0, 1.0)))
    }

    @Test
    fun `left half maps to the left NDC half`() {
        assertArrayEquals(
            floatArrayOf(-1f, 0f, -1f, 1f),
            EdlCropEffect.ndcBounds(EdlCrop(0.0, 0.0, 0.5, 1.0)),
            0f,
        )
    }

    @Test
    fun `right half maps to the right NDC half`() {
        assertArrayEquals(
            floatArrayOf(0f, 1f, -1f, 1f),
            EdlCropEffect.ndcBounds(EdlCrop(0.5, 0.0, 0.5, 1.0)),
            0f,
        )
    }

    @Test
    fun `top half maps upward in NDC`() {
        // Image y-down: y=0..0.5 is the TOP half, which is NDC top=+1..0.
        assertArrayEquals(
            floatArrayOf(-1f, 1f, 0f, 1f),
            EdlCropEffect.ndcBounds(EdlCrop(0.0, 0.0, 1.0, 0.5)),
            0f,
        )
    }

    @Test
    fun `bottom half maps downward in NDC`() {
        assertArrayEquals(
            floatArrayOf(-1f, 1f, -1f, 0f),
            EdlCropEffect.ndcBounds(EdlCrop(0.0, 0.5, 1.0, 0.5)),
            0f,
        )
    }

    @Test
    fun `centre crop is symmetric`() {
        assertArrayEquals(
            floatArrayOf(-0.5f, 0.5f, -0.5f, 0.5f),
            EdlCropEffect.ndcBounds(EdlCrop(0.25, 0.25, 0.5, 0.5)),
            0f,
        )
    }

    @Test
    fun `out-of-range crop clamps into the source frame`() {
        // x clamps to 0.9, width to the remaining 0.1.
        assertArrayEquals(
            floatArrayOf(0.8f, 1f, -1f, 1f),
            EdlCropEffect.ndcBounds(EdlCrop(0.9, 0.0, 0.5, 1.0)),
            1e-5f,
        )
    }

    @Test
    fun `non-full crop produces a Media3 Crop effect`() {
        val effect = EdlCropEffect.create(EdlCrop(0.0, 0.0, 0.5, 1.0))
        assertNotNull(effect)
        assertEquals("Crop", effect!!.javaClass.simpleName)
    }
}
