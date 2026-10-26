/**
 * GitHub #40 / Linear PAV-104 — consumer-facing export failure messages.
 *
 * Stage 12 (POCO M4 Pro 5G): a 4K export fails cleanly on the device's
 * hardware encoder, but `Media3Exporter`'s `diagnosticMessage()` walks the
 * exception chain and hands the FIRST message to the UI — which for a
 * MediaCodec failure is the raw diagnostic
 * `Codec exception ... c2.mtk.avc.encoder, width=3840, height=2160,
 * bitrate=34836480`. Internal codec identifiers are developer signal, not
 * customer copy (issue #40's acceptance: detailed codec diagnostics belong
 * in developer logs — Kotlin's `cutlyra-export` tag already logs the full
 * errorCode/message/cause chain at `Transformer.Listener.onError` — not in
 * the export sheet's error dialog).
 *
 * This module is the single conversion point: a raw native failure string
 * plus the USER'S chosen export resolution (the sheet's own
 * `edl.output.resolution`, never inferred from the failure) becomes an
 * accurate, actionable sentence — WITHOUT silently changing what was asked
 * for (never downgrade: the export still fails; the user chooses the
 * alternative). Anything that is not a codec/encoder failure passes through
 * untouched, so real I/O and user-fixable errors keep their detail. When a
 * codec failure IS replaced, the raw diagnostic is still surfaced to
 * developer logs via `console.warn` for support/debugging.
 *
 * Pure and dependency-free (plain strings/numbers) so it unit-tests under
 * `bun test` — the repo's test runtime has no DOM and no native shell (see
 * export-frame-rate.ts next door for the same pattern).
 */

/** The user's chosen output size, from the export sheet's own EDL build. */
export interface ExportResolution {
	width: number;
	height: number;
}

/**
 * Strong codec signatures: a raw diagnostic containing these is a
 * codec/encoder failure on its face (Android `MediaCodec.CodecException`
 * text, codec component names, Apple's framework names).
 */
const STRONG_CODEC_SIGNATURE =
	/codec\s*exception|mediacodec|omx\.[a-z0-9._-]+|c2\.[a-z0-9._-]+|avfoundation|videotoolbox/i;

/**
 * Weaker terms (bare "encoder", "video codec") — only classified together
 * with an explicit failure word, so unrelated messages that merely mention
 * encoding pass through.
 */
const WEAK_CODEC_TERM = /encoder|video codec|encode the video/i;
const FAILURE_WORD = /exception|error|fail|unsupported|not supported|cannot|can't|unable|rejected|no encoder|refused/i;

/** `width=3840, height=2160` (MediaCodec) — a size stated INSIDE the
 *  diagnostic, used only when the caller had no resolution context. */
const DIAGNOSTIC_DIMENSIONS = /width\s*=\s*(\d{2,5})[^0-9]+height\s*=\s*(\d{2,5})/i;
/** Plain `3840x2160` in a diagnostic. */
const PLAIN_DIMENSIONS = /\b(\d{2,5})\s*[x×]\s*(\d{2,5})\b/;

function isCodecFailure(text: string): boolean {
	if (STRONG_CODEC_SIGNATURE.test(text)) return true;
	return WEAK_CODEC_TERM.test(text) && FAILURE_WORD.test(text);
}

function dimensionsFromDiagnostic(text: string): ExportResolution | null {
	const structured = DIAGNOSTIC_DIMENSIONS.exec(text);
	if (structured) {
		return { width: Number(structured[1]), height: Number(structured[2]) };
	}
	const plain = PLAIN_DIMENSIONS.exec(text);
	if (plain) {
		return { width: Number(plain[1]), height: Number(plain[2]) };
	}
	return null;
}

/** The actionable alternative for a given chosen size — never a silent
 *  downgrade, always a sentence the user can act on. */
export function codecFailureMessage({
	resolution,
}: {
	resolution: ExportResolution | null;
}): string {
	if (resolution && (resolution.height >= 2160 || resolution.width >= 3840)) {
		return "4K export isn't supported on this device with these settings. Try 1080p.";
	}
	if (resolution && (resolution.width >= 1920 || resolution.height >= 1080)) {
		return `${resolution.width}×${resolution.height} export isn't supported on this device with these settings. Try 720p.`;
	}
	if (resolution) {
		return `${resolution.width}×${resolution.height} export isn't supported on this device with these settings. Try a different resolution or frame rate.`;
	}
	// No size known at all — offer the most likely alternative.
	return "Video encoding isn't supported on this device with these settings. Try 1080p.";
}

/**
 * The export sheet's error copy. `resolution` is the USER'S chosen output
 * size (pass `edl.output.resolution`); it takes precedence over any size
 * parsed out of the raw diagnostic, because the encoder may report a padded
 * or clamped geometry that the user never selected.
 *
 * Single destructured-object parameter (repo-wide `opencut/prefer-object-
 * params` gate — the previous inline `exportErrorMessage(value)` in the
 * sheet had one parameter, and the second context argument would have
 * violated it).
 */
export function exportErrorMessage({
	value,
	resolution,
}: {
	value: unknown;
	resolution?: ExportResolution;
}): string {
	const raw =
		typeof value === "string" && value.trim().length > 0
			? value.trim()
			: value instanceof Error && value.message.trim().length > 0
				? value.message.trim()
				: "The native exporter failed without a diagnostic. Check Cutlyra logs for details.";
	if (!isCodecFailure(raw)) return raw;

	const chosen = resolution ?? dimensionsFromDiagnostic(raw);
	// Developer signal stays in logs (webview console + native cutlyra-export
	// logcat tag); the dialog gets the actionable sentence.
	console.warn("[export] codec failure diagnostic (developer detail):", raw);
	return codecFailureMessage({ resolution: chosen });
}
