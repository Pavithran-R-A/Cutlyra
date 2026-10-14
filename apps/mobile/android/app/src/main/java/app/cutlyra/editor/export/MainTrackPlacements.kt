package app.cutlyra.editor.export

import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlTransition

/**
 * Main-track placements for cross-fade transitions — the Android port of the
 * editor's `packages/editor-core/src/timeline/transitions.ts`
 * (`computeMainTrackPlacements` + `buildNominalToOutputRemap`), which is
 * itself a port of the iOS `MainTrackPlacement.swift`.
 *
 * WHY THIS EXISTS (Stage 18 POCO regression, 2026-10-12): the preview
 * COMPRESSES the main track around a cross-fade (the incoming clip is pulled
 * `duration` earlier and overlaps the outgoing clip's tail), but the Android
 * exporter laid the clips out nominally (back-to-back, no overlap). Without
 * the overlap there is no shared time range to blend in, and — combined with
 * media3's compositor painting the PRIMARY input on top (see
 * `CrossfadeCompositorSettings`) — the exported file rendered the junction
 * as a hard cut even though the transition was present in the EDL.
 *
 * The composition's timeline is the primary (base) sequence's back-to-back
 * order, so this class reports, per main-track clip:
 *
 *   - `clip`            the NORMALIZED clip: source front-trimmed by the
 *                       overlap it must not re-play (its head is rendered by
 *                       the transition overlay sequence instead), positioned
 *                       at the back-to-back sequence position. Playing these
 *                       back-to-back reproduces the preview's compressed
 *                       timeline exactly (total = sum(durations) −
 *                       sum(cross-fade overlaps)).
 *   - `insertStartTicks` the element-local zero on the output timeline (the
 *                       keyframe/animation origin the preview uses).
 *
 * plus one output-timeline `TransitionWindow` per cross-fade, and a
 * `remapNominalTick` step function for everything OUTSIDE the main track
 * (text/caption overlays, PiP clips, music/audio tracks), whose nominal
 * starts must shift earlier by the cumulative overlaps ahead of them —
 * same approximation as the TS/Swift sides: only an element's START is
 * remapped, its duration is kept.
 *
 * Dormant transitions (unknown or last-clip `afterClipId`) and non-crossfade
 * kinds (which degrade to a hard cut on the native side) are dropped here —
 * mirroring the TS producer/consumer behavior; no exception is thrown for
 * them. Genuine mis-placements (a cross-fade longer than a neighbour) still
 * throw from `EdlToComposition`, which validates before calling this.
 */
data class MainTrackPlacements(
    /** Normalized main-track clips, timeline order (video + audio input). */
    val placedClips: List<PlacedClip>,
    /** One window per cross-fade, in output-timeline ticks. */
    val windows: List<TransitionWindow>,
    private val remapBreakpoints: List<RemapBreakpoint>,
) {
    data class PlacedClip(
        /** Source front-trimmed and positioned for back-to-back playback. */
        val clip: EdlClip,
        /** Element-local zero on the output timeline (keyframe origin). */
        val insertStartTicks: Long,
        /** Overlap consumed from the front of this clip (0 when none). */
        val leadingOverlapTicks: Long,
    )

    data class TransitionWindow(
        val transitionId: String,
        val afterClipId: String,
        /** ORIGINAL (untrimmed) incoming clip — the transition overlay plays its head. */
        val incomingClip: EdlClip,
        val startTicks: Long,
        val durationTicks: Long,
    )

    data class RemapBreakpoint(val nominalStartTicks: Long, val shiftTicks: Long)

    /** Nominal tick -> output tick (start-only, cumulative overlap shift). */
    fun remapNominalTick(nominalTicks: Long): Long {
        var shift = 0L
        for (bp in remapBreakpoints) {
            if (bp.nominalStartTicks <= nominalTicks) shift = bp.shiftTicks
        }
        return (nominalTicks - shift).coerceAtLeast(0L)
    }

    companion object {
        /**
         * @param clips main-track visual clips, any order (sorted here).
         * @param transitions `edl.transitions` as authored (any order).
         * @param ticksPerSecond EDL ticks per second (kept for callers/tests).
         */
        fun build(
            clips: List<EdlClip>,
            transitions: List<EdlTransition>,
        ): MainTrackPlacements {
            val sorted = clips.sortedWith(compareBy({ it.startTicks }, { it.clipId }))
            if (sorted.isEmpty()) {
                return MainTrackPlacements(emptyList(), emptyList(), emptyList())
            }

            // Cross-fade transitions by the index of the clip they FOLLOW.
            // Unknown targets and transitions after the last clip are dormant
            // (dropped, no throw) — same rule as the TS side.
            val crossfadeAfterIndex = HashMap<Int, EdlTransition>()
            val sortedIds = sorted.map { it.clipId }.toSet()
            for (transition in transitions) {
                if (TransitionAlphaMath.classify(transition.kind) !=
                    TransitionAlphaMath.TransitionKind.CROSSFADE
                ) {
                    continue // v1: other kinds degrade to a hard cut.
                }
                val index = sorted.indexOfFirst { it.clipId == transition.afterClipId }
                if (index < 0 || !sortedIds.contains(transition.afterClipId)) continue
                if (index + 1 >= sorted.size) continue
                crossfadeAfterIndex[index] = transition
            }

            val placed = ArrayList<PlacedClip>(sorted.size)
            val windows = ArrayList<TransitionWindow>()
            // Sequence (back-to-back) position the next base item starts at.
            var sequenceCursor = 0L
            // Element-local/output position of the next clip in the compressed
            // preview timeline (drives keyframe origins + window math).
            var insertCursor = sorted[0].startTicks

            for ((index, clip) in sorted.withIndex()) {
                val transition = crossfadeAfterIndex[index - 1]?.takeIf { index > 0 }
                val overlap = transition?.durationTicks ?: 0L
                val insertStart =
                    if (index == 0) {
                        clip.startTicks
                    } else if (transition != null && overlap > 0) {
                        // Compressed: pulled `overlap` earlier than the cursor.
                        insertCursor - overlap
                    } else {
                        insertCursor
                    }
                // The base sequence plays items back-to-back (it cannot wait),
                // so a clip whose compressed start is EARLIER than the sequence
                // cursor is front-trimmed by exactly the overlap; its head is
                // rendered by the transition overlay during the window.
                // Negative values (a nominal gap the base sequence closes, the
                // pre-existing behavior) clamp to 0.
                val leadingOverlap = (sequenceCursor - insertStart).coerceAtLeast(0L)
                val normalized =
                    if (leadingOverlap > 0) {
                        clip.copy(
                            startTicks = sequenceCursor,
                            durationTicks = clip.durationTicks - leadingOverlap,
                            sourceStartTicks =
                                clip.sourceStartTicks +
                                    Math.round(leadingOverlap * clip.speed.toDouble()),
                        )
                    } else {
                        clip.copy(startTicks = sequenceCursor)
                    }
                placed.add(
                    PlacedClip(
                        clip = normalized,
                        insertStartTicks = insertStart,
                        leadingOverlapTicks = leadingOverlap,
                    ),
                )

                // The window for the transition FOLLOWING this clip sits at
                // the tail of THIS clip's rendered span; the incoming clip
                // (sorted[index + 1]) plays its head there, beneath the base
                // while the base's alpha dips.
                val transitionAfter = crossfadeAfterIndex[index]
                if (transitionAfter != null && transitionAfter.durationTicks > 0) {
                    val windowDuration = transitionAfter.durationTicks
                    val renderedEnd = sequenceCursor + normalized.durationTicks
                    windows.add(
                        TransitionWindow(
                            transitionId = transitionAfter.transitionId,
                            afterClipId = clip.clipId,
                            incomingClip = sorted[index + 1],
                            startTicks = renderedEnd - windowDuration,
                            durationTicks = windowDuration,
                        ),
                    )
                }

                sequenceCursor += normalized.durationTicks
                insertCursor = insertStart + clip.durationTicks
            }

            // Start-only remap for non-main elements: breakpoint at each
            // incoming clip's NOMINAL start, cumulative shift (TS parity).
            val breakpoints = ArrayList<RemapBreakpoint>()
            var cumulativeShift = 0L
            for (index in sorted.indices) {
                val transition = crossfadeAfterIndex[index] ?: continue
                // The incoming clip (the one AFTER the transition target).
                val incomingNominal = sorted.getOrNull(index + 1)?.startTicks ?: continue
                cumulativeShift += transition.durationTicks
                breakpoints.add(RemapBreakpoint(incomingNominal, cumulativeShift))
            }
            breakpoints.sortBy { it.nominalStartTicks }

            return MainTrackPlacements(placed, windows, breakpoints)
        }
    }
}
