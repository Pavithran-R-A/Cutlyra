package app.cutlyra.editor.export

import android.content.Context
import android.media.MediaCodecInfo
import android.os.Handler
import android.os.Looper
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EncoderSelector
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import app.cutlyra.editor.edl.Edl
import app.cutlyra.editor.media.MediaProbe
import java.io.File

/**
 * EDL -> hardware-encoded MP4 (plan M9 "Both" items 5-7): progress +
 * cancellation, a defensive hardware->software retry on `ExportException`
 * (`08` §8's documented device-specific `ExportException`/MediaCodec
 * failures, `androidx/media#1504`/`#2751`), and an output-integrity
 * re-probe before declaring success. Structurally mirrors M4's
 * `ProxyTranscoder` (same main-`Looper` requirement — see that file's doc
 * comment — same sealed-`Event`-callback shape) but drives a multi-sequence
 * `Composition` (`EdlToComposition`) through `Transformer.start(Composition,
 * String)` instead of a single-item transcode.
 *
 * Single-export-at-a-time by design (matches `packages/native-bridge/src/
 * types.ts`'s `ExportProgress`, which — unlike `ProxyProgress` — carries no
 * id to disambiguate concurrent exports): `activeTransformer`/
 * `activeMainHandler` are object-level state, not per-call. A second
 * `start()` while one is already running throws rather than silently
 * clobbering the first.
 */
object Media3Exporter {
    private const val PROGRESS_POLL_INTERVAL_MS = 250L

    private fun diagnosticMessage(error: Throwable, fallback: String): String {
        var current: Throwable? = error
        while (current != null) {
            val message = current.message?.trim()
            if (!message.isNullOrEmpty()) return message
            current = current.cause
        }
        return "$fallback (${error.javaClass.simpleName})"
    }

    /** Software-codec name prefixes on Android's `MediaCodecList` — the
     * standard signature (no dedicated `isSoftwareOnly()` API existed before
     * API 29's `MediaCodecInfo.isSoftwareOnly()`, which IS available at our
     * `minSdk` 29 floor and is what `SoftwareOnlyEncoderSelector` actually
     * uses below; the name-prefix comment is kept only as a human-readable
     * cross-check). */
    private class SoftwareOnlyEncoderSelector : EncoderSelector {
        override fun selectEncoderInfos(mimeType: String): com.google.common.collect.ImmutableList<MediaCodecInfo> {
            val all = EncoderSelector.DEFAULT.selectEncoderInfos(mimeType)
            val softwareOnly = all.filter { it.isSoftwareOnly }
            return com.google.common.collect.ImmutableList.copyOf(
                softwareOnly.ifEmpty { all }, // no software encoder for this mime: fall back to the default list
            )
        }
    }

    sealed interface Event {
        data class Progress(val fraction: Float) : Event
        data class Done(val outputFile: File, val durationMs: Long, val fileSizeBytes: Long) : Event
        data class Error(val message: String) : Event
    }

    private var activeTransformer: Transformer? = null
    private var activeMainHandler: Handler? = null

    fun start(
        context: Context,
        edl: Edl,
        outputFile: File,
        /** Preview-rendered text/caption images (round 37) — see
         *  `PrerenderedOverlay`. Empty ⇒ the native Spannable fallback. */
        overlayFrames: List<PrerenderedOverlay.Frame> = emptyList(),
        onEvent: (Event) -> Unit,
    ) {
        val mainHandler = Handler(Looper.getMainLooper())
        mainHandler.post {
            if (activeTransformer != null) {
                onEvent(Event.Error("an export is already in progress"))
                return@post
            }
            try {
                val composition = EdlToComposition.buildComposition(edl, overlayFrames)
                // GitHub #40 / PAV-104: one bounded line describing exactly
                // WHAT was requested, so a codec failure's private log tells
                // the developer the size/profile/fps/bitrate that was asked
                // for — separate from whatever raw codec diagnostic the
                // exception chain carries (the sheet translates BOTH for the
                // customer; see mobile-ui editor/export-errors.ts).
                val outputParams =
                    "${edl.output.resolutionWidth}x${edl.output.resolutionHeight}" +
                        "@${edl.output.fps.numerator}/${edl.output.fps.denominator}fps" +
                        " br=${edl.output.bitrate} codec=${edl.output.videoCodec}" +
                        " container=${edl.output.container}"
                runExport(
                    context = context,
                    composition = composition,
                    outputFile = outputFile,
                    mainHandler = mainHandler,
                    useSoftwareEncoder = false,
                    outputParams = outputParams,
                    onEvent = onEvent,
                )
            } catch (e: ExportUnsupportedException) {
                onEvent(Event.Error(diagnosticMessage(e, "EDL has an unsupported construct for native export")))
            } catch (e: Exception) {
                // Stage 11 physical QA (iQOO I2221): media3 can throw a
                // message-less exception synchronously out of
                // `Transformer.start()` — surfacing only the fallback string
                // hid the real fault. Log the full stack and name the class.
                android.util.Log.e("cutlyra-export", "export failed to start", e)
                onEvent(Event.Error(diagnosticMessage(e, "export failed to start")))
            }
        }
    }

    /** Best-effort: posts to the export's own main handler if one is
     * recorded. A no-op if nothing is running — matches
     * `Transformer.cancel()`'s own "safe to call even if not exporting"
     * contract. */
    fun cancel() {
        val handler = activeMainHandler ?: return
        handler.post {
            activeTransformer?.cancel()
            activeTransformer = null
            activeMainHandler = null
        }
    }

    private fun runExport(
        context: Context,
        composition: Composition,
        outputFile: File,
        mainHandler: Handler,
        useSoftwareEncoder: Boolean,
        /** Requested output geometry/quality (GitHub #40) — logged on every
         *  failure path so the private log answers "what did we ask for?"
         *  without the customer ever seeing it. */
        outputParams: String,
        onEvent: (Event) -> Unit,
    ) {
        val encoderFactoryBuilder = DefaultEncoderFactory.Builder(context)
            // EXACT output geometry (GitHub #19 / Linear PAV-69, Stage-4
            // D-NEW-1: "1080p export is encoded as 1920×1088").
            //
            // Media3 1.11.0's DefaultEncoderFactory, WITH fallback enabled,
            // routes every video request through
            // `EncoderUtil.getSupportedResolution`, whose own doc says it
            // "will be aligned to the encoder's alignment requirement ... [and]
            // may not preserve the original aspect ratio": it rounds the
            // requested size UP to the encoder's advertised
            // VideoCapabilities alignment BEFORE configuring it. On the POCO
            // M4 Pro that turned a requested 1920×1080 into a CONFIGURED
            // 1920×1088 (Stage-4 logcat:
            // `cutlyra-export: overlay frames decoded=0 target=1920x1080`
            // followed by `[c2.mtk.avc.encoder] ... mWidth 1920 mHeight
            // 1088`), and the muxer then wrote a 1920×1088 track with
            // SAR 1:1 — DAR 30:17 on every 1080p-class export. Heights that
            // are already multiples of 16 (720p, 4K) were unaffected, which
            // is exactly the defect's observed shape.
            //
            // With fallback disabled media3 configures the encoder at the
            // EXACT requested size; H.264 encoders then signal the padded
            // coded size with SPS frame-cropping, so the container reports
            // the geometry the user asked for. The capability filtering
            // this skips is advisory only (resolution/bitrate/ bitrate-mode
            // clamps, all with sane defaults) — and if a device encoder
            // genuinely refuses the requested format, MediaCodec.configure
            // throws and this class's existing tier-2 software-encoder retry
            // takes over (software encoders accept arbitrary even sizes), so
            // genuine incompatibility degrades to a slower exact-size
            // encode, never to silently wrong geometry.
            .setEnableFallback(false)
            .setEnableFormatFallback(false)
        if (useSoftwareEncoder) {
            encoderFactoryBuilder.setVideoEncoderSelector(SoftwareOnlyEncoderSelector())
        }

        val transformer = Transformer.Builder(context)
            // Brickwall across the summed mix — see LimitingAudioMixer for why
            // this is the only reachable place to do it.
            .setAudioMixerFactory(LimitingAudioMixer.Factory())
            .setEncoderFactory(encoderFactoryBuilder.build())
            .addListener(object : Transformer.Listener {
                override fun onCompleted(finishedComposition: Composition, exportResult: ExportResult) {
                    activeTransformer = null
                    activeMainHandler = null
                    verifyOutputAndReport(outputFile, exportResult, onEvent)
                }

                override fun onError(
                    finishedComposition: Composition,
                    exportResult: ExportResult,
                    exportException: ExportException,
                ) {
                    activeTransformer = null
                    activeMainHandler = null
                    // media3's own ExportException.message is often just a
                    // category ("Asset loader error") with the real fault in
                    // the cause chain, so log both — the message alone sent us
                    // chasing three different root causes on the emulator.
                    android.util.Log.e(
                        "cutlyra-export",
                        "export failed (softwareEncoder=$useSoftwareEncoder) " +
                            "requested=$outputParams " +
                            "errorCode=${exportException.errorCode} " +
                            "message=${exportException.message} " +
                            "cause=${exportException.cause}",
                        exportException,
                    )
                    if (!useSoftwareEncoder) {
                        // Retry tier 2 (plan M9 item 3): same Composition
                        // (already includes the Presentation
                        // normalization pass from `EdlToComposition`),
                        // forced onto a software encoder rather than
                        // whatever hardware codec just failed.
                        outputFile.delete()
                        runExport(
                            context = context,
                            composition = composition,
                            outputFile = outputFile,
                            mainHandler = mainHandler,
                            useSoftwareEncoder = true,
                            outputParams = outputParams,
                            onEvent = onEvent,
                        )
                    } else {
                        outputFile.delete() // no partial file left behind — plan M9 exit criteria.
                        onEvent(Event.Error(diagnosticMessage(exportException, "export failed on both hardware and software encoders")))
                    }
                }
            })
            .build()

        activeTransformer = transformer
        activeMainHandler = mainHandler
        try {
            transformer.start(composition, outputFile.absolutePath)
        } catch (e: Exception) {
            // Stage 11 physical QA (iQOO I2221): a synchronous throw out of
            // `start()` used to leave this singleton's slots assigned forever
            // — every later export then failed with "an export is already in
            // progress" until the whole process was killed. Release them so
            // the next attempt can actually run.
            activeTransformer = null
            activeMainHandler = null
            throw e
        }
        pollProgress(transformer, mainHandler, onEvent)
    }

    /** Plan M9 item 7: "Output integrity check before declaring success...
     * silent corruption is a documented WebCodecs/Safari failure mode and
     * the same defensive posture applies here." Re-probes the file Media3
     * itself just wrote, independent of `ExportResult`'s self-reported
     * numbers, using the same `MediaProbe` M4 already uses for imports. */
    private fun verifyOutputAndReport(outputFile: File, exportResult: ExportResult, onEvent: (Event) -> Unit) {
        if (!outputFile.exists() || outputFile.length() == 0L) {
            onEvent(Event.Error("export reported success but output file is missing or empty"))
            return
        }
        try {
            // Probing doesn't need a mime hint here — MediaProbe's own
            // extractor-based fallback (see that file) handles it.
            MediaProbe.probe(outputFile, mimeTypeHint = null)
        } catch (e: Exception) {
            outputFile.delete()
            onEvent(Event.Error("export produced an unreadable/corrupt file: ${diagnosticMessage(e, "probe failed")}"))
            return
        }
        onEvent(Event.Done(outputFile, exportResult.approximateDurationMs, outputFile.length()))
    }

    private fun pollProgress(transformer: Transformer, mainHandler: Handler, onEvent: (Event) -> Unit) {
        val holder = ProgressHolder()
        val state = transformer.getProgress(holder)
        if (state == Transformer.PROGRESS_STATE_AVAILABLE) {
            onEvent(Event.Progress(holder.progress / 100f))
        }
        if (state == Transformer.PROGRESS_STATE_NOT_STARTED) {
            return // terminal; Done/Error already fired via the Listener.
        }
        mainHandler.postDelayed({ pollProgress(transformer, mainHandler, onEvent) }, PROGRESS_POLL_INTERVAL_MS)
    }
}
