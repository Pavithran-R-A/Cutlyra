package app.cutlyra.editor.export

import androidx.media3.common.OverlaySettings
import androidx.media3.common.VideoCompositorSettings
import androidx.media3.common.util.Size
import androidx.media3.effect.StaticOverlaySettings
import app.cutlyra.editor.edl.EdlClip

/**
 * The Media3 half of the cross-fade compositor (plan M9 risk #4). Thin by
 * design: the actual math lives in framework-free `TransitionAlphaMath` and
 * `MainTrackPlacements` (both unit-tested); this class adapts it to the two
 * methods `androidx.media3.common.VideoCompositorSettings` requires.
 *
 * PAINT MODEL (Stage 18 POCO regression, 2026-10-12 — verified against
 * media3 1.11.0's `DefaultVideoCompositor`/`DefaultCompositorGlProgram`
 * source AND reproduced on the emulator): media3 draws the composited frames
 * "back to front" ending with the PRIMARY input last, i.e. **the first
 * registered input is the TOP layer** ("the first registered source is on
 * the very top", `DefaultVideoCompositor`'s class doc). The original model
 * here assumed the opposite — index 0 as an opaque BACKGROUND with the
 * transition head alpha-blended ON TOP of it — so the opaque base covered
 * the transition overlay every single frame and the export rendered a hard
 * cut while every structural test still passed.
 *
 * The correct assignment, implemented below:
 *   0                -> the base sequence (primary). Its alpha is ramped
 *                        DOWN inside a transition window so the incoming
 *                        clip's head, painted beneath it, shows through:
 *                        out = (1-a)*head + a*base, a: 1 -> 0 across the
 *                        window. Fully opaque outside any window.
 *   1..transitions.size -> one short overlay sequence per `EdlTransition`
 *                        (the incoming clip's head). Painted beneath the
 *                        base at FULL opacity; `windowsByInputIndex[i]`
 *                        holds that sequence's window (used above).
 *   >transitions.size  -> overlay/graphic tracks (PiP-style), driven by a
 *                        clip's static `transform`/`opacity` — see
 *                        `overlayTrackSettingsByInputIndex`. NOTE: these sit
 *                        under the opaque base like every other secondary
 *                        input, so a PiP clip is only visible while some
 *                        window has the base faded — a known, separate
 *                        defect (video-overlay export visibility), not part
 *                        of the cross-fade fix.
 */
class CrossfadeCompositorSettings(
    private val windowsByInputIndex: Map<Int, TransitionAlphaMath.Window>,
    private val overlayTrackSettingsByInputIndex: Map<Int, StaticOverlaySettings> = emptyMap(),
    /** Round 47: PiP clips with keyframes — per-frame alpha from the
     *  evaluated opacity; geometry rides the item's own animated
     *  `EdlTransformEffect`, so no scale/rotation is applied here. */
    private val animatedOverlayAlphaByInputIndex: Map<Int, AnimatedOverlayAlpha> = emptyMap(),
    private val outputSize: Size,
) : VideoCompositorSettings {

    /** Keyframed opacity of one PiP clip, sampled at composition time. */
    class AnimatedOverlayAlpha(private val clip: EdlClip, private val itemStartUs: Long, private val ticksPerSecond: Long) {
        private val channels = KeyframeEvaluator.visualChannels(clip)

        fun alphaAt(presentationTimeUs: Long): Float {
            val localTicks = KeyframeEvaluator.localTicks(presentationTimeUs, itemStartUs, ticksPerSecond, clip.durationTicks)
            return KeyframeEvaluator.resolveOpacity(clip.opacity, channels, localTicks).coerceIn(0.0, 1.0).toFloat()
        }
    }

    override fun getOutputSize(inputSizes: MutableList<Size>): Size = outputSize

    override fun getOverlaySettings(inputIndex: Int, presentationTimeUs: Long): OverlaySettings {
        if (inputIndex == 0) {
            // The primary is painted LAST (on top). Fade it out — strictly
            // inside each transition window, so the head beneath shows
            // through; fully opaque everywhere else (including at/after a
            // window's end, where the base already hard-cut to the incoming
            // clip and the head sequence has ended).
            var alphaScale = 1f
            for (window in windowsByInputIndex.values) {
                if (presentationTimeUs >= window.startUs && presentationTimeUs < window.endUs) {
                    val faded = 1f - TransitionAlphaMath.alphaAt(window, presentationTimeUs)
                    if (faded < alphaScale) alphaScale = faded
                }
            }
            return StaticOverlaySettings.Builder().setAlphaScale(alphaScale).build()
        }
        // Secondary inputs paint BENEATH the primary: transition heads must be
        // fully opaque (the primary's ramp does the blending), PiP/animated
        // clips keep their own settings.
        animatedOverlayAlphaByInputIndex[inputIndex]?.let {
            return StaticOverlaySettings.Builder().setAlphaScale(it.alphaAt(presentationTimeUs)).build()
        }
        overlayTrackSettingsByInputIndex[inputIndex]?.let { return it }
        // Default (`OverlaySettings`'s documented defaults: alpha 1,
        // untransformed) — also what `VideoCompositorSettings.DEFAULT`
        // returns for every input.
        return StaticOverlaySettings.Builder().build()
    }
}
