package app.cutlyra.editor.media.gif

/**
 * One GIF frame's contribution to a clip's export sequence.
 *
 * `frameIndex` indexes the asset's GIF frame list; `timelineTicks` is the
 * length this frame occupies on the export timeline.
 */
data class GifFrameSpan(
    val frameIndex: Int,
    val timelineTicks: Long,
)

data class GifFrameTimelineArgs(
    val frameDurationTicks: List<Long>,
    val loopCount: Int,
    val sourceStartTicks: Long,
    val sourceEndTicks: Long,
    val timelineDurationTicks: Long,
    val speedNumerator: Long = 1,
    val speedDenominator: Long = 1,
)

/**
 * Maps a clip's source-time span onto the GIF's frames, exactly the way the
 * shared renderer does (`selectGifFrameIndex` in `media/gif-asset.ts`):
 *
 *  - `sourceStartTicks` is the clip's trim start in the GIF's own timeline;
 *  - infinite GIFs wrap, finite ones hold their last frame once every loop has
 *    elapsed;
 *  - clip speed converts source ticks to timeline ticks (`timeline =
 *    source * denominator / numerator`).
 *
 * Rounds only at frame boundaries and forces the spans to sum to the clip's
 * timeline duration, so a long hold cannot drift the following clips.
 */
object GifFrameTimeline {
    fun spans(args: GifFrameTimelineArgs): List<GifFrameSpan> {
        val frameDurationTicks = args.frameDurationTicks
        val loopCount = args.loopCount
        val sourceStartTicks = args.sourceStartTicks
        val sourceEndTicks = args.sourceEndTicks
        val timelineDurationTicks = args.timelineDurationTicks
        val speedNumerator = args.speedNumerator
        val speedDenominator = args.speedDenominator

        require(speedNumerator > 0 && speedDenominator > 0) { "speed must be positive" }
        require(timelineDurationTicks >= 0) { "duration must not be negative" }
        if (frameDurationTicks.isEmpty() || timelineDurationTicks == 0L) return emptyList()

        val totalLoopTicks = frameDurationTicks.sum()
        if (totalLoopTicks <= 0) return emptyList()

        val cumulative = LongArray(frameDurationTicks.size)
        var running = 0L
        for (i in frameDurationTicks.indices) {
            cumulative[i] = running
            running += frameDurationTicks[i].coerceAtLeast(0)
        }

        fun isFinished(sourceTicks: Long): Boolean =
            loopCount > 0 && sourceTicks >= totalLoopTicks * loopCount

        fun frameAt(sourceTicks: Long): Int {
            if (isFinished(sourceTicks)) return frameDurationTicks.lastIndex
            val loopPos = sourceTicks % totalLoopTicks
            for (i in frameDurationTicks.indices) {
                val duration = frameDurationTicks[i].coerceAtLeast(0)
                if (duration > 0 && loopPos < cumulative[i] + duration) return i
            }
            return frameDurationTicks.lastIndex
        }

        val spans = mutableListOf<GifFrameSpan>()
        var sourceCursor = sourceStartTicks
        var remainingTimeline = timelineDurationTicks
        val sourceEnd = maxOf(sourceStartTicks, sourceEndTicks)

        while (remainingTimeline > 0) {
            val frameIndex = frameAt(sourceCursor)
            val frameDuration = frameDurationTicks[frameIndex].coerceAtLeast(1)
            val loopPos =
                if (isFinished(sourceCursor)) frameDuration
                else sourceCursor % totalLoopTicks
            val positionInFrame = (loopPos - cumulative[frameIndex]).coerceIn(0, frameDuration)
            val frameRemaining = frameDuration - positionInFrame
            val sourceRemaining =
                if (sourceCursor < sourceEnd) sourceEnd - sourceCursor
                else frameRemaining

            val availableSource = minOf(frameRemaining, sourceRemaining).coerceAtLeast(0)
            // The source span always converts through the speed ratio. When
            // the source has run out (a finite GIF past its last loop, or a
            // trim shorter than the clip), `availableSource` is 0 and the
            // REST of the clip is the held frame.
            val timelineForChunk =
                if (availableSource == 0L) {
                    remainingTimeline
                } else {
                    scale(
                        sourceTicks = availableSource,
                        numerator = speedNumerator,
                        denominator = speedDenominator,
                    ).coerceIn(1, remainingTimeline)
                }

            spans.add(GifFrameSpan(frameIndex = frameIndex, timelineTicks = timelineForChunk))
            remainingTimeline -= timelineForChunk
            if (availableSource <= 0L) {
                // Malformed/zero-length frame data: stop rather than spin.
                break
            }
            sourceCursor += availableSource
        }

        if (remainingTimeline > 0) {
            val last = spans.lastOrNull()
            if (last != null) {
                spans[spans.lastIndex] = last.copy(timelineTicks = last.timelineTicks + remainingTimeline)
            }
        }
        // Merge adjacent repeats (a held last frame, or the same frame split
        // by a loop boundary) into ONE export item per visible change.
        val merged = mutableListOf<GifFrameSpan>()
        for (span in spans) {
            val previous = merged.lastOrNull()
            if (previous != null && previous.frameIndex == span.frameIndex) {
                merged[merged.lastIndex] =
                    previous.copy(timelineTicks = previous.timelineTicks + span.timelineTicks)
            } else {
                merged.add(span)
            }
        }
        return merged
    }

    /** `sourceTicks / speed` as integer ticks, rounding half up. */
    fun scale(sourceTicks: Long, numerator: Long, denominator: Long): Long {
        val product = sourceTicks.toDouble() * denominator.toDouble() / numerator.toDouble()
        return Math.round(product)
    }
}
