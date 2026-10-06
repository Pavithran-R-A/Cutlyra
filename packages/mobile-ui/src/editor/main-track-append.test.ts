import { describe, expect, test } from "bun:test";
import { mediaTime, ZERO_MEDIA_TIME } from "@cutlyra/editor-core/wasm";
import { getMainTrackAppendTime } from "./main-track-append";

const t = (ticks: number) => mediaTime({ ticks });

describe("getMainTrackAppendTime", () => {
	test("empty main track appends at zero", () => {
		expect(getMainTrackAppendTime({ elements: [] })).toBe(ZERO_MEDIA_TIME);
	});

	test("appends after the existing main clip instead of the playhead", () => {
		expect(
			getMainTrackAppendTime({
				elements: [{ startTime: t(0), duration: t(12_000) }],
			}),
		).toBe(t(12_000));
	});

	test("multi-clip append uses the furthest end even if the array is stale", () => {
		expect(
			getMainTrackAppendTime({
				elements: [
					{ startTime: t(12_000), duration: t(5_000) },
					{ startTime: t(0), duration: t(12_000) },
				],
			}),
		).toBe(t(17_000));
	});
});
