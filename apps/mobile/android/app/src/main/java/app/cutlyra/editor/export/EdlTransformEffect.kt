package app.cutlyra.editor.export

import android.graphics.Matrix
import android.util.Log
import androidx.media3.effect.MatrixTransformation
import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlTransform
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * `EdlClip.transform` -> a per-frame GL matrix, via Media3's documented
 * `MatrixTransformation` extension point (plan M9 iOS-side analogue:
 * `AVVideoCompositionLayerInstruction`'s opacity/transform ramps).
 *
 * Round 47: `getMatrix` is called per FRAME with a presentation time, which
 * is exactly the hook a keyframed transform needs. A clip with keyframe
 * channels on `transform.*` resolves them through `KeyframeEvaluator` (the
 * engine's own interpolation, parity-tested) at the clip-local tick under
 * `presentationTimeUs`; a static clip returns its constant matrix as before.
 *
 * TIME BASE — STATED, NOT VERIFIED ON HARDWARE: `presentationTimeUs` is
 * treated as COMPOSITION time (media3 adds each item's sequence offset
 * before per-item effects see a frame — the same base the composition-
 * level `PrerenderedOverlay` timing relies on, which the emulator run
 * verified), so clip-local time is `presentationTimeUs - itemStartUs`.
 * If a device run shows item-relative timestamps instead, the fix is
 * `itemStartUs = 0` at the call sites; the first frame's numbers are
 * logged under `cutlyra-export` precisely so that can be read off adb.
 * * GEOMETRY CONVENTION — VERIFIED FOR ROTATION AND MIRROR, NOT FOR OFFSETS:
 * `ExportTransformParityInstrumentedTest` exports real MP4s through the actual
 * `Media3Exporter`/EDL pipeline on the API-35 CI emulator, decodes frames and
 * reads corner colours of an asymmetric marker. Those decoded pixels confirm
 * (a) positive `rotateDegrees` is CLOCKWISE on screen, (b) the `postScale` ->
 * `postRotate(-rotateDegrees)` -> `postTranslate` order produces preview-
 * equivalent composed transforms (rotate+H/V flips included), and (c) the
 * NDC/Y-flip mapping below lands the picture where the editor preview shows
 * it for identity, ±90°, 180°, H and V. Both instrumentation variants (normal
 * and R8) pass on that evidence.
 *
 * STILL UNVERIFIED — do not infer otherwise:
 *  - `positionX`/`positionY` pixel offsets. They are canvas-pixel offsets from
 *    center, Y-down (from the producer: `services/renderer/compositor/frame-
 *    descriptor.ts`: `centerY = height/2 + position.y`); the pixel->NDC scale
 *    (`2 * offset / canvasDimension`) and the Y-flip (`-transform.positionY`)
 *    are the mathematically obvious mapping, but NO test exports a non-zero
 *    offset, so on-screen placement is unproven.
 *  - Keyframed transforms: the composition-time base of `presentationTimeUs`
 *    is argued from media3 behaviour, not measured. The first frame's numbers
 *    are logged under `cutlyra-export` so a device run can settle it.
 *  - Physical-device parity (the emulator is not a POCO M4 Pro 5G, and its
 *    software H.264 encoder takes media3's landscape-encode path, so coded
 *    portrait geometry arrives as 1920x1080 + a 90° display rotation).
 *
 * NON-SQUARE CANVASES: the matrix below lives in NDC (`[-1,1]`), which is
 * anisotropic whenever the canvas is not square; a bare rotation there shears
 * non-square output. `matrixValues` therefore conjugates the rotation by the
 * canvas aspect (`diag(h/w, 1) * R * diag(w/h, 1)`), which is the NDC image of
 * a true pixel-space rotation. Square canvases (h/w = 1) reduce to the plain
 * rotation the parity suite already proves. Before this, a single 12 s 16:9
 * clip rotated +90° on `app.cutlyra.editor.qa2`/POCO M4 Pro 5G exported
 * with every colour bar stretched across the full 1280x720 width instead of the
 * 720x1280 portrait footprint the preview shows.
 *
 * The effect is still applied only to clips whose transform is non-identity or
 * keyframed (`EdlToComposition.buildEditedMediaItem`), so the common case never
 * depends on this class at all.
 */
class EdlTransformEffect(
    private val clip: EdlClip,
    private val canvasWidth: Int,
    private val canvasHeight: Int,
    /** Composition-time start of this item, microseconds — local tick 0. */
    private val itemStartUs: Long,
    private val ticksPerSecond: Long,
    /** `clip.framing == "fill"`: the clip covers the canvas instead of fitting it. */
    private val fillFraming: Boolean = false,
) : MatrixTransformation {
    private val channels = KeyframeEvaluator.visualChannels(clip)

    @Volatile
    private var loggedFirstFrame = false

    override fun getMatrix(presentationTimeUs: Long): Matrix {
        val transform = if (channels.isEmpty()) {
            clip.transform
        } else {
            val localTicks = KeyframeEvaluator.localTicks(
                presentationTimeUs = presentationTimeUs,
                itemStartUs = itemStartUs,
                ticksPerSecond = ticksPerSecond,
                durationTicks = clip.durationTicks,
            )
            if (!loggedFirstFrame) {
                loggedFirstFrame = true
                Log.i(
                    TAG,
                    "keyframed transform ${clip.clipId}: first pts=${presentationTimeUs}us itemStart=${itemStartUs}us -> local $localTicks ticks",
                )
            }
            KeyframeEvaluator.resolveTransform(clip.transform, channels, localTicks)
        }
        return matrixFor(transform, canvasWidth, canvasHeight, fillFraming)
    }

    companion object {
        private const val TAG = "cutlyra-export"

        fun isIdentity(transform: EdlTransform): Boolean =
            transform.positionX == 0.0 &&
                transform.positionY == 0.0 &&
                transform.scaleX == 1.0 &&
                transform.scaleY == 1.0 &&
                transform.rotateDegrees == 0.0

        fun matrixFor(
            transform: EdlTransform,
            canvasWidth: Int,
            canvasHeight: Int,
            fillFraming: Boolean = false,
        ): Matrix {
            return Matrix().apply {
                setValues(matrixValues(transform, canvasWidth, canvasHeight, fillFraming))
            }
        }

        /**
         * Row-major 3x3 values of `postScale` -> aspect-corrected
         * `postRotate(-rotateDegrees)` -> `postTranslate`, i.e. exactly the
         * matrix `matrixFor` used to build through `Matrix.post*` calls, with
         * the rotation conjugated by the canvas aspect so a pixel-space
         * rotation survives the trip through NDC. Pure Kotlin so the geometry
         * is unit-tested off-device.
         */
        fun matrixValues(
            transform: EdlTransform,
            canvasWidth: Int,
            canvasHeight: Int,
            fillFraming: Boolean = false,
        ): FloatArray {
            val ndcX = if (canvasWidth > 0) (2.0 * transform.positionX / canvasWidth).toFloat() else 0f
            val ndcY = if (canvasHeight > 0) (-2.0 * transform.positionY / canvasHeight).toFloat() else 0f
            val radians = Math.toRadians(-transform.rotateDegrees)
            val cos = cos(radians).toFloat()
            val sin = sin(radians).toFloat()
            // h/w: 1.0 for a square canvas, where this is a plain rotation.
            val aspect =
                if (canvasWidth > 0 && canvasHeight > 0) canvasHeight.toFloat() / canvasWidth.toFloat() else 1f
            // A quarter turn swaps the frame's width and height, so a `fill`
            // clip that fitted the canvas before the rotation no longer covers
            // it afterwards (the per-item LAYOUT_SCALE_TO_FIT_WITH_CROP is a
            // no-op on an already canvas-sized frame). Grow by the long/short
            // side ratio so `fill` keeps covering, exactly as it did when the
            // NDC rotation acted as an implicit stretch.
            val quarterTurn = Math.floorMod(Math.round(transform.rotateDegrees), 180L) == 90L
            val cover =
                if (fillFraming && quarterTurn && canvasWidth > 0 && canvasHeight > 0) {
                    max(canvasWidth, canvasHeight).toFloat() / min(canvasWidth, canvasHeight).toFloat()
                } else {
                    1f
                }
            val scaleX = transform.scaleX.toFloat() * cover
            val scaleY = transform.scaleY.toFloat() * cover
            // `sin` carries the sign of `Matrix.postRotate(-rotateDegrees)`
            // exactly; `aspect` only rescales the two off-diagonal terms.
            return floatArrayOf(
                cos * scaleX, -aspect * sin * scaleY, ndcX,
                sin / aspect * scaleX, cos * scaleY, ndcY,
                0f, 0f, 1f,
            )
        }
    }
}
