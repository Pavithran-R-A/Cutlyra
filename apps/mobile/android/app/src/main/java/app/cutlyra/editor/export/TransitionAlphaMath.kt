package app.cutlyra.editor.export

/**
 * THE cross-fade math (plan M9 risk #4 — "Media3 has no cross-clip
 * transitions... build the transition compositor FIRST, not last").
 *
 * Kept 100% framework-free (no `androidx.media3.*`, no Android types) on
 * purpose: this is the one piece of the transition compositor whose
 * correctness can be fully verified on a plain JVM without a device or
 * emulator (`TransitionAlphaMathTest`). Everything downstream of this file
 * (`CrossfadeCompositorSettings`, wired into a real Media3
 * `VideoCompositorSettings`) is a thin adapter that cannot itself be
 * unit-tested without a GL context — see that file's doc comment.
 *
 * The compositing model (CORRECTED in Stage 18 — the original assumption
 * was backwards and shipped invisible cross-fades: media3 1.11.0's
 * `DefaultVideoCompositor` draws frames "back to front", ending with the
 * PRIMARY input last, i.e. **input 0 is the TOP layer**, with standard
 * `src-over`: `out = primary*alphaP + behind*(1-alphaP)`):
 *
 *   base sequence (index 0, primary, painted LAST/on top): every
 *     main-track clip, hard-cut, on the COMPRESSED timeline
 *     (`MainTrackPlacements`). Its `alphaScale` ramps 1 -> 0 linearly
 *     across each transition window and is 1 everywhere else.
 *   one short overlay sequence per transition (index 1..N): just the head
 *     of the INCOMING clip, trimmed to the transition's duration,
 *     positioned (via a leading gap) so it plays exactly across the
 *     transition window, painted BENEATH the base at FULL opacity.
 *
 * During the window the fading base reveals the head beneath:
 * `out = (1-a)*A + a*head`. At window-end the base is fully opaque again
 * and has hard-cut to the incoming clip — whose first frames are exactly
 * the content the head just finished playing, because
 * `MainTrackPlacements` front-trims that base clip by the same overlap.
 * So the seam is continuous: no visible cut, no double-exposure, no
 * content rewind past the window edges. This is the standard `src-over`
 * crossfade identity, expressed with primitives Media3 documents as public
 * API (`08` §8's own framing: "manually cross-fading alpha via a custom
 * OverlayEffect/shader across the transition window") rather than a
 * hand-rolled GLSL blend pass.
 */
object TransitionAlphaMath {
    /** `startUs`/`endUs` are the transition window on the OUTPUT timeline (in
     * the base sequence's presentation-time space); `endUs > startUs`
     * required. `alphaAt` is undefined (and unused) outside `[startUs,
     * endUs]` — callers are expected to only invoke it while the overlay
     * sequence is actually producing frames, which by construction is
     * exactly that window (see the gap+trim math in
     * `EdlToComposition.buildTransitionOverlaySequence`). */
    data class Window(
        val startUs: Long,
        val endUs: Long,
        /** Canonical EDL kind ("cross_fade" | "slide" | "push" | "zoom").
         *  Alpha is driven only for `usesAlpha` kinds; motion rides the clips'
         *  own derived animation channels (see the TS transition-definitions). */
        val kind: String = "cross_fade",
    ) {
        init {
            require(endUs > startUs) { "transition window must have endUs > startUs, got [$startUs, $endUs)" }
        }

        val durationUs: Long get() = endUs - startUs
    }

    /**
     * Linear alpha ramp, 0 at `window.startUs`, 1 at `window.endUs`, clamped
     * to `[0,1]` for any `presentationTimeUs` outside the window (defensive:
     * Media3 may query a frame a few microseconds either side of the exact
     * boundary due to frame-timestamp rounding, so clamping — not throwing —
     * is the correct behavior here).
     */
    fun alphaAt(window: Window, presentationTimeUs: Long): Float {
        if (presentationTimeUs <= window.startUs) return 0f
        if (presentationTimeUs >= window.endUs) return 1f
        val elapsed = (presentationTimeUs - window.startUs).toDouble()
        return (elapsed / window.durationUs.toDouble()).toFloat()
    }

    /**
     * The kinds BOTH renderers implement (Phase 3). Each one's motion is
     * carried by the clips' derived animation channels, which the exporter
     * already evaluates per frame; what this class decides is only how the
     * compositor stacks the incoming head and whether the base's alpha dips:
     *
     *  - CROSSFADE / ZOOM: head painted BENEATH the base, base alpha 1 -> 0
     *    (`usesAlpha`). Identical maths to the preview, where the incoming
     *    clip ramps its own opacity over the outgoing one.
     *  - SLIDE / PUSH: head painted ABOVE the base, both opaque; the motion
     *    (translated clips) does the reveal. Preview paints the incoming clip
     *    on top for exactly the same reason, so the two agree.
     *
     * Unknown kinds are dropped (hard cut) rather than half-rendered; the TS
     * producer normalises every kind it emits, so this only guards
     * hand-authored/legacy EDLs.
     *
     * WIPE paints the incoming head ABOVE the base and reveals it through an
     * animated edge (`EdlWipeEffect`); DIP_* cross-fade while both layers are
     * mixed toward a solid colour (`EdlDipEffect`); BLUR cross-fades while the
     * incoming head resolves from a blur (`EdlBlurEffect`). Each mirrors the
     * preview's derived effect pass.
     */
    enum class TransitionKind {
        CROSSFADE,
        SLIDE,
        PUSH,
        ZOOM,
        WIPE,
        DIP_BLACK,
        DIP_WHITE,
        BLUR,
        UNSUPPORTED_HARD_CUT,
    }

    fun classify(rawKind: String): TransitionKind = when (rawKind.lowercase()) {
        "fade", "crossfade", "cross-fade", "cross_fade", "dissolve" -> TransitionKind.CROSSFADE
        "slide" -> TransitionKind.SLIDE
        "push" -> TransitionKind.PUSH
        "zoom" -> TransitionKind.ZOOM
        "wipe" -> TransitionKind.WIPE
        "dip", "dip-black", "dip_black" -> TransitionKind.DIP_BLACK
        "dip-white", "dip_white" -> TransitionKind.DIP_WHITE
        "blur" -> TransitionKind.BLUR
        else -> TransitionKind.UNSUPPORTED_HARD_CUT
    }

    /** Base-alpha ramp (crossfade / zoom / dip / blur); wipe and motion do not. */
    fun usesAlpha(rawKind: String): Boolean =
        when (classify(rawKind)) {
            TransitionKind.CROSSFADE,
            TransitionKind.ZOOM,
            TransitionKind.DIP_BLACK,
            TransitionKind.DIP_WHITE,
            TransitionKind.BLUR,
            -> true
            else -> false
        }

    /** Slide/push/wipe paint the incoming head OVER the base, like the preview. */
    fun paintsHeadAboveBase(rawKind: String): Boolean =
        when (classify(rawKind)) {
            TransitionKind.SLIDE, TransitionKind.PUSH, TransitionKind.WIPE -> true
            else -> false
        }

    /** Dip colour, or null when the kind is not a dip. */
    fun dipColour(rawKind: String): FloatArray? =
        when (classify(rawKind)) {
            TransitionKind.DIP_BLACK -> floatArrayOf(0f, 0f, 0f)
            TransitionKind.DIP_WHITE -> floatArrayOf(1f, 1f, 1f)
            else -> null
        }

    /** 0 at `startUs`, 1 at `endUs`, clamped outside. */
    fun progress(startUs: Long, endUs: Long, presentationTimeUs: Long): Float {
        if (endUs <= startUs) return if (presentationTimeUs >= endUs) 1f else 0f
        val elapsed = (presentationTimeUs - startUs).toDouble() / (endUs - startUs).toDouble()
        return elapsed.coerceIn(0.0, 1.0).toFloat()
    }

    /**
     * Outgoing side of a dip: colour ramps 0 -> 1 across the first HALF of the
     * window and holds at 1 (the clip ends with the window anyway).
     */
    fun outgoingDipAmount(
        startUs: Long,
        endUs: Long,
        presentationTimeUs: Long,
    ): Float = progress(startUs, startUs + (endUs - startUs) / 2, presentationTimeUs)

    /**
     * Incoming side of a dip: fully dipped until the midpoint, then 1 -> 0.
     * Identical shape to the preview's derived `amount` channel.
     */
    fun incomingDipAmount(
        startUs: Long,
        endUs: Long,
        presentationTimeUs: Long,
    ): Float = 1f - progress(startUs + (endUs - startUs) / 2, endUs, presentationTimeUs)

    /**
     * Blur transition peak sigma, in pixels, at `frameHeight`; matches the
     * preview's `intensityToSigma` (`intensity / 5 * height / 1080`) for the
     * shared `TRANSITION_BLUR_INTENSITY` of 200 — i.e. 40 px at 1080p.
     */
    fun blurSigmaPixels(frameHeight: Int, intensity: Float = 200f): Float =
        (intensity / 5f) * (frameHeight.toFloat() / 1080f)

    /** Incoming blur: peak sigma at the window start, 0 at its end. */
    fun incomingBlurSigma(
        frameHeight: Int,
        startUs: Long,
        endUs: Long,
        presentationTimeUs: Long,
    ): Float = blurSigmaPixels(frameHeight) * (1f - progress(startUs, endUs, presentationTimeUs))
}
