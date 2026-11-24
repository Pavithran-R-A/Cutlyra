/**
 * Animated-GIF asset metadata and frame selection.
 *
 * Persisted on `MediaAssetData.gif` so a GIF clip survives save/reopen without
 * storing decoded pixels: the frames are re-decoded from the asset `file` on
 * demand (`gif-frames.ts`). These helpers are platform-agnostic (no DOM,
 * decoder or canvas) and run under `bun test`.
 */

import {
	getGifFrameIndexAtTime,
	normalizeGifFrameDelay,
	type GifFrame,
} from "./gif";
import type { GifDecodeResult } from "./gif-decoder";

export interface GifAssetMetadata {
	/** Logical-screen width from the GIF header. */
	width: number;
	/** Logical-screen height from the GIF header. */
	height: number;
	/** Netscape loop count: 0 = forever, N = play N times. */
	loopCount: number;
	/** Per-frame delays in milliseconds, already normalized. */
	frameDelaysMs: number[];
}

/** Builds the persisted metadata from a decoded GIF. */
export function gifMetadataFromDecode(
	result: Pick<GifDecodeResult, "width" | "height" | "loopCount" | "frames">,
): GifAssetMetadata {
	return {
		width: result.width,
		height: result.height,
		loopCount: Math.max(0, Math.floor(result.loopCount)),
		frameDelaysMs: result.frames.map((frame) =>
			normalizeGifFrameDelay(frame.delayMs),
		),
	};
}

/** One loop's duration in milliseconds. */
export function gifLoopDurationMs(metadata: GifAssetMetadata): number {
	return metadata.frameDelaysMs.reduce(
		(total, delay) => total + normalizeGifFrameDelay(delay),
		0,
	);
}

/**
 * How long the GIF clip plays by default: one loop for an endlessly looping
 * GIF, every loop for a finite one. Used as the media asset's duration so an
 * inserted GIF clip already has a sensible length.
 */
export function gifPlaybackDurationSeconds(metadata: GifAssetMetadata): number {
	const loops = metadata.loopCount === 0 ? 1 : metadata.loopCount;
	return (gifLoopDurationMs(metadata) * loops) / 1000;
}

/**
 * Frame index to display at a clip-local time.
 *
 * `localTimeSec` is seconds since the clip's start; `trimStartSec` is the
 * clip's source-relative trim start (so trimming a GIF advances its animation
 * rather than restarting it). A finite-loop GIF holds its last frame once all
 * its loops have elapsed, matching browser playback.
 */
export function selectGifFrameIndex({
	metadata,
	localTimeSec,
	trimStartSec = 0,
}: {
	metadata: GifAssetMetadata;
	localTimeSec: number;
	trimStartSec?: number;
}): number {
	const frameDurationsMs = metadata.frameDelaysMs;
	if (frameDurationsMs.length === 0) return 0;

	const totalMs = gifLoopDurationMs(metadata);
	const elapsedMs = Math.max(0, (trimStartSec + localTimeSec) * 1000);

	if (metadata.loopCount > 0 && elapsedMs >= totalMs * metadata.loopCount) {
		return frameDurationsMs.length - 1;
	}

	return getGifFrameIndexAtTime({
		timeMs: elapsedMs,
		frameDurationsMs,
	});
}

/**
 * Timeline (one loop) mapping for callers that already have the normalized
 * frame timeline. Kept here so import/render code shares one definition.
 */
export function gifFrameTimeline(metadata: GifAssetMetadata): GifFrame[] {
	const frames: GifFrame[] = [];
	let cursor = 0;
	for (const raw of metadata.frameDelaysMs) {
		const delayMs = normalizeGifFrameDelay(raw);
		frames.push({ delayMs, startMs: cursor });
		cursor += delayMs;
	}
	return frames;
}
