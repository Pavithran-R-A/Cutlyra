package app.cutlyra.editor.media

/**
 * Timing-summary model for an imported GIF (delays, loop count, dimensions).
 *
 * NOT the export driver, and never was: the real export path is
 * 1. `GifAssetPreparer` decodes the picked file into one PNG per frame in
 *    media custody,
 * 2. the JS EDL carries each frame's custody URI and its own delay
 *    (`EdlGifAsset` / `EdlGifFrame`), and
 * 3. `EdlToComposition.buildTimelineItems` feeds those exact frames to Media3,
 *    with `GifFrameTimeline` mapping the clip's source span onto them.
 * `GifExportPreflight.verify` re-decodes every referenced frame before that
 * run starts.
 *
 * Kept as the framework-free arithmetic used by unit tests (delay
 * normalisation, loop duration), and deliberately marked so nobody mistakes a
 * validated plan for an encoded GIF again.
 *
 * Android-framework-free so it can be unit-tested on the JVM.
 */
data class GifFrame(
    val index: Int,
    val delayMicros: Long,
    val hasTransparency: Boolean,
)

data class GifExportPlan(
    val assetId: String,
    val width: Int,
    val height: Int,
    val loopCount: Int, // 0 = infinite
    val frames: List<GifFrame>,
) {
    init {
        require(assetId.isNotBlank()) { "assetId must not be blank" }
        require(width > 0 && height > 0) { "dimensions must be positive" }
        require(loopCount >= 0) { "loopCount must be >= 0" }
    }

    /** Total duration of one loop in microseconds. */
    val loopDurationMicros: Long get() = frames.sumOf { it.delayMicros }

    /** Returns a normalized plan with zero/negative delays clamped to a
     *  minimum of 10ms (GIF spec: 0 delay means 100ms default in some
     *  readers, but we floor at 10ms to avoid divide-by-zero / infinite
     *  speed). */
    fun normalized(): GifExportPlan {
        val normalizedFrames = frames.map { f ->
            f.copy(delayMicros = if (f.delayMicros <= 0) 10_000L else f.delayMicros)
        }
        return copy(frames = normalizedFrames)
    }

    /** Returns true when the plan has at least one frame. */
    val isValid: Boolean get() = frames.isNotEmpty()

    companion object {
        /** Builds a plan from a frame-delay list (microseconds) and metadata. */
        fun fromDelays(
            assetId: String,
            width: Int,
            height: Int,
            loopCount: Int,
            delaysMicros: List<Long>,
            transparentIndices: Set<Int> = emptySet(),
        ): GifExportPlan = GifExportPlan(
            assetId = assetId,
            width = width,
            height = height,
            loopCount = loopCount,
            frames = delaysMicros.mapIndexed { i, d ->
                GifFrame(index = i, delayMicros = d, hasTransparency = i in transparentIndices)
            },
        )
    }
}