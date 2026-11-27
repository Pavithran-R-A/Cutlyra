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
     * Deliberately NOT here: "wipe" needs an animated mask/wipe fragment pass
     * and "dip" needs a full-frame colour layer in both renderers. Shipping
     * either as a look-alike would make the preview and the file disagree.
     */
    enum class TransitionKind { CROSSFADE, SLIDE, PUSH, ZOOM, UNSUPPORTED_HARD_CUT }

    fun classify(rawKind: String): TransitionKind = when (rawKind.lowercase()) {
        "fade", "crossfade", "cross-fade", "cross_fade", "dissolve" -> TransitionKind.CROSSFADE
        "slide" -> TransitionKind.SLIDE
        "push" -> TransitionKind.PUSH
        "zoom" -> TransitionKind.ZOOM
        else -> TransitionKind.UNSUPPORTED_HARD_CUT
    }

    /** Base-alpha ramp (crossfade / zoom); the others reveal by motion alone. */
    fun usesAlpha(rawKind: String): Boolean =
        when (classify(rawKind)) {
            TransitionKind.CROSSFADE, TransitionKind.ZOOM -> true
            else -> false
        }

    /** Slide/push paint the incoming head OVER the base, like the preview. */
    fun paintsHeadAboveBase(rawKind: String): Boolean =
        when (classify(rawKind)) {
            TransitionKind.SLIDE, TransitionKind.PUSH -> true
            else -> false
        }
}
