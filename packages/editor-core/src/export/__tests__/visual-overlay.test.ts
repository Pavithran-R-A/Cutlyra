/* eslint-disable @typescript-eslint/no-unsafe-type-assertion --
   These tests stand in for browser image objects: the draw plan only needs
   `naturalWidth`/`naturalHeight` and object identity, and building a real
   HTMLImageElement in bun is not possible. Every assertion is about plain
   numbers the production code computes. */
import { describe, expect, test } from "bun:test";
import type { CropRect, FramingMode, Transform } from "@/rendering";
import { StickerNode } from "@/services/renderer/nodes/sticker-node";
import type { ResolvedVisualSourceNodeState } from "@/services/renderer/nodes/visual-node";
import { buildVisualOverlayDrawPlan } from "../visual-overlay";
import { isOverlayRenderTrack } from "../overlay-frames";

const identity: Transform = {
	scaleX: 1,
	scaleY: 1,
	position: { x: 0, y: 0 },
	rotate: 0,
};

function fakeImage({
	naturalWidth = 200,
	naturalHeight = 200,
}: {
	naturalWidth?: number;
	naturalHeight?: number;
} = {}): HTMLImageElement {
	return { naturalWidth, naturalHeight } as unknown as HTMLImageElement;
}

function sticker({
	params = {},
	resolved = {},
}: {
	params?: Partial<{
		framing: FramingMode;
		crop: CropRect;
	}>;
	resolved?: Partial<{
		transform: Transform;
		opacity: number;
		source: HTMLImageElement | null;
		sourceWidth: number;
		sourceHeight: number;
		visible: boolean;
	}>;
} = {}) {
	const node = new StickerNode({
		stickerId: "shapes:star",
		duration: 1000,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 1000,
		transform: identity,
		opacity: 1,
		...params,
	});
	if (resolved.visible !== false) {
		const source = resolved.source === undefined ? fakeImage() : resolved.source;
		node.resolved = {
			localTime: 0,
			transform: resolved.transform ?? identity,
			opacity: resolved.opacity ?? 1,
			effectPasses: [],
			source: source as unknown as CanvasImageSource,
			sourceWidth: resolved.sourceWidth ?? 200,
			sourceHeight: resolved.sourceHeight ?? 200,
		} as ResolvedVisualSourceNodeState;
	}
	return node;
}

function planFor({
	node,
	canvasWidth = 1000,
	canvasHeight = 1000,
}: {
	node: StickerNode;
	canvasWidth?: number;
	canvasHeight?: number;
}) {
	return buildVisualOverlayDrawPlan({ node, canvasWidth, canvasHeight });
}

describe("overlay track selection", () => {
	test("sticker/graphic tracks are rasterized; media and effect tracks are not", () => {
		const tracks = [
			{ type: "graphic", id: "g", name: "Graphics", hidden: false, elements: [] },
			{ type: "text", id: "t", name: "Text", hidden: false, elements: [] },
			{ type: "caption", id: "c", name: "Captions", hidden: false, elements: [] },
			{ type: "video", id: "v", name: "PiP", hidden: false, elements: [] },
			{ type: "effect", id: "e", name: "Effects", hidden: false, elements: [] },
		] as Parameters<typeof isOverlayRenderTrack>[0][];
		expect(tracks.map((track) => [track.type, isOverlayRenderTrack(track)])).toEqual([
			["graphic", true],
			["text", true],
			["caption", true],
			["video", false],
			["effect", false],
		]);
	});
});

describe("visual overlay draw plan (sticker export)", () => {
	test("a fitted sticker covers the canvas and samples the whole image", () => {
		const plan = planFor({ node: sticker() });
		expect(plan).not.toBeNull();
		if (!plan) return;
		expect(plan.centerX).toBe(500);
		expect(plan.centerY).toBe(500);
		expect(plan.width).toBe(1000);
		expect(plan.height).toBe(1000);
		expect(plan.sourceRect).toEqual({
			sourceX: 0,
			sourceY: 0,
			sourceWidth: 200,
			sourceHeight: 200,
		});
		expect(plan.opacity).toBe(1);
	});

	test("position and scale come from the element transform, the same way the preview places it", () => {
		const plan = planFor({
			node: sticker({
				resolved: {
					transform: {
						...identity,
						scaleX: 0.5,
						scaleY: 0.25,
						position: { x: 100, y: -50 },
					},
				},
			}),
		});
		expect(plan).not.toBeNull();
		if (!plan) return;
		expect(plan.centerX).toBe(600);
		expect(plan.centerY).toBe(450);
		expect(plan.width).toBe(500);
		expect(plan.height).toBe(250);
	});

	test("a negative scale flips the sticker, mirroring the preview's quad", () => {
		const plan = planFor({
			node: sticker({
				resolved: { transform: { ...identity, scaleX: -1, rotate: 30 } },
			}),
		});
		expect(plan).not.toBeNull();
		if (!plan) return;
		expect(plan.flipX).toBe(true);
		expect(plan.flipY).toBe(false);
		expect(plan.rotationDegrees).toBe(30);
		expect(plan.width).toBe(1000);
	});

	test("cropping samples the kept sub-rectangle and reframes the quad from it", () => {
		const crop: CropRect = { x: 0, y: 0, width: 0.5, height: 1 };
		const plan = planFor({ node: sticker({ params: { crop } }) });
		expect(plan).not.toBeNull();
		if (!plan) return;
		// Fit of a 100x200 crop into a 1000x1000 canvas: scale 5 → 500x1000.
		expect(plan.width).toBe(500);
		expect(plan.height).toBe(1000);
		expect(plan.sourceRect).toEqual({
			sourceX: 0,
			sourceY: 0,
			sourceWidth: 100,
			sourceHeight: 200,
		});
	});

	test("fill framing uses the cropped source's larger axis", () => {
		const crop: CropRect = { x: 0.25, y: 0, width: 0.5, height: 1 };
		const plan = planFor({ node: sticker({ params: { crop, framing: "fill" } }) });
		expect(plan).not.toBeNull();
		if (!plan) return;
		expect(plan.width).toBe(1000);
		expect(plan.height).toBe(2000);
		expect(plan.sourceRect.sourceX).toBe(50);
		expect(plan.sourceRect.sourceWidth).toBe(100);
	});

	test("draw coordinates use decoded pixels even when the saved intrinsic size differs", () => {
		// Projects store intrinsicWidth/Height at insert time; the browser may
		// decode the same SVG at a different pixel size.
		const plan = planFor({
			node: sticker({ resolved: { sourceWidth: 500, sourceHeight: 500 } }),
		});
		expect(plan).not.toBeNull();
		if (!plan) return;
		expect(plan.width).toBe(1000);
		expect(plan.sourceRect.sourceWidth).toBe(200);
		expect(plan.sourceRect.sourceHeight).toBe(200);
	});

	test("element opacity reaches the canvas draw", () => {
		const plan = planFor({ node: sticker({ resolved: { opacity: 0.4 } }) });
		expect(plan?.opacity).toBe(0.4);
	});

	test("a missing asset or a degenerate source produces no plan instead of throwing", () => {
		expect(buildVisualOverlayDrawPlan({ node: sticker(), canvasWidth: 0, canvasHeight: 0 }))
			.toBeNull();
		expect(planFor({ node: sticker({ resolved: { visible: false } }) })).toBeNull();
		expect(planFor({ node: sticker({ resolved: { source: null } }) })).toBeNull();
		expect(
			planFor({
				node: sticker({ resolved: { source: fakeImage({ naturalWidth: 0, naturalHeight: 0 }) } }),
			}),
		).toBeNull();
	});
});
