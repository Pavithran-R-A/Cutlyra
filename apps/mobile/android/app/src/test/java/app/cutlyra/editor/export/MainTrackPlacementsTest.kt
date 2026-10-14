package app.cutlyra.editor.export

import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlRational
import app.cutlyra.editor.edl.EdlTransform
import app.cutlyra.editor.edl.EdlTransition
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Stage 18 regression suite for the preview-parity placement math
 * (port of `packages/editor-core/src/timeline/transitions.test.ts` — same
 * fixture numbers: ticksPerSecond 120000, clip-a 2.0s, clip-b ~1.333s,
 * cross-fade 0.2s). The TS suite asserts the preview's compressed placements;
 * these assert the Android exporter reproduces the SAME timeline, which is
 * what makes a blended export (and a seam-free one) possible.
 */
class MainTrackPlacementsTest {
    private val tps = 120_000L
    private fun t(seconds: Double): Long = Math.round(seconds * tps)

    private fun clip(
        id: String,
        startSec: Double,
        durationSec: Double,
        sourceStartSec: Double = 0.0,
    ): EdlClip = EdlClip(
        clipId = id,
        kind = "video",
        assetId = "asset-1",
        name = id,
        startTicks = t(startSec),
        durationTicks = t(durationSec),
        sourceStartTicks = t(sourceStartSec),
        sourceEndTicks = t(sourceStartSec + durationSec),
        speed = EdlRational(1, 1),
        maintainPitch = false,
        volumeDb = 0.0,
        muted = false,
        hidden = false,
        transform = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0),
        opacity = 1.0,
        effects = emptyList(),
        hasMasks = false,
        animations = emptyList(),
        params = emptyMap(),
    )

    private fun fade(after: String, durationSec: Double, id: String = "tr-$after"): EdlTransition =
        EdlTransition(
            transitionId = id,
            afterClipId = after,
            kind = "cross_fade",
            durationTicks = t(durationSec),
        )

    private val clipA = clip("clip-a", 0.0, 2.0)
    private val clipB = clip("clip-b", 2.0, 2.0 / 1.5)

    @Test
    fun pulls_the_incoming_clip_earlier_by_exactly_the_transition_duration() {
        val result = MainTrackPlacements.build(listOf(clipA, clipB), listOf(fade("clip-a", 0.2)))

        assertEquals(1, result.windows.size)
        assertEquals(t(1.8), result.windows[0].startTicks)
        assertEquals(t(0.2), result.windows[0].durationTicks)
        assertEquals("clip-a", result.windows[0].afterClipId)
        assertEquals("clip-b", result.windows[0].incomingClip.clipId)

        assertEquals(0L, result.placedClips[0].leadingOverlapTicks)
        assertEquals(t(1.8), result.placedClips[1].insertStartTicks)
        assertEquals(t(0.2), result.placedClips[1].leadingOverlapTicks)
        // Back-to-back placement: clip-b starts where clip-a ends.
        assertEquals(t(2.0), result.placedClips[1].clip.startTicks)
        // Its head is not re-played: duration is shortened, source front-trimmed.
        assertEquals(t(2.0 / 1.5) - t(0.2), result.placedClips[1].clip.durationTicks)
        assertEquals(t(0.2), result.placedClips[1].clip.sourceStartTicks)
        // Total placed duration == clipA + clipB - overlap.
        val total = result.placedClips.sumOf { it.clip.durationTicks }
        assertEquals(t(2.0) + t(2.0 / 1.5) - t(0.2), total)
    }

    @Test
    fun ripples_downstream_clips_left_by_the_cumulative_overlap() {
        val clipC = clip("clip-c", 2.0 + 2.0 / 1.5, 2.0)
        val result = MainTrackPlacements.build(
            listOf(clipA, clipB, clipC),
            listOf(fade("clip-a", 0.2)),
        )

        // clip-c has no incoming transition but follows the compressed clip-b.
        assertEquals(t(1.8) + t(2.0 / 1.5), result.placedClips[2].insertStartTicks)
        assertEquals(0L, result.placedClips[2].leadingOverlapTicks)
        assertEquals(t(2.0), result.placedClips[2].clip.durationTicks)
    }

    @Test
    fun two_crossfades_cascade_into_a_fully_compressed_timeline() {
        val clipC = clip("clip-c", 2.0 + 2.0 / 1.5, 2.0)
        val result = MainTrackPlacements.build(
            listOf(clipA, clipB, clipC),
            listOf(fade("clip-a", 0.2), fade("clip-b", 0.3, id = "tr-2")),
        )

        assertEquals(2, result.windows.size)
        assertEquals(t(1.8), result.windows[0].startTicks)
        // Window 2 ends where clip-b's COMPRESSED span ends
        // (nominal end 3.3333s minus the first overlap 0.2s).
        assertEquals(t(2.0 + 2.0 / 1.5) - t(0.2), result.windows[1].startTicks + t(0.3))

        assertEquals(t(0.3), result.placedClips[2].leadingOverlapTicks)
        val total = result.placedClips.sumOf { it.clip.durationTicks }
        assertEquals(t(2.0) + t(2.0 / 1.5) + t(2.0) - t(0.2) - t(0.3), total)
    }

    @Test
    fun drops_a_transition_whose_after_clip_was_deleted_dormant_no_throw() {
        val result = MainTrackPlacements.build(
            listOf(clipA, clipB),
            listOf(fade("deleted-clip", 0.2)),
        )
        assertEquals(0, result.windows.size)
        assertTrue(result.placedClips.all { it.leadingOverlapTicks == 0L })
    }

    @Test
    fun drops_a_transition_after_the_last_clip() {
        val result = MainTrackPlacements.build(
            listOf(clipA, clipB),
            listOf(fade("clip-b", 0.2)),
        )
        assertEquals(0, result.windows.size)
    }

    @Test
    fun non_crossfade_kinds_degrade_to_a_hard_cut() {
        val result = MainTrackPlacements.build(
            listOf(clipA, clipB),
            listOf(
                EdlTransition(
                    transitionId = "tr-wipe",
                    afterClipId = "clip-a",
                    kind = "wipe",
                    durationTicks = t(0.2),
                ),
            ),
        )
        assertEquals(0, result.windows.size)
        assertTrue(result.placedClips.all { it.leadingOverlapTicks == 0L })
    }

    @Test
    fun remap_shifts_nominal_starts_by_the_cumulative_overlap() {
        val clipC = clip("clip-c", 2.0 + 2.0 / 1.5, 2.0)
        val result = MainTrackPlacements.build(
            listOf(clipA, clipB, clipC),
            listOf(fade("clip-a", 0.2)),
        )

        // Elements before the first incoming clip are unaffected.
        assertEquals(t(1.0), result.remapNominalTick(t(1.0)))
        // clip-b's nominal start moves to its compressed start.
        assertEquals(t(1.8), result.remapNominalTick(t(2.0)))
        // Everything after inherits the shift.
        assertEquals(t(2.0 + 2.0 / 1.5) - t(0.2), result.remapNominalTick(t(2.0 + 2.0 / 1.5)))
    }

    @Test
    fun empty_input_produces_empty_placements() {
        val result = MainTrackPlacements.build(emptyList(), listOf(fade("clip-a", 0.2)))
        assertTrue(result.placedClips.isEmpty())
        assertTrue(result.windows.isEmpty())
    }

    private fun assertTrue(condition: Boolean) {
        org.junit.Assert.assertTrue(condition)
    }
}
