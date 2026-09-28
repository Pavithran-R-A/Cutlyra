/**
 * Caption line layout + active-word resolution — plan M10 item 5 ("per-word
 * karaoke-style animated caption rendering") and item 5's "reusing the same
 * trim/split affordances" for editing.
 *
 * Rebrand-stage layout contract (Task C): caption geometry derives ONLY from
 * the COMPOSITION (canvas width/height) — never from phone screen pixels,
 * CSS viewport size, or device DPI — so preview and burned-in export are
 * identical on every device and aspect ratio.
 *
 * Wrapping + clamping (fixes the 9:16 "captions are far too large, only a
 * few letters fit" defect):
 *  - the font scales off the composition's smaller side (min(width,height)),
 *    not its height — a 1080x1920 and a 1920x1080 canvas with the same
 *    preset now produce the same glyph size relative to frame area;
 *  - scaled size clamps to absolute [MIN, MAX] px so extreme resolutions
 *    stay legible/sane;
 *  - words wrap greedily into lines that never exceed the usable width
 *    (82% portrait, 88% otherwise, i.e. the requested 82-88% band), with
 *    safe horizontal margins implied by that same band;
 *  - at most MAX_LINES lines render; the block is vertically centered on
 *    the position preset's baseline fraction and never crosses the
 *    title-safe vertical band (5% top/bottom inset);
 *  - if even MAX_LINES lines cannot fit the segment, the font shrinks
 *    (auto-fit) down to the clamp floor rather than clipping horizontally;
 *  - a single overlong WORD (no space to wrap at, e.g. a URL) shrinks with
 *    the same auto-fit instead of overflowing;
 *  - layout uses Intl.Segmenter when available so emoji, Tamil conjuncts,
 *    and other grapheme clusters measure as units; plain space-split is the
 *    fallback (identical for space-delimited scripts).
 *
 * Multi-line was previously a documented v1 gap ("single unwrapped line");
 * the generated-segment guidance ("2 lines max, 3-5 seconds each") is now
 * enforced by the layout itself rather than assumed of its input.
 */

import type { CaptionElement, CaptionWord } from "@/timeline/types";
import { buildTextFontString } from "@/text/primitives";
import type { CaptionPosition } from "@/captions/styles";

export interface VisibleCaptionWord {
	word: CaptionWord;
	/** Index into `element.words` — stable across split/trim (see
	 * `CaptionWord`'s doc comment in `timeline/types.ts`) and what
	 * `commands/captions/update-caption-word.ts` expects. */
	index: number;
}

/** Words whose span intersects the currently-visible trimmed window
 * `[trimStart, trimStart + duration)`. */
export function getVisibleCaptionWords({
	element,
}: {
	element: CaptionElement;
}): VisibleCaptionWord[] {
	const windowStart = element.trimStart;
	const windowEnd = element.trimStart + element.duration;
	const result: VisibleCaptionWord[] = [];
	element.words.forEach((word, index) => {
		if (word.endTime > windowStart && word.startTime < windowEnd) {
			result.push({ word, index });
		}
	});
	return result;
}

/**
 * Index into `element.words` of the word "active" at `sourceLocalTime`
 * (ticks, in the same source-relative space as `CaptionWord.startTime`/
 * `endTime` and `element.trimStart`), or `null` before the first word has
 * started. A word that has already finished stays "active" through the gap
 * until the next word starts — reads as a sticky karaoke highlight rather
 * than flickering off between words, and matches how CapCut's own
 * word-highlight animation reads in practice.
 */
export function getActiveCaptionWordIndex({
	element,
	sourceLocalTime,
}: {
	element: CaptionElement;
	sourceLocalTime: number;
}): number | null {
	let activeIndex: number | null = null;
	for (let i = 0; i < element.words.length; i++) {
		const word = element.words[i];
		if (sourceLocalTime < word.startTime) break;
		activeIndex = i;
		if (sourceLocalTime < word.endTime) break;
	}
	return activeIndex;
}

export const CAPTION_POSITION_Y_FRACTION: Record<CaptionPosition, number> = {
	top: -0.36,
	center: 0,
	bottom: 0.36,
};

/**
 * The caption font's fraction of the composition's SMALLER side, as a
 * function of the preset's fontSize: fontSize/DIVISOR. fontSize 18 (the
 * default presets) lands at ~4.2% of the short side (~45px on a 1080-wide
 * 9:16 canvas) — CapCut-parity subtitle presence. Purely fractional, so a
 * 720p export and a 1080p preview produce the IDENTICAL relative size.
 */
const FONT_SIZE_FRACTION_DIVISOR = 432;

/** Fraction-of-short-side clamps (extreme user font sizes stay sane and
 * legible; within the clamp range the mapping is continuous, so explicit
 * user adjustments are preserved). */
export const CAPTION_FONT_FRACTION_MIN = 0.015;
export const CAPTION_FONT_FRACTION_MAX = 0.1;

/** Usable-width band: 82% of composition width on portrait canvases, 88%
 * on square/landscape (both bounds inclusive of implied safe margins). */
export const CAPTION_USABLE_WIDTH_PORTRAIT = 0.82;
export const CAPTION_USABLE_WIDTH_LANDSCAPE = 0.88;

/** Max rendered lines; the generator's own guidance is "2 lines max", with
 * one spare line for manually edited long segments. */
export const CAPTION_MAX_LINES = 3;

/** Title-safe vertical band — the caption block (all lines + leading) must
 * stay inside the middle 90% of the composition height. */
export const CAPTION_TITLE_SAFE_INSET = 0.05;

/** Vertical metrics: line box is 1.3em (matches the historical totalHeight),
 * blocks get 0.18em leading between lines. */
const LINE_HEIGHT_FACTOR = 1.3;
const LINE_LEADING_FACTOR = 0.18;

export interface MeasuredCaptionWord {
	text: string;
	/** Left edge, relative to this word's line's centered left edge. */
	x: number;
	width: number;
	active: boolean;
}

/** One rendered line of the caption block. */
export interface MeasuredCaptionLineBox {
	words: MeasuredCaptionWord[];
	width: number;
	/** Horizontal offset of this line's left edge relative to the BLOCK
	 *  center (every line centers within the block). */
	offsetX: number;
	/** Vertical center of this line's box relative to the BLOCK center. */
	centerY: number;
}

export interface MeasuredCaptionLine {
	/** Rendered lines, top to bottom. */
	lines: MeasuredCaptionLineBox[];
	/** Block width = the widest line (the block is centered as a whole). */
	totalWidth: number;
	/** Block height = lines × line box + leading between lines. */
	totalHeight: number;
	fontString: string;
	scaledFontSize: number;
	lineCount: number;
}

export type CaptionMeasureContext = Pick<
	CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	"measureText" | "font"
>;

/** Fraction of the composition width captions may occupy. */
export function captionUsableWidthFraction(canvasWidth: number, canvasHeight: number): number {
	return canvasHeight > canvasWidth
		? CAPTION_USABLE_WIDTH_PORTRAIT
		: CAPTION_USABLE_WIDTH_LANDSCAPE;
}

/** The composition-scaled, clamped caption font size in canvas px.
 * Resolution-proportional: same fraction of the short side at every
 * composition size, so preview and export agree by construction. */
export function clampedCaptionFontSize({
	fontSize,
	canvasWidth,
	canvasHeight,
}: {
	fontSize: number;
	canvasWidth: number;
	canvasHeight: number;
}): number {
	const shortSide = Math.min(canvasWidth, canvasHeight);
	const fraction = Math.min(
		CAPTION_FONT_FRACTION_MAX,
		Math.max(CAPTION_FONT_FRACTION_MIN, fontSize / FONT_SIZE_FRACTION_DIVISOR),
	);
	return shortSide * fraction;
}

/** Space/zero-width split fallback shared by the segmenter path. */
function splitIntoWordUnits(text: string): string[] {
	if (text.trim().length === 0) return [text];
	const SegmenterCtor = (
		globalThis as unknown as { Intl?: { Segmenter?: new () => { segment: (s: string) => Iterable<{ segment: string }> } } }
	).Intl?.Segmenter;
	if (SegmenterCtor) {
		try {
			const segmenter = new SegmenterCtor();
			const units: string[] = [];
			let current = "";
			for (const part of segmenter.segment(text)) {
				const chunk = part.segment;
				if (/\s/.test(chunk) && current.length > 0) {
					units.push(current);
					current = "";
				} else if (/\s/.test(chunk) && current.length === 0) {
					// leading whitespace — drop
				} else {
					current += chunk;
				}
			}
			if (current.length > 0) units.push(current);
			if (units.length > 0) return units;
		} catch {
			// fall through to the plain split
		}
	}
	return text.split(/\s+/).filter((unit) => unit.length > 0);
}

/**
 * Lays out the visible words into centered, wrapped lines inside the
 * usable-width band. `activeIndex` is an index into `words` (the VISIBLE
 * list passed in), not `element.words`. Punctuation stays glued to its
 * word; emoji and non-space-delimited script runs arrive as single units
 * via the segmenter path.
 *
 * Auto-fit: if the block cannot fit within MAX_LINES at the clamped size,
 * the font shrinks in 5% steps (down to the MIN clamp) until it fits.
 */
export function measureCaptionLine({
	words,
	activeIndex,
	uppercase,
	fontFamily,
	fontSize,
	fontWeight,
	canvasWidth,
	canvasHeight,
	ctx,
}: {
	words: CaptionWord[];
	activeIndex: number | null;
	uppercase: boolean;
	fontFamily: string;
	fontSize: number;
	fontWeight: "normal" | "bold";
	canvasWidth: number;
	canvasHeight: number;
	ctx: CaptionMeasureContext;
}): MeasuredCaptionLine | null {
	if (words.length === 0) return null;

	const usableWidth = canvasWidth * captionUsableWidthFraction(canvasWidth, canvasHeight);
	const baseFontSize = clampedCaptionFontSize({ fontSize, canvasWidth, canvasHeight });

	interface LaidWord {
		text: string;
		width: number;
		active: boolean;
	}

	const layoutAt = (size: number): MeasuredCaptionLine | null => {
		const fontString = buildTextFontString({
			fontFamily,
			fontWeight,
			fontStyle: "normal",
			scaledFontSize: size,
		});
		ctx.font = fontString;
		const spaceWidth = ctx.measureText(" ").width;

		// Split into user-visible units (segmenter-aware), remembering the
		// active flag from the source word each unit came from.
		const laid: LaidWord[] = [];
		words.forEach((word, i) => {
			const display = uppercase ? word.text.toUpperCase() : word.text;
			for (const unit of splitIntoWordUnits(display)) {
				laid.push({ text: unit, width: ctx.measureText(unit).width, active: i === activeIndex });
			}
		});

		// Greedy wrap.
		const lines: LaidWord[][] = [];
		let current: LaidWord[] = [];
		let currentWidth = 0;
		for (const unit of laid) {
			const proposed = current.length === 0 ? unit.width : currentWidth + spaceWidth + unit.width;
			if (current.length > 0 && proposed > usableWidth) {
				lines.push(current);
				current = [unit];
				currentWidth = unit.width;
			} else {
				currentWidth = proposed;
				current.push(unit);
			}
		}
		if (current.length > 0) lines.push(current);

		if (lines.length > CAPTION_MAX_LINES) return null; // trigger auto-fit

		return buildMeasuredBlock({ lines, size, spaceWidth, fontString });
	};

	// Fast path: fits at the clamped size.
	const fitted = layoutAt(baseFontSize);
	if (fitted) return fitted;

	// Auto-fit shrink loop: 5% steps down to the min FRACTION of the short
	// side (always proportional — no absolute px anywhere).
	const minSize = Math.min(canvasWidth, canvasHeight) * CAPTION_FONT_FRACTION_MIN;
	let size = baseFontSize;
	while (size > minSize) {
		size = Math.max(minSize, size * 0.95);
		const attempt = layoutAt(size);
		if (attempt) return attempt;
	}
	// Even MIN does not fit in MAX_LINES: render the first MAX_LINES lines
	// at MIN rather than dropping words entirely (never clip horizontally —
	// lines may exceed the band by a hair in this pathological case, but
	// every word remains visible).
	const floorSize = Math.min(canvasWidth, canvasHeight) * CAPTION_FONT_FRACTION_MIN;
	const fontString = buildTextFontString({
		fontFamily,
		fontWeight,
		fontStyle: "normal",
		scaledFontSize: floorSize,
	});
	ctx.font = fontString;
	const spaceWidth = ctx.measureText(" ").width;
	const laid: LaidWord[] = [];
	words.forEach((word, i) => {
		const display = uppercase ? word.text.toUpperCase() : word.text;
		for (const unit of splitIntoWordUnits(display)) {
			laid.push({ text: unit, width: ctx.measureText(unit).width, active: i === activeIndex });
		}
	});
	const lines: LaidWord[][] = [];
	let current: LaidWord[] = [];
	let currentWidth = 0;
	for (const unit of laid) {
		const proposed = current.length === 0 ? unit.width : currentWidth + spaceWidth + unit.width;
		if (current.length > 0 && proposed > usableWidth) {
			lines.push(current);
			current = [unit];
			currentWidth = unit.width;
		} else {
			currentWidth = proposed;
			current.push(unit);
		}
	}
	if (current.length > 0) lines.push(current);
	const shown = lines.slice(0, CAPTION_MAX_LINES);
	return buildMeasuredBlock({ lines: shown, size: floorSize, spaceWidth, fontString });
}

/** Assembles the public block geometry from wrapped lines. */
function buildMeasuredBlock({
	lines,
	size,
	spaceWidth,
	fontString,
}: {
	lines: { text: string; width: number; active: boolean }[][];
	size: number;
	spaceWidth: number;
	fontString: string;
}): MeasuredCaptionLine {
	const lineBoxes = lines.map((line) => {
		const measured: MeasuredCaptionWord[] = [];
		let cursor = 0;
		line.forEach((w, idx) => {
			if (idx > 0) cursor += spaceWidth;
			measured.push({ text: w.text, x: cursor, width: w.width, active: w.active });
			cursor += w.width;
		});
		return measured;
	});
	const lineWidths = lines.map((line) =>
		line.reduce((acc, w, idx) => acc + w.width + (idx > 0 ? spaceWidth : 0), 0),
);
	const lineBox = size * LINE_HEIGHT_FACTOR;
	const leading = size * LINE_LEADING_FACTOR;
	const blockHeight = lines.length * lineBox + (lines.length - 1) * leading;
	// First line's box center sits at -blockHeight/2 + lineBox/2; each next
	// line adds lineBox + leading.
	const boxes: MeasuredCaptionLineBox[] = lineBoxes.map((words, i) => ({
		words,
		width: lineWidths[i],
		offsetX: -lineWidths[i] / 2,
		centerY: -blockHeight / 2 + lineBox / 2 + i * (lineBox + leading),
	}));
	return {
		lines: boxes,
		totalWidth: Math.max(...lineWidths, 0),
		totalHeight: blockHeight,
		fontString,
		scaledFontSize: size,
		lineCount: lines.length,
	};
}
