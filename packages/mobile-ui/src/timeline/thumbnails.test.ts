/**
 * GitHub #54 — source→clip filmstrip mapping and nearest-slot lookup.
 *
 * These are the two functions that replace the brittle exact-float
 * dictionary match issue #54 rejected: native strips carry SOURCE-relative
 * timestamps at fixed spacing, the renderer asks for arbitrary
 * zoom-dependent clip-relative slot times, and the two must meet by
 * mapping + nearest lookup instead of key equality.
 */
import { describe, expect, test } from "bun:test";
import { mapSourceStripToClip, nearestThumbnailUri } from "./thumbnails";

/** Convenience: frames every `step` seconds from 0..`endSec` inclusive. */
function strip({
	endSec,
	step = 1,
}: {
	endSec: number;
	step?: number;
}): { timeSec: number; uri: string }[] {
	const frames: { timeSec: number; uri: string }[] = [];
	for (let t = 0; t <= endSec + 1e-9; t += step) {
		frames.push({ timeSec: t, uri: `frame-${t.toFixed(3)}` });
	}
	return frames;
}

describe("mapSourceStripToClip", () => {
	test("an untrimmed clip maps frames 1:1 (clip time == source time)", () => {
		const mapped = mapSourceStripToClip({
			frames: strip({ endSec: 4 }),
			trimStartSec: 0,
			durationSec: 4,
			rate: undefined,
		});
		expect(mapped).toEqual([
			{ timeSec: 0, uri: "frame-0.000" },
			{ timeSec: 1, uri: "frame-1.000" },
			{ timeSec: 2, uri: "frame-2.000" },
			{ timeSec: 3, uri: "frame-3.000" },
			{ timeSec: 4, uri: "frame-4.000" },
		]);
	});

	test("frames before the trim start are dropped — trimmed-away footage never renders", () => {
		const mapped = mapSourceStripToClip({
			frames: strip({ endSec: 10 }),
			trimStartSec: 5.5,
			durationSec: 4,
			rate: 1,
		});
		// Source window [5.5, 9.5]: frame 5 is cut, frames 6..9 render at
		// clip-relative 0.5..3.5, frame 10 is past the clip's end.
		expect(mapped?.map((f) => f.timeSec)).toEqual([0.5, 1.5, 2.5, 3.5]);
		expect(mapped?.every((f) => !f.uri.startsWith("frame-5."))).toBe(true);
	});

	test("speed (rate 2) windows DOUBLE the source span and halve clip times", () => {
		const mapped = mapSourceStripToClip({
			frames: strip({ endSec: 12 }),
			trimStartSec: 1,
			durationSec: 5,
			rate: 2,
		});
		// Source window [1, 1 + 5·2] = [1, 11]; clipSec = (src − 1) / 2.
		expect(mapped?.[0]).toEqual({ timeSec: 0, uri: "frame-1.000" });
		expect(mapped?.[mapped.length - 1]).toEqual({
			timeSec: 5,
			uri: "frame-11.000",
		});
		// Source frames 1..11 all land in [0, 5] after the ÷2 retime.
	});

	test("rate 0 or negative is treated as 1 — no division by zero (reverse is future work)", () => {
		for (const rate of [0, -2]) {
			const mapped = mapSourceStripToClip({
				frames: strip({ endSec: 4 }),
				trimStartSec: 1,
				durationSec: 3,
				rate,
			});
			expect(mapped?.map((f) => f.timeSec)).toEqual([0, 1, 2, 3]);
		}
	});

	test("a split sliver narrower than the strip spacing keeps the nearest frame instead of a gradient", () => {
		// 60s source with 1s frames, clip = a 0.3s slice at 30.1s: zero
		// frames fall inside [30.1, 30.4], yet real footage exists.
		const mapped = mapSourceStripToClip({
			frames: strip({ endSec: 60 }),
			trimStartSec: 30.1,
			durationSec: 0.3,
			rate: 1,
		});
		expect(mapped).toHaveLength(1);
		// Nearest source frame to the window centre (30.25s) is 30s; its
		// mapped clip time may sit outside [0, duration] — the nearest
		// lookup clamps by proximity, which is the documented contract.
		expect(mapped?.[0]?.uri).toBe("frame-30.000");
		expect(mapped?.[0]?.timeSec).toBeCloseTo(-0.1, 6);
	});

	test("an empty strip maps to undefined (upstream shows the placeholder)", () => {
		expect(
			mapSourceStripToClip({
				frames: [],
				trimStartSec: 0,
				durationSec: 5,
				rate: 1,
			}),
		).toBeUndefined();
	});

	test("output is sorted ascending even when the input strip is not", () => {
		const shuffled = [
			strip({ endSec: 4 })[2],
			strip({ endSec: 4 })[0],
			strip({ endSec: 4 })[4],
			strip({ endSec: 4 })[1],
		];
		const mapped = mapSourceStripToClip({
			frames: shuffled,
			trimStartSec: 0,
			durationSec: 4,
			rate: 1,
		});
		expect(mapped?.map((f) => f.timeSec)).toEqual([0, 1, 2, 4]);
	});
});

describe("nearestThumbnailUri", () => {
	const frames = [
		{ timeSec: 0, uri: "a" },
		{ timeSec: 2, uri: "b" },
		{ timeSec: 4, uri: "c" },
	];

	test("no frames → undefined (the ONE case that renders the placeholder)", () => {
		expect(nearestThumbnailUri({ frames: undefined, slotSec: 0 })).toBeUndefined();
		expect(nearestThumbnailUri({ frames: [], slotSec: 1.5 })).toBeUndefined();
	});

	test("exact key match still works", () => {
		expect(nearestThumbnailUri({ frames, slotSec: 2 })).toBe("b");
	});

	test("a slot between frames picks the closer one — never exact equality", () => {
		expect(nearestThumbnailUri({ frames, slotSec: 0.9 })).toBe("a"); // 0.9 from a, 1.1 from b
		expect(nearestThumbnailUri({ frames, slotSec: 1.2 })).toBe("b"); // 0.8 from b, 1.2 from a
		expect(nearestThumbnailUri({ frames, slotSec: 3.4 })).toBe("c"); // 0.6 from c, 1.4 from b
	});

	test("slots beyond either end clamp to the first/last frame", () => {
		expect(nearestThumbnailUri({ frames, slotSec: -5 })).toBe("a");
		expect(nearestThumbnailUri({ frames, slotSec: 99 })).toBe("c");
	});

	test("a single-frame strip answers every slot (sliver/image clips)", () => {
		const single = [{ timeSec: -0.1, uri: "only" }];
		expect(nearestThumbnailUri({ frames: single, slotSec: 0 })).toBe("only");
		expect(nearestThumbnailUri({ frames: single, slotSec: 12.5 })).toBe("only");
	});

	test("exact ties resolve deterministically to the earlier frame", () => {
		expect(nearestThumbnailUri({ frames, slotSec: 1 })).toBe("a"); // equidistant a/b
	});
});