import { describe, expect, it } from "bun:test";
import type { ImageElement, VideoElement } from "@/timeline";
import { TICKS_PER_SECOND, mediaTime } from "@/wasm";
import {
	buildReversedElementPatch,
	reverseSourceRange,
	reversedAssetName,
} from "@/media/reverse";

function seconds(value: number) {
	return mediaTime({ ticks: Math.round(value * TICKS_PER_SECOND) });
}

function video({
	trimStartSec = 0,
	durationSec = 2,
	rate,
}: {
	trimStartSec?: number;
	durationSec?: number;
	rate?: number;
} = {}): VideoElement {
	const element: VideoElement = {
		id: "clip-video",
		type: "video",
		name: "clip.mp4",
		mediaId: "asset-source",
		startTime: seconds(0),
		duration: seconds(durationSec),
		trimStart: seconds(trimStartSec),
		trimEnd: seconds(0),
		params: { "transform.rotate": 90, framing: "fill" },
		animations: undefined,
	};
	if (rate !== undefined) element.retime = { rate, maintainPitch: false };
	return element;
}

const image: ImageElement = {
	id: "clip-image",
	type: "image",
	name: "still.png",
	mediaId: "asset-still",
	startTime: seconds(0),
	duration: seconds(1),
	trimStart: seconds(0),
	trimEnd: seconds(0),
	params: {},
	animations: undefined,
};

describe("reverseSourceRange", () => {
	it("covers an untrimmed clip from zero", () => {
		const range = reverseSourceRange({ element: video({ durationSec: 3 }) });
		expect(range).toEqual({
			ok: true,
			startMicros: 0,
			endMicros: 3_000_000,
			durationMicros: 3_000_000,
		});
	});

	it("starts at the trimmed-away head and keeps the clip length", () => {
		const range = reverseSourceRange({
			element: video({ trimStartSec: 2, durationSec: 1.5 }),
		});
		expect(range).toEqual({
			ok: true,
			startMicros: 2_000_000,
			endMicros: 3_500_000,
			durationMicros: 1_500_000,
		});
	});

	it("converts the clip duration through the retime rate", () => {
		// 1s of 2x playback consumes 2s of source; reversing must cover both.
		const range = reverseSourceRange({
			element: video({ trimStartSec: 1, durationSec: 1, rate: 2 }),
		});
		expect(range).toEqual({
			ok: true,
			startMicros: 1_000_000,
			endMicros: 3_000_000,
			durationMicros: 2_000_000,
		});
	});

	it("refuses a still and a zero-length range", () => {
		expect(reverseSourceRange({ element: image })).toEqual({
			ok: false,
			reason: "not-video",
		});
		expect(
			reverseSourceRange({
				element: { ...video(), duration: seconds(0) },
			}),
		).toEqual({ ok: false, reason: "empty-range" });
	});
});

describe("buildReversedElementPatch", () => {
	it("retargets the media at source zero and keeps the edit", () => {
		const element = video({ trimStartSec: 2, durationSec: 1.5 });
		const patch = buildReversedElementPatch({ element, mediaId: "reversed-1" });
		expect(patch?.mediaId).toBe("reversed-1");
		expect(patch?.trimStart as number).toBe(0);
		expect(patch?.trimEnd as number).toBe(0);
		// Duration and every visual param survive, so framing/rotation/crop
		// keep applying on top of the reversed frames.
		expect(patch).not.toHaveProperty("duration");
		expect(patch?.params).toEqual({
			"transform.rotate": 90,
			framing: "fill",
			reversed: false,
		});
	});

	it("refuses a non-video element or a blank media id", () => {
		expect(buildReversedElementPatch({ element: image, mediaId: "x" })).toBeNull();
		expect(buildReversedElementPatch({ element: video(), mediaId: "" })).toBeNull();
	});
});

describe("reversedAssetName", () => {
	it("names the generated asset after its source range", () => {
		expect(reversedAssetName({ startMicros: 2_000_000, endMicros: 3_500_000 })).toBe(
			"reversed-2000-3500ms.mp4",
		);
	});
});
