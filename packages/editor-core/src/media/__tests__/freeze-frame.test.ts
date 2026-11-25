import { describe, expect, it } from "bun:test";
import type { ImageElement, VideoElement } from "@/timeline";
import type { MediaAssetData } from "@/services/storage/types";
import { TICKS_PER_SECOND, mediaTime } from "@/wasm";
import {
	FREEZE_HOLD_DEFAULT_SECONDS,
	FREEZE_HOLD_MAX_SECONDS,
	FREEZE_HOLD_MIN_SECONDS,
	FreezeFrameError,
	clampFreezeHoldSeconds,
	freezeFrameConfigFromCapture,
	freezeSourceTimestampMicros,
	persistFreezeFrame,
	type FreezeFrameStore,
} from "@/media/freeze-frame";

/** 120000 ticks per second → this helper keeps the tests in real seconds. */
function seconds(value: number) {
	return mediaTime({ ticks: Math.round(value * TICKS_PER_SECOND) });
}

function video({
	trimStartSec = 0,
	durationSec = 2,
	rate,
	startSec = 0,
}: {
	trimStartSec?: number;
	durationSec?: number;
	rate?: number;
	startSec?: number;
} = {}): VideoElement {
	const element: VideoElement = {
		id: "clip-video",
		type: "video",
		name: "clip.mp4",
		mediaId: "asset-source",
		startTime: seconds(startSec),
		duration: seconds(durationSec),
		trimStart: seconds(trimStartSec),
		trimEnd: seconds(0),
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			framing: "fit",
		},
		animations: undefined,
	};
	if (rate !== undefined) {
		element.retime = { rate, maintainPitch: false };
	}
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
	params: {
		"transform.positionX": 0,
		"transform.positionY": 0,
		"transform.scaleX": 1,
		"transform.scaleY": 1,
		framing: "fit",
	},
	animations: undefined,
};

describe("freezeSourceTimestampMicros", () => {
	it("maps timeline time to the source instant of an untrimmed clip", () => {
		const result = freezeSourceTimestampMicros({
			element: video({ durationSec: 2 }),
			timelineTime: seconds(0.5),
		});
		expect(result).toMatchObject({ ok: true, sourceMicros: 500_000 });
	});

	it("adds the trimmed-away head to the source instant", () => {
		// 0.5s into a clip that starts 1.2s into its source => 1.7s.
		const result = freezeSourceTimestampMicros({
			element: video({ trimStartSec: 1.2, durationSec: 2 }),
			timelineTime: seconds(0.5),
		});
		expect(result).toMatchObject({ ok: true, sourceMicros: 1_700_000 });
	});

	it("accounts for a 2x speed ramp (source advances twice as fast)", () => {
		// 0.5s into a 2x clip trimmed at 0.2s => 0.2 + 1.0 = 1.2s of source.
		const result = freezeSourceTimestampMicros({
			element: video({ trimStartSec: 0.2, durationSec: 2, rate: 2 }),
			timelineTime: seconds(0.5),
		});
		expect(result).toMatchObject({ ok: true, sourceMicros: 1_200_000 });
	});

	it("accounts for a 0.5x slow-motion clip", () => {
		// 0.5s into a 0.5x clip trimmed at 0.2s => 0.2 + 0.25 = 0.45s.
		const result = freezeSourceTimestampMicros({
			element: video({ trimStartSec: 0.2, durationSec: 2, rate: 0.5 }),
			timelineTime: seconds(0.5),
		});
		expect(result).toMatchObject({ ok: true, sourceMicros: 450_000 });
	});

	it("is relative to the clip's own start on the timeline", () => {
		const result = freezeSourceTimestampMicros({
			element: video({ startSec: 3, trimStartSec: 0.5 }),
			timelineTime: seconds(3.25),
		});
		expect(result).toMatchObject({ ok: true, sourceMicros: 750_000 });
	});

	it("refuses instants outside the clip instead of clamping", () => {
		const element = video({ startSec: 1, durationSec: 2 });
		expect(
			freezeSourceTimestampMicros({ element, timelineTime: seconds(1) }),
		).toEqual({ ok: false, reason: "outside-clip" });
		expect(
			freezeSourceTimestampMicros({ element, timelineTime: seconds(3) }),
		).toEqual({ ok: false, reason: "outside-clip" });
		expect(
			freezeSourceTimestampMicros({ element, timelineTime: seconds(0.5) }),
		).toEqual({ ok: false, reason: "outside-clip" });
	});

	it("refuses non-video clips (an image has no source timeline)", () => {
		expect(
			freezeSourceTimestampMicros({ element: image, timelineTime: seconds(0.5) }),
		).toEqual({ ok: false, reason: "not-video" });
	});
});

describe("freeze hold bounds", () => {
	it("clamps to the documented range", () => {
		expect(clampFreezeHoldSeconds(0)).toBe(FREEZE_HOLD_MIN_SECONDS);
		expect(clampFreezeHoldSeconds(999)).toBe(FREEZE_HOLD_MAX_SECONDS);
		expect(clampFreezeHoldSeconds(2.5)).toBe(2.5);
		expect(clampFreezeHoldSeconds(Number.NaN)).toBe(FREEZE_HOLD_DEFAULT_SECONDS);
	});
});

describe("freezeFrameConfigFromCapture", () => {
	it("records the source clip, media and instant", () => {
		const config = freezeFrameConfigFromCapture({
			element: video({ trimStartSec: 0.4 }),
			sourceTimestampMicros: 900_000,
			holdDurationMicros: 1_000_000,
			width: 1920,
			height: 1080,
			now: new Date("2026-11-25T00:00:00.000Z"),
		});
		expect(config).toEqual({
			sourceElementId: "clip-video",
			sourceMediaId: "asset-source",
			sourceTimestampMicros: 900_000,
			holdDurationMicros: 1_000_000,
			width: 1920,
			height: 1080,
			capturedAt: "2026-11-25T00:00:00.000Z",
		});
	});

	it("refuses a non-video element", () => {
		expect(() =>
			freezeFrameConfigFromCapture({
				element: image,
				sourceTimestampMicros: 0,
				holdDurationMicros: 1_000_000,
				width: 10,
				height: 10,
			}),
		).toThrow(FreezeFrameError);
	});
});

/** Minimal in-memory store: the persistence contract, nothing more. */
function makeStore(seed: MediaAssetData[]) {
	const rows = new Map(seed.map((asset) => [asset.id, asset]));
	const writes: MediaAssetData[] = [];
	const store: FreezeFrameStore = {
		async listMediaAssetData() {
			return [...rows.values()];
		},
		async putMediaAssetData({ data }) {
			rows.set(data.id, data);
			writes.push(data);
		},
	};
	return { store, rows, writes };
}

const stillAsset: MediaAssetData = {
	id: "still-1",
	name: "freeze-500ms.png",
	type: "image",
	size: 0,
	lastModified: 1,
	width: 320,
	height: 240,
	nativeRelativePath: "freeze/freeze-1.png",
};

describe("persistFreezeFrame", () => {
	it("writes the capture record onto the still's persisted metadata", async () => {
		const { store, rows, writes } = makeStore([stillAsset]);
		const config = freezeFrameConfigFromCapture({
			element: video(),
			sourceTimestampMicros: 500_000,
			holdDurationMicros: 1_000_000,
			width: 320,
			height: 240,
		});

		const updated = await persistFreezeFrame({
			store,
			projectId: "proj-1",
			assetId: "still-1",
			config,
		});

		// The write actually happened (not merely reported).
		expect(writes).toHaveLength(1);
		expect(rows.get("still-1")?.freezeFrame).toEqual(config);
		expect(updated.freezeFrame).toEqual(config);
		// Everything else about the asset survives.
		expect(rows.get("still-1")?.nativeRelativePath).toBe("freeze/freeze-1.png");
	});

	it("fails loudly when the still is not registered", async () => {
		const { store, writes } = makeStore([]);
		const error = await persistFreezeFrame({
			store,
			projectId: "proj-1",
			assetId: "missing",
			config: freezeFrameConfigFromCapture({
				element: video(),
				sourceTimestampMicros: 0,
				holdDurationMicros: 1,
				width: 1,
				height: 1,
			}),
		}).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(FreezeFrameError);
		expect((error as FreezeFrameError).code).toBe("ASSET_MISSING");
		expect(writes).toHaveLength(0);
	});

	it("reports a storage failure instead of claiming success", async () => {
		const store: FreezeFrameStore = {
			async listMediaAssetData() {
				return [stillAsset];
			},
			async putMediaAssetData() {
				throw new Error("disk full");
			},
		};
		const error = await persistFreezeFrame({
			store,
			projectId: "proj-1",
			assetId: "still-1",
			config: freezeFrameConfigFromCapture({
				element: video(),
				sourceTimestampMicros: 0,
				holdDurationMicros: 1,
				width: 1,
				height: 1,
			}),
		}).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(FreezeFrameError);
		expect((error as FreezeFrameError).code).toBe("WRITE_FAILED");
	});
});
