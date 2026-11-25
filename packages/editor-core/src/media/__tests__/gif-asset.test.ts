import { describe, expect, it } from "bun:test";

import {
	gifFrameTimeline,
	gifLoopDurationMs,
	gifMetadataFromDecode,
	gifPlaybackDurationSeconds,
	selectGifFrameIndex,
	type GifAssetMetadata,
} from "@/media/gif-asset";

const metadata = ({
	delays = [100, 100, 100],
	loopCount = 0,
}: {
	delays?: number[];
	loopCount?: number;
} = {}): GifAssetMetadata => ({
	width: 64,
	height: 32,
	loopCount,
	frameDelaysMs: delays,
});

describe("gifMetadataFromDecode", () => {
	it("keeps dimensions, loop count and normalized delays", () => {
		const decoded = {
			width: 64,
			height: 32,
			loopCount: 2,
			frames: [
				{ delayMs: 100 },
				{ delayMs: 5 },
				{ delayMs: 0 },
			],
		} as unknown as Parameters<typeof gifMetadataFromDecode>[0];

		const gif = gifMetadataFromDecode(decoded);

		expect(gif.width).toBe(64);
		expect(gif.height).toBe(32);
		expect(gif.loopCount).toBe(2);
		expect(gif.frameDelaysMs).toEqual([100, 100, 100]);
	});

	it("clamps negative loop counts to zero", () => {
		const decoded = {
			width: 1,
			height: 1,
			loopCount: -3,
			frames: [{ delayMs: 100 }],
		} as unknown as Parameters<typeof gifMetadataFromDecode>[0];
		expect(gifMetadataFromDecode(decoded).loopCount).toBe(0);
	});
});

describe("gifLoopDurationMs", () => {
	it("sums normalized frame delays", () => {
		expect(gifLoopDurationMs(metadata({ delays: [100, 200, 50] }))).toBe(350);
	});

	it("is zero for an empty frame list", () => {
		expect(gifLoopDurationMs(metadata({ delays: [] }))).toBe(0);
	});
});

describe("gifPlaybackDurationSeconds", () => {
	it("uses one loop for an endlessly looping GIF", () => {
		expect(
			gifPlaybackDurationSeconds(
				metadata({ delays: [100, 100, 100], loopCount: 0 }),
			),
		).toBeCloseTo(0.3);
	});

	it("uses every loop for a finite GIF", () => {
		expect(
			gifPlaybackDurationSeconds(
				metadata({ delays: [100, 100, 100], loopCount: 3 }),
			),
		).toBeCloseTo(0.9);
	});
});

describe("selectGifFrameIndex", () => {
	it("selects by elapsed time within a loop", () => {
		const gif = metadata({ delays: [100, 100, 100] });
		expect(selectGifFrameIndex({ metadata: gif, localTimeSec: 0 })).toBe(0);
		expect(selectGifFrameIndex({ metadata: gif, localTimeSec: 0.15 })).toBe(1);
		expect(selectGifFrameIndex({ metadata: gif, localTimeSec: 0.25 })).toBe(2);
	});

	it("includes the clip's trim start so trimming advances the animation", () => {
		const gif = metadata({ delays: [100, 100, 100] });
		expect(
			selectGifFrameIndex({
				metadata: gif,
				localTimeSec: 0,
				trimStartSec: 0.15,
			}),
		).toBe(1);
	});

	it("wraps around while an infinite GIF plays", () => {
		const gif = metadata({ delays: [100, 100, 100] });
		expect(selectGifFrameIndex({ metadata: gif, localTimeSec: 0.35 })).toBe(0);
		expect(selectGifFrameIndex({ metadata: gif, localTimeSec: 0.45 })).toBe(1);
	});

	it("holds the last frame after a finite GIF finishes", () => {
		const gif = metadata({ delays: [100, 100], loopCount: 2 });
		expect(selectGifFrameIndex({ metadata: gif, localTimeSec: 0.3 })).toBe(1);
		expect(selectGifFrameIndex({ metadata: gif, localTimeSec: 0.4 })).toBe(1);
		expect(selectGifFrameIndex({ metadata: gif, localTimeSec: 5 })).toBe(1);
	});

	it("returns 0 for an empty frame list and clamps negative time", () => {
		expect(
			selectGifFrameIndex({
				metadata: metadata({ delays: [] }),
				localTimeSec: 1,
			}),
		).toBe(0);
		expect(
			selectGifFrameIndex({ metadata: metadata(), localTimeSec: -1 }),
		).toBe(0);
	});
});

describe("gifFrameTimeline", () => {
	it("builds cumulative start times", () => {
		const frames = gifFrameTimeline(metadata({ delays: [100, 50] }));
		expect(frames).toEqual([
			{ delayMs: 100, startMs: 0 },
			{ delayMs: 50, startMs: 100 },
		]);
	});
});
