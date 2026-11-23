/**
 * Cutlyra GIF support helpers.
 *
 * The actual byte-level decode uses the WebCodecs `ImageDecoder` API where the
 * host (Android System WebView) exposes it, with a documented fallback path
 * for hosts that do not. These helpers are the platform-agnostic, testable
 * core: frame-delay normalization, timeline construction, seeking and loop
 * handling. They deliberately do NOT touch the DOM/canvas/decoder so they run
 * under `bun test`.
 */

export interface GifFrameTiming {
	/** Raw delay reported by the GIF (centiseconds converted to ms). */
	rawDelayMs: number;
	/** Normalized delay used for playback (never zero/invalid). */
	delayMs: number;
}

export interface GifFrame {
	/** Normalized delay in ms (>= MIN_FRAME_DELAY_MS). */
	delayMs: number;
	/** Cumulative start time of this frame within one loop, in ms. */
	startMs: number;
}

export const MIN_GIF_FRAME_DELAY_MS = 20;
export const DEFAULT_GIF_FRAME_DELAY_MS = 100;

/**
 * Normalize a GIF frame delay.
 *
 * GIF stores delays in centiseconds; a value of 0 (or any value below the
 * spec's effective minimum) is treated by browsers as 100 ms. Very short
 * delays (< 20 ms) are clamped up to avoid pathological 1000 fps playback.
 * Non-finite / negative values fall back to the default.
 */
export function normalizeGifFrameDelay(delayMs: number): number {
	if (!Number.isFinite(delayMs) || delayMs < 0) {
		return DEFAULT_GIF_FRAME_DELAY_MS;
	}
	if (delayMs <= 10) {
		return DEFAULT_GIF_FRAME_DELAY_MS;
	}
	if (delayMs < MIN_GIF_FRAME_DELAY_MS) {
		return MIN_GIF_FRAME_DELAY_MS;
	}
	return Math.round(delayMs);
}

/**
 * Build a normalized frame list with cumulative start times for one loop.
 * Returns the total loop duration in ms alongside the frames.
 */
export function buildGifFrameTimeline(
	rawDelaysMs: number[],
): { frames: GifFrame[]; totalDurationMs: number } {
	const frames: GifFrame[] = [];
	let cursor = 0;
	for (const raw of rawDelaysMs) {
		const delayMs = normalizeGifFrameDelay(raw);
		frames.push({ delayMs, startMs: cursor });
		cursor += delayMs;
	}
	if (frames.length === 0) {
		return { frames, totalDurationMs: 0 };
	}
	// A zero-total (all clamped?) guard: ensure at least one frame's delay.
	if (cursor <= 0) {
		frames[0].delayMs = DEFAULT_GIF_FRAME_DELAY_MS;
		frames[0].startMs = 0;
		return { frames, totalDurationMs: DEFAULT_GIF_FRAME_DELAY_MS };
	}
	return { frames, totalDurationMs: cursor };
}

/**
 * Resolve which frame index is active at `timeMs` within a single loop.
 * `timeMs` is clamped into [0, totalDuration). Returns 0 for empty input.
 */
export function getGifFrameIndexAtTime({
	timeMs,
	frameDurationsMs,
}: {
	timeMs: number;
	frameDurationsMs: number[];
}): number {
	if (frameDurationsMs.length === 0) return 0;
	const total = frameDurationsMs.reduce((a, b) => a + normalizeGifFrameDelay(b), 0);
	if (total <= 0) return 0;
	let t = ((timeMs % total) + total) % total;
	for (let i = 0; i < frameDurationsMs.length; i++) {
		const d = normalizeGifFrameDelay(frameDurationsMs[i]);
		if (t < d) return i;
		t -= d;
	}
	return frameDurationsMs.length - 1;
}

/**
 * Runtime capability check for WebCodecs ImageDecoder GIF support.
 * Safe to call in any environment (returns false when unavailable).
 */
export function supportsImageDecoder(): boolean {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const g = globalThis as unknown as {
		ImageDecoder?: { isTypeSupported?: (t: string) => boolean };
	};
	if (typeof g.ImageDecoder === "undefined") return false;
	try {
		return g.ImageDecoder.isTypeSupported?.("image/gif") === true;
	} catch {
		return false;
	}
}

/**
 * Returns a human-readable decode strategy label for diagnostics.
 */
export function gifDecodeStrategy(): "image-decoder" | "fallback" {
	return supportsImageDecoder() ? "image-decoder" : "fallback";
}

export const GIF_MIME_TYPE = "image/gif";
export const GIF_EXTENSIONS = [".gif"] as const;

export function isGifFileName(name: string): boolean {
	return /\.gif$/i.test(name);
}

export function isGifMimeType(mime: string): boolean {
	return mime.toLowerCase() === GIF_MIME_TYPE;
}