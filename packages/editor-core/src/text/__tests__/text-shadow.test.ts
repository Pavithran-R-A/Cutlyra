/**
 * Text drop-shadow tests.
 *
 * Shadow is drawn by the PREVIEW's canvas code and that same raster is what
 * the native exporters composite (see `export/overlay-frames.ts`), so this
 * file is the whole feature's visual contract test: scoping (`save`/
 * `restore`, so a shadow never leaks onto the fill or background), the
 * percent-of-font-size -> pixels conversion, paint order (shadow behind
 * border and glyphs), and the off switch.
 */
// The recording context is handed to APIs typed against the real Canvas2D
// interface; the double already centralises its single cast in
// `test-support/canvas-double.ts`, and the layout fixture below needs the
// same kind of narrowing for `TextMetrics`.
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import { describe, expect, test } from "bun:test";
import {
	drawTextShadow,
	type MeasuredTextLayout,
	type ResolvedTextShadow,
} from "../primitives";
import { renderTextToContext, TextNode } from "@/services/renderer/nodes/text-node";
import type { ResolvedTextNodeState } from "@/services/renderer/nodes/text-node";
import type { MeasuredTextElement } from "@/text/measure-element";
import { recordingTextContext } from "@/test-support/canvas-double";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function layoutFixture(): MeasuredTextLayout {
	return {
		scaledFontSize: 18,
		fontString: 'normal bold 18px "Arial", sans-serif',
		letterSpacing: 0,
		lineHeightPx: 21.6,
		fontSizeRatio: 1,
		textAlign: "center",
		textDecoration: "none",
		lines: ["Hello", "World"],
		// `drawMeasuredTextLayout` reads `.width` for underline/strike-through
		// geometry even when the decoration is "none".
		lineMetrics: [
			{ width: 40 } as unknown as TextMetrics,
			{ width: 40 } as unknown as TextMetrics,
		],
		block: { visualCenterOffset: 0, height: 43, maxWidth: 40 },
	};
}

const SHADOW: ResolvedTextShadow = {
	color: "#000000",
	blurPx: 4.5,
	offsetXPx: 0.72,
	offsetYPx: 1.08,
};

describe("drawTextShadow", () => {
	test("fills every line with the shadow state active, then restores the context", () => {
		const recording = recordingTextContext();
		drawTextShadow({ ctx: recording.ctx, layout: layoutFixture(), shadow: SHADOW });

		expect(recording.fills.map((fill) => fill.text)).toEqual(["Hello", "World"]);
		for (const fill of recording.fills) {
			expect(fill.shadowBlur).toBe(4.5);
			expect(fill.shadowOffsetX).toBe(0.72);
			expect(fill.shadowOffsetY).toBe(1.08);
		}
		// Second line sits one line-height lower.
		expect(recording.fills[1].y).toBe(21.6);

		// No leak: the caller's fill must not inherit a shadow.
		expect(recording.state.shadowBlur).toBe(0);
		expect(recording.state.shadowOffsetX).toBe(0);
		expect(recording.state.shadowOffsetY).toBe(0);
	});

	test("draws nothing for a zero blur and zero offsets", () => {
		const recording = recordingTextContext();
		drawTextShadow({
			ctx: recording.ctx,
			layout: layoutFixture(),
			shadow: { color: "#000000", blurPx: 0, offsetXPx: 0, offsetYPx: 0 },
		});
		expect(recording.fills).toEqual([]);
	});
});

function textNodeWithResolved({
	shadow,
}: {
	shadow: Pick<
		ResolvedTextNodeState,
		"shadowEnabled" | "shadowColor" | "shadowBlur" | "shadowOffsetX" | "shadowOffsetY"
	>;
}): TextNode {
	const node = new TextNode({
		id: "text-1",
		type: "text",
		name: "Title",
		duration: mediaTime({ ticks: 120_000 }),
		startTime: ZERO_MEDIA_TIME,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { content: "Hello\nWorld" },
		transform: { scaleX: 1, scaleY: 1, position: { x: 0, y: 0 }, rotate: 0 },
		opacity: 1,
		canvasCenter: { x: 540, y: 960 },
		canvasHeight: 1920,
	});

	node.resolved = {
		transform: { scaleX: 1, scaleY: 1, position: { x: 0, y: 0 }, rotate: 0 },
		opacity: 1,
		textColor: "#ffffff",
		backgroundColor: "#000000",
		strokeColor: "#000000",
		strokeWidth: 2,
		...shadow,
		effectPasses: [],
		measuredText: {
			...layoutFixture(),
			resolvedBackground: {
				enabled: false,
				color: "#000000",
				paddingX: 0,
				paddingY: 0,
				offsetX: 0,
				offsetY: 0,
				cornerRadius: 0,
			},
			visualRect: { left: 0, top: 0, width: 40, height: 43 },
		} as MeasuredTextElement,
	};

	return node;
}

describe("renderTextToContext shadow", () => {
	test("shadow is painted first, in pixels converted from percent-of-font-size, and the glyphs paint without it", () => {
		const recording = recordingTextContext();
		renderTextToContext({
			node: textNodeWithResolved({
				shadow: {
					shadowEnabled: true,
					shadowColor: "#000000",
					shadowBlur: 25,
					shadowOffsetX: 4,
					shadowOffsetY: 6,
				},
			}),
			ctx: recording.ctx,
		});

		// One shadow pass per line, then one glyph fill per line.
		expect(recording.fills).toHaveLength(4);
		const [shadowFirst, shadowSecond, glyphFirst, glyphSecond] = recording.fills;
		expect(shadowFirst.shadowBlur).toBeCloseTo(4.5, 5);
		expect(shadowFirst.shadowOffsetX).toBeCloseTo(0.72, 5);
		expect(shadowFirst.shadowOffsetY).toBeCloseTo(1.08, 5);
		expect(shadowSecond.shadowBlur).toBeCloseTo(4.5, 5);

		expect(glyphFirst.shadowBlur).toBe(0);
		expect(glyphFirst.text).toBe("Hello");
		expect(glyphSecond.text).toBe("World");
		// Glyphs are white; the shadow is its own colour.
		expect(glyphFirst.fillStyle).toBe("#ffffff");

		// The border still paints between shadow and fill, and it never
		// carries the shadow.
		expect(recording.strokes).toHaveLength(2);
		expect(recording.strokes.every((stroke) => stroke.shadowBlur === 0)).toBe(true);
	});

	test("a disabled shadow adds no shadow pass at all", () => {
		const recording = recordingTextContext();
		renderTextToContext({
			node: textNodeWithResolved({
				shadow: {
					shadowEnabled: false,
					shadowColor: "#000000",
					shadowBlur: 25,
					shadowOffsetX: 4,
					shadowOffsetY: 6,
				},
			}),
			ctx: recording.ctx,
		});
		expect(recording.fills).toHaveLength(2);
		expect(recording.fills.every((fill) => fill.shadowBlur === 0)).toBe(true);
	});
});
