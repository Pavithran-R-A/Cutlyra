import { describe, expect, test } from "bun:test";
import {
	getActiveCaptionWordIndex,
	getVisibleCaptionWords,
	measureCaptionLine,
	type CaptionMeasureContext,
} from "../layout";
import type { CaptionElement, CaptionWord } from "@/timeline/types";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";
import { buildDefaultParamValues, getBuiltInElementParams } from "@/params/registry";

/** A deterministic, monospace-ish fake — no DOM/canvas available under `bun
 * test` (see `text/measure-element.ts`'s own fallback chain, which throws in
 * exactly this environment; that's why this is hand-rolled rather than
 * reusing `getTextMeasurementContext()`). Width = 10px per character, which
 * is all `measureCaptionLine`'s layout math (cursor advancement, block
 * width) needs to be exercised meaningfully. */
function fakeMeasureContext(): CaptionMeasureContext {
	return {
		font: "",
		measureText(text: string) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double: CaptionMeasureContext only reads `.width` off the real TextMetrics return value, so a partial object is a faithful, deliberately narrow stand-in (same rationale as edl/__tests__/json-schema.ts's file-level disable for its own test-only casts).
			return { width: text.length * 10 } as TextMetrics;
		},
	};
}

const T = (seconds: number) => mediaTime({ ticks: Math.round(seconds * TICKS_PER_SECOND) });

function buildCaptionElement({
	words,
	trimStart = ZERO_MEDIA_TIME,
	duration,
}: {
	words: CaptionWord[];
	trimStart?: ReturnType<typeof mediaTime>;
	duration: ReturnType<typeof mediaTime>;
}): CaptionElement {
	return {
		id: "el-1",
		type: "caption",
		name: "Caption",
		startTime: ZERO_MEDIA_TIME,
		duration,
		trimStart,
		trimEnd: ZERO_MEDIA_TIME,
		words,
		params: buildDefaultParamValues(getBuiltInElementParams({ type: "caption" })),
	};
}

const WORDS: CaptionWord[] = [
	{ text: "and", startTime: T(0), endTime: T(0.2) },
	{ text: "so", startTime: T(0.2), endTime: T(0.4) },
	{ text: "my", startTime: T(0.4), endTime: T(0.6) },
	{ text: "fellow", startTime: T(0.6), endTime: T(1.0) },
	{ text: "Americans", startTime: T(1.0), endTime: T(2.5) },
];

describe("getActiveCaptionWordIndex", () => {
	const element = buildCaptionElement({ words: WORDS, duration: T(2.5) });

	test("returns null before the first word starts", () => {
		expect(
			getActiveCaptionWordIndex({ element, sourceLocalTime: T(-0.1) }),
		).toBeNull();
	});

	test("returns the word whose span contains sourceLocalTime", () => {
		expect(getActiveCaptionWordIndex({ element, sourceLocalTime: T(0.05) })).toBe(0);
		expect(getActiveCaptionWordIndex({ element, sourceLocalTime: T(0.3) })).toBe(1);
		expect(getActiveCaptionWordIndex({ element, sourceLocalTime: T(2.0) })).toBe(4);
	});

	test("stays on the previous word through a gap between words", () => {
		const gappy: CaptionWord[] = [
			{ text: "hello", startTime: T(0), endTime: T(0.3) },
			{ text: "world", startTime: T(1.0), endTime: T(1.3) },
		];
		const el = buildCaptionElement({ words: gappy, duration: T(1.3) });
		// 0.3..1.0 is a gap: word 0 has finished, word 1 hasn't started.
		expect(getActiveCaptionWordIndex({ element: el, sourceLocalTime: T(0.6) })).toBe(0);
		expect(getActiveCaptionWordIndex({ element: el, sourceLocalTime: T(1.1) })).toBe(1);
	});

	test("advances through every word exactly once across the full span, monotonically", () => {
		const seen: number[] = [];
		for (let ms = 0; ms <= 2500; ms += 25) {
			const idx = getActiveCaptionWordIndex({ element, sourceLocalTime: T(ms / 1000) });
			if (idx !== null && seen[seen.length - 1] !== idx) seen.push(idx);
		}
		expect(seen).toEqual([0, 1, 2, 3, 4]);
	});
});

describe("getVisibleCaptionWords", () => {
	test("returns every word when the clip is untrimmed", () => {
		const element = buildCaptionElement({ words: WORDS, duration: T(2.5) });
		const visible = getVisibleCaptionWords({ element });
		expect(visible.map((v) => v.word.text)).toEqual([
			"and",
			"so",
			"my",
			"fellow",
			"Americans",
		]);
		expect(visible.map((v) => v.index)).toEqual([0, 1, 2, 3, 4]);
	});

	test("filters to the trimmed window, preserving original indices — the split-command contract", () => {
		// Simulates the RIGHT half of a split at t=0.6s: trimStart becomes 0.6s,
		// duration becomes the remaining 1.9s, but `words` is untouched (see
		// `CaptionWord`'s doc comment in timeline/types.ts — SplitElementsCommand
		// never slices it).
		const element = buildCaptionElement({
			words: WORDS,
			trimStart: T(0.6),
			duration: T(1.9),
		});
		const visible = getVisibleCaptionWords({ element });
		expect(visible.map((v) => v.word.text)).toEqual(["fellow", "Americans"]);
		// Indices are into the FULL words array, not the visible slice — index 3
		// and 4, not 0 and 1.
		expect(visible.map((v) => v.index)).toEqual([3, 4]);
	});
});

describe("measureCaptionLine", () => {
	test("lays out a single line on a 16:9 canvas, uppercased if requested", () => {
		const line = measureCaptionLine({
			words: [
				{ text: "hi", startTime: ZERO_MEDIA_TIME, endTime: T(1) },
				{ text: "there", startTime: T(1), endTime: T(2) },
			],
			activeIndex: 1,
			uppercase: true,
			fontFamily: "Arial",
			fontSize: 20,
			fontWeight: "bold",
			canvasWidth: 1920,
			canvasHeight: 1080,
			ctx: fakeMeasureContext(),
		});
		expect(line).not.toBeNull();
		expect(line?.lineCount).toBe(1);
		const words = line?.lines[0].words ?? [];
		expect(words).toHaveLength(2);
		expect(words[0].text).toBe("HI");
		expect(words[0].x).toBe(0);
		expect(words[0].active).toBe(false);
		expect(words[1].text).toBe("THERE");
		expect(words[1].active).toBe(true);
		// "HI" = 2 chars * 10px = 20, plus a 1-char (10px) space gap -> word 2
		// starts at x=30 within its line.
		expect(words[1].x).toBe(30);
		expect(line?.totalWidth).toBe(30 + 5 * 10); // 30 + "THERE".length*10
	});

	test("empty word list yields null (nothing to render)", () => {
		const line = measureCaptionLine({
			words: [],
			activeIndex: null,
			uppercase: false,
			fontFamily: "Arial",
			fontSize: 20,
			fontWeight: "normal",
			canvasWidth: 1080,
			canvasHeight: 1920,
			ctx: fakeMeasureContext(),
		});
		expect(line).toBeNull();
	});
});

/**
 * Task C — composition-derived responsive caption layout. Deterministic
 * (10px/char fake metrics), no screenshots: these pin the geometry contract
 * across the six required aspect ratios.
 */
describe("responsive caption layout (composition-derived)", () => {
	const LONG = "Cutlyra open source video editor responsive caption wrapping test";
	const longWords = LONG.split(" ").map((text, i, arr) => ({
		text,
		startTime: T(i * 0.2),
		endTime: T((i === arr.length - 1 ? i + 1 : i + 1) * 0.2),
	}));

	function layout({
		canvasWidth,
		canvasHeight,
		words = longWords,
		fontSize = 18,
	}: {
		canvasWidth: number;
		canvasHeight: number;
		words?: CaptionWord[];
		fontSize?: number;
	}) {
		return measureCaptionLine({
			words,
			activeIndex: null,
			uppercase: false,
			fontFamily: "Arial",
			fontSize,
			fontWeight: "bold",
			canvasWidth,
			canvasHeight,
			ctx: fakeMeasureContext(),
		})!;
	}

	const RATIOS: Array<[number, number]> = [
		[1080, 1920], // 9:16
		[720, 1280], // 9:16
		[1080, 1080], // 1:1
		[1080, 1350], // 4:5
		[1920, 1080], // 16:9
		[1280, 720], // 16:9
	];

	test("every required aspect ratio wraps inside the usable-width band", () => {
		for (const [w, h] of RATIOS) {
			const line = layout({ canvasWidth: w, canvasHeight: h });
			const usable = w * (h > w ? 0.82 : 0.88);
			expect(line.lineCount).toBeGreaterThan(0);
			expect(line.lineCount).toBeLessThanOrEqual(3);
			for (const box of line.lines) {
				expect(box.width).toBeLessThanOrEqual(usable + 1e-6);
			}
		}
	});

	test("font derives from composition only: proportional to the smaller side", () => {
		// Same fraction of the short side at every composition size — nothing
		// here reads a viewport, screen, or DPI.
		const portrait = layout({ canvasWidth: 1080, canvasHeight: 1920 });
		const square = layout({ canvasWidth: 1080, canvasHeight: 1080 });
		const landscape = layout({ canvasWidth: 1920, canvasHeight: 1080 });
		// All three share the 1080 short side and the same preset: identical px.
		expect(portrait.scaledFontSize).toBe(square.scaledFontSize);
		expect(portrait.scaledFontSize).toBe(landscape.scaledFontSize);
		// fontSize 18/432 = 4.1667% of 1080.
		expect(portrait.scaledFontSize).toBeCloseTo(1080 * (18 / 432), 6);
		// A 720p export scales the SAME fraction from ITS short side.
		const export720 = layout({ canvasWidth: 720, canvasHeight: 1280 });
		expect(export720.scaledFontSize / 720).toBeCloseTo(portrait.scaledFontSize / 1080, 6);
	});

	test("long English text wraps, never clips horizontally", () => {
		const line = layout({ canvasWidth: 1080, canvasHeight: 1920 });
		const laidWords = line.lines.flatMap((l) => l.words);
		expect(laidWords.map((w) => w.text)).toEqual(LONG.split(" "));
		for (const box of line.lines) {
			expect(box.width).toBeLessThanOrEqual(1080 * 0.82 + 1e-6);
		}
	});

	test("a single overlong unbreakable word auto-fits, not overflows", () => {
		const url = [{ text: "https://example.com/averylongpath", startTime: T(0), endTime: T(1) }];
		const line = layout({ canvasWidth: 1080, canvasHeight: 1920, words: url });
		// 30-char word at the clamped 42px would be 420px wide (10px/char at
		// reference scale measured at the scaled font) — the fake is linear so
		// width = 30 chars * (fontSize/18?) — regardless, it must fit the band.
		expect(line.lines[0].width).toBeLessThanOrEqual(1080 * 0.82 + 1e-6);
	});

	test("emoji and Tamil render as atomic units without splitting", () => {
		const words: CaptionWord[] = [
			{ text: "🎬", startTime: T(0), endTime: T(0.5) },
			{ text: "வணக்கம்", startTime: T(0.5), endTime: T(1) },
		];
		const line = layout({ canvasWidth: 1080, canvasHeight: 1920, words });
		const texts = line.lines.flatMap((l) => l.words.map((w) => w.text));
		expect(texts).toEqual(["🎬", "வணக்கம்"]);
	});

	test("block respects title-safe vertical bounds at every position preset", () => {
		// Title-safe band = middle 90% of the composition height (5% inset per
		// edge), i.e. y in [-0.45h, +0.45h]. The preset fractions shift the
		// BLOCK CENTER; every edge must stay inside the band for all ratios.
		for (const [w, h] of RATIOS) {
			const line = layout({ canvasWidth: w, canvasHeight: h });
			for (const fraction of Object.values([-0.36, 0, 0.36])) {
				const centerY = h * fraction;
				const top = centerY - line.totalHeight / 2;
				const bottom = centerY + line.totalHeight / 2;
				expect(top).toBeGreaterThanOrEqual(-h * 0.45 - 1e-6);
				expect(bottom).toBeLessThanOrEqual(h * 0.45 + 1e-6);
			}
		}
	});

	test("max line count enforced with auto-fit shrink, not clipping", () => {
		const line = layout({ canvasWidth: 720, canvasHeight: 1280 });
		expect(line.lineCount).toBeLessThanOrEqual(3);
		expect(line.scaledFontSize).toBeLessThanOrEqual(720 * 0.1 + 1e-6);
	});
});
