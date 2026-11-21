import { describe, expect, test } from "bun:test";
import { buildSrtFromCaptions } from "../srt";
import type { CaptionElement } from "@/timeline/types";
import { mediaTime } from "@/wasm";

function el(partial: Partial<CaptionElement>): CaptionElement {
	return {
		id: "c1",
		name: "cap",
		type: "caption",
		duration: mediaTime({ ticks: 120_000 }),
		startTime: mediaTime({ ticks: 0 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
		words: [{ text: "Hello", startTime: mediaTime({ ticks: 0 }), endTime: mediaTime({ ticks: 60_000 }) }],
		...partial,
	};
}

describe("buildSrtFromCaptions", () => {
	test("serializes a single cue", () => {
		const srt = buildSrtFromCaptions([el({})]);
		expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,000\nHello");
	});

	test("returns empty for no captions", () => {
		expect(buildSrtFromCaptions([])).toBe("");
	});
});