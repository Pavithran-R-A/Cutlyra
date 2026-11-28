import { describe, expect, test } from "bun:test";
import { buildSrtFromCaptions, buildVttFromCaptions } from "../srt";
import { parseSubtitleText } from "../subtitles";
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

/** Two cues with a gap, multi-word text, and a non-zero start. */
function twoCues(): CaptionElement[] {
	return [
		el({
			id: "c2",
			startTime: mediaTime({ ticks: 240_000 }),
			duration: mediaTime({ ticks: 120_000 }),
			words: [
				{ text: "Second", startTime: mediaTime({ ticks: 0 }), endTime: mediaTime({ ticks: 60_000 }) },
				{ text: "line", startTime: mediaTime({ ticks: 60_000 }), endTime: mediaTime({ ticks: 120_000 }) },
			],
		}),
		el({
			id: "c1",
			words: [
				{ text: "First", startTime: mediaTime({ ticks: 0 }), endTime: mediaTime({ ticks: 60_000 }) },
				{ text: "line", startTime: mediaTime({ ticks: 60_000 }), endTime: mediaTime({ ticks: 120_000 }) },
			],
		}),
	];
}

describe("buildSrtFromCaptions", () => {
	test("serializes a single cue", () => {
		const srt = buildSrtFromCaptions([el({})]);
		expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,000\nHello");
	});

	test("returns empty for no captions", () => {
		expect(buildSrtFromCaptions([])).toBe("");
	});

	test("orders cues by timeline start and skips empty ones", () => {
		const srt = buildSrtFromCaptions([
			...twoCues(),
			el({ id: "empty", words: [] }),
		]);
		expect(srt.indexOf("First line")).toBeLessThan(srt.indexOf("Second line"));
		expect(srt).not.toContain("empty");
	});
});

describe("buildVttFromCaptions", () => {
	test("always emits a WEBVTT header", () => {
		expect(buildVttFromCaptions([])).toBe("WEBVTT\n");
	});

	test("uses VTT timestamps and no numeric cue ids", () => {
		const vtt = buildVttFromCaptions([el({})]);
		expect(vtt.startsWith("WEBVTT\n")).toBe(true);
		expect(vtt).toContain("00:00:00.000 --> 00:00:01.000");
		expect(vtt).toContain("Hello");
		expect(vtt).not.toContain(",000");
	});

	test("orders cues by timeline start", () => {
		const vtt = buildVttFromCaptions(twoCues());
		expect(vtt.indexOf("First line")).toBeLessThan(vtt.indexOf("Second line"));
	});
});

describe("SRT round trip", () => {
	test("export -> parse preserves cue text, order and millisecond timing", () => {
		const source = twoCues();
		const parsed = parseSubtitleText({ input: buildSrtFromCaptions(source) });

		expect(parsed.format).toBe("srt");
		expect(parsed.skippedCueCount).toBe(0);
		expect(parsed.cues.map((cue) => cue.text)).toEqual(["First line", "Second line"]);
		expect(parsed.cues.map((cue) => cue.startMs)).toEqual([0, 2000]);
		expect(parsed.cues.map((cue) => cue.endMs)).toEqual([1000, 3000]);
	});

	test("re-exporting the parsed cues produces the identical document", () => {
		const first = buildSrtFromCaptions(twoCues());
		const parsed = parseSubtitleText({ input: first });
		const rebuilt = buildSrtFromCaptions(
			parsed.cues.map((cue) =>
				el({
					startTime: mediaTime({ ticks: (cue.startMs / 1000) * 120_000 }),
					duration: mediaTime({
						ticks: ((cue.endMs - cue.startMs) / 1000) * 120_000,
					}),
					words: cue.text.split(" ").map((text, index, all) => ({
						text,
						startTime: mediaTime({ ticks: Math.round((index / all.length) * 120_000) }),
						endTime: mediaTime({ ticks: Math.round(((index + 1) / all.length) * 120_000) }),
					})),
				}),
			),
		);
		expect(rebuilt).toBe(first);
	});
});

describe("VTT round trip", () => {
	test("export -> parse preserves cue text, order and millisecond timing", () => {
		const parsed = parseSubtitleText({ input: buildVttFromCaptions(twoCues()) });

		expect(parsed.format).toBe("vtt");
		expect(parsed.skippedCueCount).toBe(0);
		expect(parsed.cues.map((cue) => cue.text)).toEqual(["First line", "Second line"]);
		expect(parsed.cues.map((cue) => cue.startMs)).toEqual([0, 2000]);
		expect(parsed.cues.map((cue) => cue.endMs)).toEqual([1000, 3000]);
	});

	test("a header-only export parses as a valid but empty VTT document", () => {
		const parsed = parseSubtitleText({ input: buildVttFromCaptions([]) });
		expect(parsed.format).toBe("vtt");
		expect(parsed.cues).toHaveLength(0);
		expect(parsed.warnings.length).toBeGreaterThan(0);
	});

	test("tolerates a UTF-8 BOM and CRLF line endings", () => {
		const text = `\uFEFF${buildVttFromCaptions([el({})])}`.replace(/\n/g, "\r\n");
		const parsed = parseSubtitleText({ input: text });
		expect(parsed.format).toBe("vtt");
		expect(parsed.cues[0]?.text).toBe("Hello");
	});
});
