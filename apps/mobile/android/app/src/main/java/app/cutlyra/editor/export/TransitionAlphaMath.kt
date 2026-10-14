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
    data class Window(val startUs: Long, val endUs: Long) {
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

    /** v1 scope (plan §2.3 rule 4): cross-fade is the only transition kind
     * with a real alpha curve. Everything else maps to a hard cut (the base
     * sequence's own natural behavior) rather than shipping a transition
     * that only half-works — same "cut, don't ship inconsistent" posture as
     * the golden-frame gate (plan §2.3 rule 3). Wipe/slide are listed in the
     * plan's v1 effect surface but need a position-ramp, not an alpha-ramp;
     * out of scope for this pass (see `not_done`). */
    enum class TransitionKind { CROSSFADE, UNSUPPORTED_HARD_CUT }

    fun classify(rawKind: String): TransitionKind = when (rawKind.lowercase()) {
        "crossfade", "cross-fade", "cross_fade", "dissolve" -> TransitionKind.CROSSFADE
        else -> TransitionKind.UNSUPPORTED_HARD_CUT
    }
}
