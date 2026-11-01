package app.cutlyra.editor.export

import androidx.media3.common.C
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.SpeedParameters
import androidx.media3.common.util.Size
import androidx.media3.effect.AlphaScale
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.StaticOverlaySettings
import androidx.media3.transformer.Composition
import com.google.common.collect.ImmutableList
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import app.cutlyra.editor.edl.Edl
import app.cutlyra.editor.edl.EdlAsset
import app.cutlyra.editor.edl.EdlAssetKind
import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlOverlayKind
import app.cutlyra.editor.edl.EdlTrackKind
import app.cutlyra.editor.edl.EdlTrackType

/**
 * EDL v1 -> Media3 `Composition` (plan M9). THE deliverable of the
 * "build the cross-fade compositor first" risk item (plan risk #4,
 * `08` §8): see `TransitionAlphaMath`/`CrossfadeCompositorSettings` for the
 * mechanism this class wires up.
 *
 * Sequence-index layout of the returned `Composition` (also documented on
 * `CrossfadeCompositorSettings`):
 *   0                    -> base sequence: every main-track video/image clip,
 *                           hard-cut, in order, on the COMPRESSED timeline
 *                           (`MainTrackPlacements` — preview parity, Stage 18).
 *                           Fades out inside a transition window: media3
 *                           paints the primary last (on top), so the base's
 *                           own alpha is what makes the cross-fade visible.
 *   1..transitions.size  -> one short overlay sequence per CROSS-FADE
 *                           transition (non-crossfade `EdlTransition.kind`s
 *                           degrade to a hard cut, i.e. contribute NO
 *                           sequence — plan §2.3 rule 3/4).
 *   next..               -> one sequence per clip on an `overlay` track of
 *                           `trackType` video/graphic (PiP-style layers).
 *   last N                -> one sequence per `audio`-kind track
 *                           (video removed on every item).
 *
 * Text/caption overlays do NOT get their own sequence — they are collected
 * into a single composition-level `OverlayEffect` (see `EdlTextOverlay`).
 *
 * WHAT THIS CLASS DELIBERATELY REFUSES (throws `ExportUnsupportedException`
 * rather than silently degrading — plan §2.3 rule 3's "cut, don't ship
 * inconsistent"): masks, keyframes on anything but `transform.*`/`opacity`
 * (round 47 made those real — `KeyframeEvaluator`), effect types native
 * export does not implement, and adjust/filter effects carrying `sharpen` or
 * `vignette` (GitHub #48 — see `ColorGrade`, which maps the affine subset and
 * names the params it cannot express). An asset with `sourceUri == null` is
 * also a hard error: it means M4's media-custody import never ran for that
 * asset, which is a producer bug the exporter should surface immediately, not
 * paper over.
 */
object EdlToComposition {
    fun buildComposition(
        edl: Edl,
        /** Preview-rendered text/caption images (round 37). When non-empty
         *  these REPLACE `EdlTextOverlay`, so the exported overlay layer is
         *  the editor's own drawing rather than a second implementation of
         *  it — see `PrerenderedOverlay`. */
        overlayFrames: List<PrerenderedOverlay.Frame> = emptyList(),
    ): Composition {
        val tps = edl.meta.ticksPerSecond
        fun us(ticks: Long): Long = ticksToUs(ticks, tps)

        val mainTrack = edl.mainTrack()
            ?: throw ExportUnsupportedException("EDL has no main track")
        val mainClips = mainTrack.clips
            .filter { it.kind == "video" || it.kind == "image" }
            .sortedBy { it.startTicks }
        if (mainClips.isEmpty()) {
            throw ExportUnsupportedException("main track has no video/image clips")
        }

        // Cross-fade placements: reproduce the preview's compressed timeline
        // (Stage 18 POCO regression) — an overlap window per cross-fade to
        // blend in, base clips front-trimmed by their overlap so no head is
        // played twice, and a start-remap for everything outside the main
        // track. Dormant/non-crossfade transitions are dropped inside
        // `build()`; a cross-fade that cannot fit inside BOTH neighbours is a
        // hard error (plan §2.3 rule 3: fail loudly, never degrade).
        val placements = MainTrackPlacements.build(mainClips, edl.transitions)
        for (window in placements.windows) {
            val afterClip = mainClips.first { it.clipId == window.afterClipId }
            val incomingClip = window.incomingClip
            if (window.durationTicks <= 0 ||
                window.durationTicks > afterClip.durationTicks ||
                window.durationTicks > incomingClip.durationTicks
            ) {
                throw ExportUnsupportedException(
                    "transition ${window.transitionId} durationTicks=${window.durationTicks} " +
                        "does not fit within both adjacent clips (${afterClip.clipId}=${afterClip.durationTicks}, " +
                        "${incomingClip.clipId}=${incomingClip.durationTicks})",
                )
            }
        }

        // Whole frames per second of the OUTPUT stream, from `edl.output.fps`
        // (the export sheet's selection; see export-sheet.tsx's FPS_OPTIONS).
        // Declared per visual item via `setFrameRate` in
        // `buildEditedMediaItem` — stills are synthesized at exactly this
        // rate, video is CAPPED at this rate (GitHub #21 / PAV-71; the full
        // contract, including media3's no-upsample limit, is documented
        // there).
        val outputFrameRate = Math.round(
            edl.output.fps.numerator.toDouble() / edl.output.fps.denominator.toDouble(),
        ).toInt().coerceAtLeast(1)

        val sequences = mutableListOf<EditedMediaItemSequence>()
        // A VIDEO export ends at the last VISUAL thing, not at the last audio
        // sample. Stage 14 POCO QA caught an ordinary 8 s video + 15 s MP3
        // exporting as 15 s with a 7 s black tail because meta.durationTicks
        // includes audio-only clips. Preserve intentional visual tails
        // (PiP/graphics layers can outlive the main track), but never let
        // audio alone extend the video canvas.
        //
        // Stage 18 P2 (POCO): text/caption overlays must NOT extend it
        // either. Captions are generated on the AUDIO clock, so a caption
        // track routinely outlives an 8 s video under 15 s of speech —
        // counting `textOverlayEndTicks` here re-opened exactly the
        // Stage-15 loophole it was written to close: the same project
        // exported 8.05 s without captions and 15.03 s (7 s of black) with
        // them. The speech those trailing captions belong to is itself
        // trimmed to the visual end below (see `addAudioSequence`), so
        // keeping the captions would burn text describing audio that is no
        // longer in the file. Captions over real video still render — only
        // the black-tail extension is gone.
        val mainEndTicks = placements.placedClips.maxOf { it.clip.startTicks + it.clip.durationTicks }
        val overlayVisualEndTicks = edl.tracks
            .asSequence()
            .filter {
                it.kind == EdlTrackKind.OVERLAY &&
                    (it.trackType == EdlTrackType.VIDEO || it.trackType == EdlTrackType.GRAPHIC)
            }
            .flatMap { it.clips.asSequence() }
            .maxOfOrNull { placements.remapNominalTick(it.startTicks) + it.durationTicks }
            ?: 0L
        val projectEndTicks = maxOf(mainEndTicks, overlayVisualEndTicks)
        val transitionWindows = mutableMapOf<Int, TransitionAlphaMath.Window>()
        val overlaySettingsByIndex = mutableMapOf<Int, StaticOverlaySettings>()
        val animatedOverlayAlphaByIndex = mutableMapOf<Int, CrossfadeCompositorSettings.AnimatedOverlayAlpha>()

        // -- index 0: base sequence, hard-cut, always opaque -----------------
        // DECLARED track types, not inferred. media3 1.11.0 replaced the
        // (now-deprecated) experimentalSetForce{Audio,Video}Track flags with
        // this constructor, and declaring them is what lets a sequence contain
        // a leading gap, an item with no audio (a still), or an item with no
        // video (a music clip) — media3 synthesizes silence/blank frames for
        // the declared-but-absent track instead of failing. Leaving it to be
        // inferred is what produced, in order on the emulator: the gap
        // exception, then a released-audio-input crash at 54%.
        var baseSeqBuilder = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_VIDEO))
        for (placed in placements.placedClips) {
            baseSeqBuilder = baseSeqBuilder.addItem(
                buildEditedMediaItem(
                    clip = placed.clip,
                    asset = requireAsset(edl, placed.clip),
                    us = ::us,
                    ticksPerSecond = tps,
                    canvasWidth = edl.meta.canvasWidth,
                    canvasHeight = edl.meta.canvasHeight,
                    frameRate = outputFrameRate,
                    outputWidth = edl.output.resolutionWidth,
                    outputHeight = edl.output.resolutionHeight,
                    // Keyframes/animations run on the preview's own
                    // element-local clock, not the sequence position.
                    itemStartTicks = placed.insertStartTicks,
                    // Video only — the main track's audio rides its own
                    // sequence (see "audio sequences" below).
                    removeAudio = true,
                ),
            )
        }
        // Black tail. Without it the video stream simply STOPS at the last
        // main clip while a PiP/graphic overlay (and the audio) runs on — a
        // torn file whose video track is shorter than the rest. A gap in a
        // video-declared sequence is exactly the blank-frame filler iOS gets
        // from its pacer lane. Note this gap is now keyed only to VISUAL
        // overlays: text/caption tails no longer reach `projectEndTicks`
        // (Stage 18 P2), so captions past the last clip are trimmed with the
        // audio they belong to instead of drawing onto 7 s of black.
        if (mainEndTicks < projectEndTicks) {
            baseSeqBuilder = baseSeqBuilder.addGap(us(projectEndTicks - mainEndTicks))
        }
        sequences.add(baseSeqBuilder.build())

        // -- 1..N: one overlay sequence per cross-fade transition ------------
        // Windows come from `placements` (validated above): they sit on the
        // COMPRESSED output timeline, at the tail of the OUTGOING clip's
        // rendered span — exactly where the base's alpha dips and the head
        // beneath it must play.
        var nextIndex = 1
        for (window in placements.windows) {
            val incomingClip = window.incomingClip
            val windowStartTicks = window.startTicks
            val windowStartUs = us(windowStartTicks)
            val windowEndUs = us(window.startTicks + window.durationTicks)

            val headClip = incomingClip.copy(
                durationTicks = window.durationTicks,
                sourceEndTicks = incomingClip.sourceStartTicks +
                    Math.round(window.durationTicks * incomingClip.speed.toDouble()),
            )
            val overlayItem = buildEditedMediaItem(
                clip = headClip,
                asset = requireAsset(edl, headClip),
                us = ::us,
                ticksPerSecond = tps,
                // The head plays the incoming clip's first `d` ticks starting
                // at the window, so that is its keyframe-local zero.
                itemStartTicks = windowStartTicks,
                canvasWidth = edl.meta.canvasWidth,
                canvasHeight = edl.meta.canvasHeight,
                frameRate = outputFrameRate,
                // GitHub #20 / PAV-70 (Stage 7): the head MUST be normalized to
                // the export resolution exactly like every other visual item.
                // media3's compositor draws each input scaled by
                // `textureSize / outputSize` (OverlayMatrixProvider, verified in
                // the 1.11.0 sources): an item with no Presentation reaches the
                // compositor at its NATIVE texture size and is painted as a
                // small centered rectangle instead of filling the frame. Stage-6's
                // export measured the incoming layer at exactly 960x540 centered
                // (coverage 0.2500) because the head alone skipped this pass.
                outputWidth = edl.output.resolutionWidth,
                outputHeight = edl.output.resolutionHeight,
                // Audio is a hard cut under a video cross-fade — Media3 has
                // no mixer-gain-ramp API to crossfade audio the same way
                // (see TransitionAlphaMath's doc comment); the base
                // sequence's own copy of `incomingClip` already carries its
                // audio starting exactly at `windowEndUs`, so including audio
                // here too would double it up during the transition window.
                removeAudio = true,
            )
            // Known media3 1.11.0 artifact (Stage 5 defect #20 investigation,
            // characterized by ExportCrossfadeLuminanceInstrumentedTest): with
            // a caption overlay pass in the composition, ONE frame near this
            // sequence's start can composite as the un-faded incoming clip.
            // Per-frame instrumentation proved this class's settings correct
            // at every queried PTS, so the artifact is inside Media3's
            // multi-input handling at secondary-stream start. A leading
            // FILLER item (stream alive from t=0) was tried as a fix and
            // measured WORSE on the 400 ms geometry (two glitch frames
            // instead of one) while fixing the 800 ms one — the timing
            // sensitivity is not reliably tunable from outside media3, so
            // the structure is kept as-is and the artifact is characterized,
            // gated and reported upstream rather than papered over.
            val overlaySeqBuilder = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_VIDEO))
            if (windowStartUs > 0) {
                overlaySeqBuilder.addGap(windowStartUs)
            }
            val overlaySeq = overlaySeqBuilder
                .addItem(overlayItem)
                .build()
            sequences.add(overlaySeq)
            transitionWindows[nextIndex] = TransitionAlphaMath.Window(windowStartUs, windowEndUs)
            nextIndex++
        }

        // -- next..: overlay video/graphic tracks (PiP-style layers) ---------
        val overlayVisualTracks = edl.tracks.filter {
            it.kind == EdlTrackKind.OVERLAY &&
                (it.trackType == EdlTrackType.VIDEO || it.trackType == EdlTrackType.GRAPHIC)
        }
        for (track in overlayVisualTracks) {
            for (rawClip in track.clips.sortedBy { it.startTicks }) {
                // Nominal -> output clock (cumulative cross-fade shift ahead
                // of this clip) — same start-only remap as the preview.
                val clip = rawClip.copy(startTicks = placements.remapNominalTick(rawClip.startTicks))
                val asset = requireAsset(edl, clip)
                val animated = KeyframeEvaluator.hasVisualAnimations(clip)
                val item = buildEditedMediaItem(
                    clip = clip,
                    asset = asset,
                    us = ::us,
                    ticksPerSecond = tps,
                    canvasWidth = edl.meta.canvasWidth,
                    canvasHeight = edl.meta.canvasHeight,
                    frameRate = outputFrameRate,
                    outputWidth = edl.output.resolutionWidth,
                    outputHeight = edl.output.resolutionHeight,
                    removeAudio = true, // PiP/overlay visual layers are silent in v1.
                    // A keyframed PiP clip gets its per-frame alpha from the
                    // compositor (it composites over video, so real alpha is
                    // needed); the item itself carries no opacity effect.
                    applyOpacity = !animated,
                )
                // Gap-first sequence, video-only — same rule as the
                // transition sequence above.
                val seqBuilder = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_VIDEO))
                if (clip.startTicks > 0) {
                    seqBuilder.addGap(us(clip.startTicks))
                }
                val seq = seqBuilder
                    .addItem(item)
                    .build()
                sequences.add(seq)
                if (animated) {
                    // Round 47: geometry (position/scale/rotation, keyframed)
                    // is applied ONCE, by the item's animated
                    // `EdlTransformEffect`; the compositor only supplies the
                    // evaluated alpha. NOTE the static path below applies
                    // scale/rotation here AND (when non-identity) in the item
                    // effect — that pre-existing double application is left
                    // as-is for static clips and needs the emulator golden
                    // frame to settle; animated clips deliberately do not
                    // inherit it.
                    animatedOverlayAlphaByIndex[nextIndex] =
                        CrossfadeCompositorSettings.AnimatedOverlayAlpha(clip, us(clip.startTicks), tps)
                } else {
                    overlaySettingsByIndex[nextIndex] = StaticOverlaySettings.Builder()
                        .setAlphaScale(clip.opacity.toFloat())
                        .setScale(clip.transform.scaleX.toFloat(), clip.transform.scaleY.toFloat())
                        .setRotationDegrees(clip.transform.rotateDegrees.toFloat())
                        .build()
                }
                nextIndex++
            }
        }

        // -- audio sequences ---------------------------------------------------
        // ALL audio — the main track's own clip audio included — travels in
        // dedicated audio-only sequences, gap-padded across the project's full
        // length. The base sequence above is video-only for a reason: a
        // sequence that declares an audio track but contains an item with no
        // audio (a still, which is normal on a main track) had its audio input
        // released the moment that item started, while the previous item's
        // renderer was still feeding it — media3 then failed the whole export
        // with a bare "Asset loader error" at exactly the video->image
        // boundary (reproduced on the emulator at ~50% of a 6s-video +
        // 6s-image timeline). Splitting audio out means every audio sequence
        // holds audio for its entire length, and silence is expressed as a gap
        // (which media3 fills), not as a silent item.
        /** The clips of one audio-only sequence: audible, in time order. */
        fun audibleClips(clips: List<EdlClip>, trackMuted: Boolean): List<EdlClip> =
            clips
                .filter { clip ->
                    if (trackMuted || clip.muted || !edl.output.includeAudio || clip.assetId == null) {
                        false
                    } else {
                        // Only assets that ACTUALLY carry audio may enter an
                        // audio-only Media3 sequence. Stage 13 POCO QA found a
                        // release-blocking crash for ordinary video-only MP4s:
                        // this filter admitted them, addAudioSequence then set
                        // removeVideo=true, while buildEditedMediaItem also
                        // inferred removeAudio=true from asset.hasAudio=false.
                        // Media3 correctly rejects an EditedMediaItem with
                        // BOTH streams removed. Omitting the clip here makes
                        // its time range silence in the dedicated audio lane.
                        //
                        // Generated clips (bundled library sounds, whose
                        // sourceUrl has no asset-table entry) are still skipped
                        // above; images are silent by definition.
                        val asset = requireAsset(edl, clip)
                        asset.kind != EdlAssetKind.IMAGE && asset.hasAudio
                    }
                }
                .sortedBy { it.startTicks }

        // The summed mix is limited by `LimitingAudioMixer` (installed on the
        // Transformer), so nothing here needs to reserve headroom.
        val audioSources = buildList {
            add(audibleClips(placements.placedClips.map { it.clip }, mainTrack.muted))
            for (track in edl.tracks.filter { it.kind == EdlTrackKind.AUDIO }) {
                // Non-main audio rides the nominal clock; shift its start by
                // the cumulative overlaps ahead of it (preview parity).
                add(
                    audibleClips(
                        track.clips.map { it.copy(startTicks = placements.remapNominalTick(it.startTicks)) },
                        track.muted,
                    ),
                )
            }
        }.filter { it.isNotEmpty() }

        fun addAudioSequence(audible: List<EdlClip>) {
            var seqBuilder = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_AUDIO))
            var cursorTicks = 0L
            for (originalClip in audible) {
                // Audio clips that start beyond the visual output are not
                // part of a video export. If one straddles the visual end,
                // trim it exactly to that boundary so Media3 cannot extend the
                // composition into black frames just to finish the audio.
                if (originalClip.startTicks >= projectEndTicks) continue

                val remainingTicks = projectEndTicks - originalClip.startTicks
                val clip =
                    if (originalClip.durationTicks <= remainingTicks) {
                        originalClip
                    } else {
                        originalClip.copy(
                            durationTicks = remainingTicks,
                            sourceEndTicks = originalClip.sourceStartTicks +
                                Math.round(remainingTicks * originalClip.speed.toDouble()),
                        )
                    }

                if (clip.startTicks > cursorTicks) {
                    seqBuilder = seqBuilder.addGap(us(clip.startTicks - cursorTicks))
                }
                seqBuilder = seqBuilder.addItem(
                    buildEditedMediaItem(
                        clip = clip,
                        asset = requireAsset(edl, clip),
                        us = ::us,
                        ticksPerSecond = tps,
                        canvasWidth = edl.meta.canvasWidth,
                        canvasHeight = edl.meta.canvasHeight,
                        frameRate = outputFrameRate,
                        outputWidth = edl.output.resolutionWidth,
                        outputHeight = edl.output.resolutionHeight,
                        removeAudio = false,
                        removeVideo = true,
                    ),
                )
                cursorTicks = clip.startTicks + clip.durationTicks
            }
            // Trailing silence: a music clip is routinely shorter than the
            // visual timeline under it, and a sequence that just ENDS is torn
            // down while the composition still runs — the same released-input
            // failure. Silence may pad audio TO the visual end, never beyond it.
            if (cursorTicks < projectEndTicks) {
                seqBuilder = seqBuilder.addGap(us(projectEndTicks - cursorTicks))
            }
            sequences.add(seqBuilder.build())
        }

        for (source in audioSources) addAudioSequence(source)

        // -- text/caption overlays: one composition-level OverlayEffect -----
        // Preview-rendered frames win when supplied; the native Spannable
        // renderer below stays as the fallback for callers that send none.
        val textOverlays: List<androidx.media3.effect.TextureOverlay> =
            if (overlayFrames.isNotEmpty()) {
                listOf(PrerenderedOverlay(overlayFrames))
            } else edl.overlays
            .filter { it.kind == EdlOverlayKind.TEXT || it.kind == EdlOverlayKind.CAPTION }
            .sortedBy { it.zIndex }
            .mapNotNull { overlay ->
                val clip = findClip(edl, overlay.trackId, overlay.clipId) ?: return@mapNotNull null
                // Nominal -> output clock (start-only remap, preview parity).
                val startTicks = placements.remapNominalTick(overlay.startTicks)
                EdlTextOverlay(
                    clip = clip,
                    startUs = us(startTicks),
                    endUs = us(startTicks + overlay.durationTicks),
                    canvasWidth = edl.meta.canvasWidth,
                    canvasHeight = edl.meta.canvasHeight,
                )
            }

        val compositionVideoEffects = mutableListOf<Effect>()
        if (edl.output.resolutionWidth > 0 && edl.output.resolutionHeight > 0) {
            // GitHub #29 / PAV-82 — final output-size pass, CROP not FIT.
            //
            // Two measured constraints pin this effect's shape (isolated API-35-
            // class emulator, 2026-10-22, ExportCrossfadeLuminanceInstrumentedTest
            // + ExportCrossfadeGeometryProbeInstrumentedTest across three builds):
            //
            //  1. It MUST exist. Without any composition-level Presentation, the
            //     caption/prerendered-overlay crossfades composite the incoming
            //     clip at FULL opacity across nearly the whole transition window
            //     (measured = baselineB exactly at a=0.50 and a=0.75 on the
            //     per-item-only build) — the alpha ramp is lost. With this pass
            //     present the same fixtures blend pixel-exactly except the one
            //     characterized media3 frame at window start+100 ms.
            //  2. It must NOT shrink an already-normalized frame. The per-item
            //     SCALE_TO_FIT below (GitHub #20/#32) is what fills the frame;
            //     a second composition-level SCALE_TO_FIT re-fits the
            //     compositor's macroblock-aligned working frame (1080->1088 on
            //     the POCO) back into the output box, shrinking the picture
            //     ~0.7% and leaving the black border #29 was filed about.
            //
            // LAYOUT_SCALE_TO_FIT_WITH_CROP satisfies both: when the incoming
            // frame is already exactly output-sized it is a no-op (`isNoOp`
            // returns true for equal dimensions), so the picture keeps full
            // edge coverage; when a device hands the compositor a slightly
            // larger macroblock-aligned frame (1920x1088 on the POCO) it is
            // cropped DOWN to the output box instead of letterboxed into it,
            // so the encoder still receives the exact requested geometry with
            // no introduced border and no picture shrink. Aspect-ratio
            // mismatch cannot occur here: every visual item was already fitted
            // to this exact output size per-item, so crop-vs-fit only ever
            // differ on the alignment padding, never on content aspect — the
            // crop removes padding, not picture.
            compositionVideoEffects.add(
                Presentation.createForWidthAndHeight(
                    edl.output.resolutionWidth,
                    edl.output.resolutionHeight,
                    Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP,
                ),
            )
        }
        if (textOverlays.isNotEmpty()) {
            compositionVideoEffects.add(OverlayEffect(ImmutableList.copyOf(textOverlays)))
        }

        val compositorSettings = CrossfadeCompositorSettings(
            windowsByInputIndex = transitionWindows,
            overlayTrackSettingsByInputIndex = overlaySettingsByIndex,
            animatedOverlayAlphaByInputIndex = animatedOverlayAlphaByIndex,
            outputSize = Size(edl.output.resolutionWidth, edl.output.resolutionHeight),
        )

        // `nextIndex` ended as the count of VIDEO-producing sequences (index 0
        // is the base track; each cross-fade window and each PiP overlay clip
        // added one more). Media3 builds a SingleInputVideoGraph when there is
        // only one of them, and that graph throws
        // "SingleInputVideoGraph does not use VideoCompositor, and therefore
        // cannot apply VideoCompositorSettings" from its constructor — so a
        // plain project with no transition and no overlay clip could never
        // export at all (caught on the emulator; the audio-only sequences
        // appended after this counter do not make the graph multi-input).
        val builder = Composition.Builder(sequences)
        if (nextIndex > 1) {
            builder.setVideoCompositorSettings(compositorSettings)
        }
        return builder
            .setEffects(
                Effects(
                    emptyList(),
                    compositionVideoEffects,
                ),
            )
            .build()
    }

    private fun requireAsset(edl: Edl, clip: EdlClip): EdlAsset {
        val assetId = clip.assetId
            ?: throw ExportUnsupportedException("clip ${clip.clipId} has no assetId")
        val asset = edl.assetById(assetId)
            ?: throw ExportUnsupportedException("clip ${clip.clipId} references unknown assetId $assetId")
        if (asset.sourceUri == null) {
            throw ExportUnsupportedException(
                "asset ${asset.assetId} has no sourceUri — media import (M4) has not run for this asset",
            )
        }
        return asset
    }

    private fun findClip(edl: Edl, trackId: String, clipId: String): EdlClip? =
        edl.tracks.firstOrNull { it.trackId == trackId }
            ?.clips?.firstOrNull { it.clipId == clipId }

    private fun buildEditedMediaItem(
        clip: EdlClip,
        asset: EdlAsset,
        us: (Long) -> Long,
        ticksPerSecond: Long,
        canvasWidth: Int,
        canvasHeight: Int,
        removeAudio: Boolean,
        removeVideo: Boolean = false,
        /** Output frame rate this item must honour (whole fps). See the
         *  `setFrameRate` contract comment below. */
        frameRate: Int = 30,
        outputWidth: Int = 0,
        outputHeight: Int = 0,
        /** Composition-time start of this item = keyframe-local tick 0.
         *  Every sequence is gap-padded from 0, so it is the clip's own
         *  startTicks except for a transition head (see the caller). */
        itemStartTicks: Long = clip.startTicks,
        /** False when the compositor owns this item's opacity (animated PiP). */
        applyOpacity: Boolean = true,
    ): EditedMediaItem {
        if (clip.hasMasks) {
            throw ExportUnsupportedException(
                "clip ${clip.clipId} has masks; masks are explicitly post-v1 for native export (plan §2.3 rule 4)",
            )
        }
        val unsupportedKeyframes = KeyframeEvaluator.unsupportedAnimationPaths(clip)
        if (unsupportedKeyframes.isNotEmpty()) {
            throw ExportUnsupportedException(
                "clip ${clip.clipId} has keyframes on ${unsupportedKeyframes.joinToString()}; native export " +
                    "supports keyframes on transform.* and opacity only (round 47)",
            )
        }
        // GitHub #48 / PAV-142: effects are MAPPED, not refused. This used
        // to throw for any non-empty `clip.effects`, which made every export
        // of a project with a single Adjust slider change fail (the Adjust and
        // Filters panels write exactly these effects). `combinedMatrixFor`
        // still throws for effect types or params it cannot express, so an
        // unsupported edit fails loudly instead of vanishing from the file.
        val colorGradeMatrix = ColorGrade.combinedMatrixFor(clip)

        val sourceUri = requireNotNull(asset.sourceUri) // requireAsset() already guaranteed non-null.
        val isImage = clip.kind == "image" || asset.kind == EdlAssetKind.IMAGE

        val mediaItemBuilder = MediaItem.Builder().setUri(sourceUri)
        if (isImage) {
            // A still has no track of its own to decode, so media3 asks the
            // MediaItem how long to synthesize one for. Without this the image
            // asset loader reports no output track and the export dies partway
            // with "The asset loader has no audio or video track to output" —
            // reported only as a generic "Asset loader error" (this is the one
            // that survived three earlier fixes on the emulator). The
            // EditedMediaItem's own `setDurationUs` below is NOT a substitute;
            // both are required, and `setFrameRate` tells it how many frames
            // to emit across that span.
            mediaItemBuilder.setImageDurationMs(us(clip.durationTicks) / 1_000)
        } else {
            mediaItemBuilder.setClippingConfiguration(
                MediaItem.ClippingConfiguration.Builder()
                    .setStartPositionUs(us(clip.sourceStartTicks))
                    .setEndPositionUs(us(clip.sourceEndTicks))
                    .build(),
            )
        }

        val videoEffects = mutableListOf<Effect>()
        val itemStartUs = us(itemStartTicks)
        val animated = KeyframeEvaluator.hasVisualAnimations(clip)
        if (animated || !EdlTransformEffect.isIdentity(clip.transform)) {
            videoEffects.add(EdlTransformEffect(clip, canvasWidth, canvasHeight, itemStartUs, ticksPerSecond))
        }
        if (applyOpacity) {
            if (KeyframeEvaluator.hasOpacityAnimation(clip)) {
                // Round 47: per-frame opacity over the black base — see the class doc.
                videoEffects.add(AnimatedOpacityRgbMatrix(clip, itemStartUs, ticksPerSecond))
            } else if (clip.opacity != 1.0) {
                videoEffects.add(AlphaScale(clip.opacity.toFloat()))
            }
        }
        if (colorGradeMatrix != null) {
            videoEffects.add(ColorGradeMatrixEffect(colorGradeMatrix))
        }

        // Normalize every visual item to the export resolution HERE, per
        // item, not only through the composition-level Presentation: media3
        // pulls a trailing composition Presentation out of the effect chain to
        // size the encoder, so it runs AFTER the composition's OverlayEffect.
        // That left the preview-rendered overlays compositing onto
        // proxy-sized frames and coming out magnified and edge-cropped in the
        // exported file, while being pixel-correct in the preview. With this,
        // frames reaching the overlay stage are already at output size and the
        // overlay is a true 1:1 blit.
        if (!removeVideo && outputWidth > 0 && outputHeight > 0) {
            videoEffects.add(
                Presentation.createForWidthAndHeight(
                    outputWidth,
                    outputHeight,
                    Presentation.LAYOUT_SCALE_TO_FIT,
                ),
            )
        }

        val effectiveRemoveAudio = removeAudio || !asset.hasAudio
        if (effectiveRemoveAudio && removeVideo) {
            // Never hand Media3 the impossible "remove both tracks" shape.
            // Callers that want an audio-only lane must first exclude assets
            // with hasAudio=false (see audibleClips above). Keep this guard so
            // any future regression fails with a Cutlyra diagnostic instead
            // of Media3's IllegalStateException.
            throw ExportUnsupportedException(
                "clip ${clip.clipId} (${asset.name}) has no audio stream and cannot be used in an audio-only export sequence",
            )
        }

        val builder = EditedMediaItem.Builder(mediaItemBuilder.build())
            .setRemoveAudio(effectiveRemoveAudio)
            .setRemoveVideo(removeVideo)
            // Per-clip volume. Parsed since M9 but never applied on Android —
            // the slider was a no-op in every Android export until now.
            .setEffects(
                Effects(
                    if (removeAudio) {
                        emptyList()
                    } else {
                        listOf(ClipGainAudioProcessor(clip.volumeDb))
                    },
                    videoEffects,
                ),
            )

        if (isImage) {
            builder.setDurationUs(us(clip.durationTicks))
        }
        // Output frame-rate contract (GitHub #21 / Linear PAV-71). Declare
        // `setFrameRate` for EVERY visual item, not only stills:
        //
        //  - IMAGE: media3 synthesizes the still's frames at exactly this rate
        //    (ImageAssetLoader rejects RATE_UNSET with `checkState`), and the
        //    frame count across the clip's duration is derived from it. Same
        //    as before — but no longer the only caller.
        //  - VIDEO: media3 1.11.0 treats this as a MAXIMUM. Verified in its
        //    source at tag 1.11.0 (`SequenceRenderersFactory.TargetFrameRate-
        //    Helper`): decoder OUTPUT frames are dropped down to
        //    `1_000_000 / frameRate` on every API level we support (the SDK 34
        //    gate there covers only the decoder-INPUT pre-drop optimization,
        //    not the output drop), so a 60 fps source exported at 24 genuinely
        //    emits ~24 fps timestamps. The same helper's own comment states
        //    the other half verbatim: "This algorithm has no impact if the
        //    target frame rate is greater [than] input frame rate" — media3
        //    1.11.0 has no frame-DUPLICATION primitive, so 60 selected over
        //    30 fps footage stays 30 fps. That direction is an honest
        //    capability limit, disclosed in the export sheet BEFORE the
        //    export runs (the issue's "warn accurately before export and use
        //    an explicit supported fallback (not silent 30 FPS)"), not
        //    something this call can provide.
        //
        //  Leaving video items at RATE_UNSET was the PAV-71 defect: the sheet
        //  and EDL said 24/60 while media3 emitted the source cadence
        //  untouched. Audio-only items (removeVideo) have no video stream —
        //  the rate is meaningless there and intentionally not declared.
        if (!removeVideo) {
            builder.setFrameRate(frameRate)
        }
        if (clip.speed.numerator != clip.speed.denominator) {
            builder.setSpeed(
                SpeedParameters(ConstantSpeedProvider(clip.speed.toDouble().toFloat()), clip.maintainPitch),
            )
        }
        return builder.build()
    }
}
