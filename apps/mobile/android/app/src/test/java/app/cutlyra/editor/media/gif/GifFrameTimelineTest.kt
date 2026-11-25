package app.cutlyra.editor.media.gif

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GifFrameTimelineTest {
    private val gif = listOf(24_000L, 36_000L, 60_000L) // 200/300/500 ms at 120k tps

    private fun spans(
        frameDurations: List<Long> = gif,
        loopCount: Int = 0,
        sourceStart: Long = 0,
        sourceEnd: Long = 120_000L,
        duration: Long = 120_000L,
        speedNumerator: Long = 1,
        speedDenominator: Long = 1,
    ) = GifFrameTimeline.spans(
        GifFrameTimelineArgs(
            frameDurationTicks = frameDurations,
            loopCount = loopCount,
            sourceStartTicks = sourceStart,
            sourceEndTicks = sourceEnd,
            timelineDurationTicks = duration,
            speedNumerator = speedNumerator,
            speedDenominator = speedDenominator,
        ),
    )

    @Test
    fun one_loop_walks_every_frame_for_its_own_delay() {
        val result = spans()
        assertEquals(listOf(0, 1, 2), result.map { it.frameIndex })
        assertEquals(listOf(24_000L, 36_000L, 60_000L), result.map { it.timelineTicks })
    }

    @Test
    fun an_endless_gif_wraps_by_its_total_loop_length() {
        val result = spans(duration = 240_000L, sourceEnd = 240_000L)
        assertEquals(listOf(0, 1, 2, 0, 1, 2), result.map { it.frameIndex })
        assertEquals(240_000L, result.sumOf { it.timelineTicks })
    }

    @Test
    fun trim_start_selects_the_frame_at_that_source_time() {
        // 200 ms in: starts on GREEN, then BLUE.
        val result = spans(sourceStart = 24_000L, sourceEnd = 120_000L, duration = 96_000L)
        assertEquals(listOf(1, 2), result.map { it.frameIndex })
        assertEquals(listOf(36_000L, 60_000L), result.map { it.timelineTicks })
    }

    @Test
    fun a_finite_gif_holds_its_last_frame_after_the_final_loop() {
        val twoFrames = listOf(12_000L, 12_000L) // 100 ms each
        val result = spans(
            frameDurations = twoFrames,
            loopCount = 2,
            sourceStart = 0,
            sourceEnd = 48_000L,
            duration = 96_000L,
        )
        assertEquals(listOf(0, 1, 0, 1), result.map { it.frameIndex })
        // The loop's final 120 ms and the 480 ms held tail are one span
        // (the frame does not change between them).
        assertEquals(60_000L, result[3].timelineTicks)
        assertEquals(96_000L, result.sumOf { it.timelineTicks })
    }

    @Test
    fun speed_converts_source_ticks_to_timeline_ticks() {
        // 2x speed: 1 s of GIF spans 0.5 s of timeline.
        val result = spans(
            sourceEnd = 120_000L,
            duration = 60_000L,
            speedNumerator = 2,
            speedDenominator = 1,
        )
        assertEquals(60_000L, result.sumOf { it.timelineTicks })
        assertEquals(listOf(0, 1, 2), result.map { it.frameIndex })
    }

    @Test
    fun spans_always_fill_the_clip_even_with_slow_motion_and_odd_rounding() {
        val result = spans(
            sourceEnd = 120_000L,
            duration = 180_000L,
            speedNumerator = 2,
            speedDenominator = 3,
        )
        assertEquals(180_000L, result.sumOf { it.timelineTicks })
        assertTrue(result.all { it.timelineTicks > 0 })
    }

    @Test
    fun empty_or_zero_duration_inputs_produce_no_spans() {
        assertTrue(spans(frameDurations = emptyList()).isEmpty())
        assertTrue(spans(duration = 0).isEmpty())
    }
}
